/**
 * zip.js - 零依赖 ZIP 打包与解包工具（配合 Node 内置 zlib）
 * - ZipWriter：流式写入 ZIP（deflate 压缩、数据描述符、UTF-8 中文文件名）
 * - parseZip：解析 ZIP 缓冲区（支持 store 与 deflate 条目）
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

/** ZIP 条目必须是相对 POSIX 路径，拒绝绝对路径、盘符、点段、控制字符和 Windows 特殊名称。 */
function validEntryName(name) {
  const raw = String(name || '');
  if (!raw || Buffer.byteLength(raw, 'utf8') > 0xffff || /[\x00-\x1f\x7f]/.test(raw)) return false;
  if (raw.includes('\\')) return false;
  // 同时拒绝 POSIX 绝对路径和 Windows 驱动器路径（包括 C:foo 这种 drive-relative 形式）。
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return false;
  const parts = raw.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part && i !== parts.length - 1) return false;
    if (!part) continue; // 仅允许目录条目末尾的一个 /。
    if (part === '.' || part === '..' || /[.]$|[ ]$/.test(part)) return false;
    if (part.includes(':')) return false; // 防止 Windows NTFS Alternate Data Streams。
    if (/^(con|prn|aux|nul|clock\$|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part)) return false;
  }
  return true;
}

/* ---------------- CRC32 ---------------- */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
/** 流式 CRC32 计算器 */
class Crc32 {
  constructor() { this.c = 0xFFFFFFFF; }
  update(buf) {
    const t = crcTable();
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    this.c = c;
  }
  value() { return (this.c ^ 0xFFFFFFFF) >>> 0; }
}

/** DOS 时间格式（ZIP 规范，年份从 1980 起） */
function dosDateTime(d) {
  d = d || new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/* ---------------- ZIP 流式写入器 ---------------- */
/**
 * 用法：
 *   const zip = new ZipWriter(res);
 *   res.writeHead(200, {...});
 *   await zip.addFile('a.txt', { buffer: Buffer.from('hi') });
 *   await zip.addFile('dir/b.png', { path: '/path/b.png' });
 *   zip.finish(); // 写入中央目录并 out.end()
 *
 * 说明：使用数据描述符（general purpose bit 3），因此无需预先知道压缩后大小，
 * 可边读边写；文件名置 UTF-8 标志位（bit 11），兼容中文。
 */
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;

class ZipWriter {
  constructor(out) {
    this.out = out;          // 可写流（HTTP response 或文件流）
    this.central = [];       // 中央目录条目
    this.entryNames = new Set(); // 生成端也拒绝重复条目，避免解压时覆盖文件
    this.offset = 0;         // 当前写入位置
    this.chain = Promise.resolve(); // 内部串行队列：条目必须顺序写入，不可交叉
    this.failed = null;
  }
  _writeRaw(buf) {
    if (!buf || buf.length > ZIP_UINT32_MAX - this.offset) {
      throw new Error('zip size exceeds 32-bit limit');
    }
    this.offset += buf.length;
    return this.out.write(buf);
  }
  /**
   * 中断打包（客户端断开时调用）：终止当前压缩、销毁输出流，
   * 后续 addFile 立即拒绝，避免挂起的 Promise 泄漏。
   */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    try { if (this._input) this._input.destroy(); } catch (e) { /* ignore */ }
    try { if (this._deflater) this._deflater.destroy(); } catch (e) { /* ignore */ }
    try { this.out.destroy(); } catch (e) { /* ignore */ }
  }
  /**
   * 添加一个文件条目，返回 Promise。
   * 内部自动串行化：即使调用方并发调用，条目也会按顺序完整写入。
   * @param {string} name 条目名（目录用 / 分隔）
   * @param {{path?:string, buffer?:Buffer}} src 文件来源（二选一）
   */
  addFile(name, src) {
    if (this.aborted) return Promise.reject(new Error('zip aborted'));
    const result = this.chain.then(() => this._addFile(name, src));
    this.chain = result.catch(() => {}); // 出错不中断后续排队
    return result;
  }
  _addFile(name, src) {
    if (this.aborted || this.finished) return Promise.reject(new Error('zip is not writable'));
    const rawName = String(name || '');
    if (!validEntryName(rawName)) return Promise.reject(new Error('invalid zip entry name'));
    if (this.entryNames.has(rawName)) return Promise.reject(new Error('duplicate zip entry name'));
    if (this.central.length >= ZIP_UINT16_MAX) return Promise.reject(new Error('too many zip entries'));
    const nameBuf = Buffer.from(rawName, 'utf8');
    const { time, date } = dosDateTime();
    const offset = this.offset;
    this.entryNames.add(rawName);

    // local file header：crc/大小先填 0，用数据描述符补
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0808, 6);    // bit3 数据描述符 | bit11 UTF-8 文件名
    lh.writeUInt16LE(8, 8);         // 压缩方法：deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(0, 14);        // crc32（后补）
    lh.writeUInt32LE(0, 18);        // 压缩大小（后补）
    lh.writeUInt32LE(0, 22);        // 原始大小（后补）
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);        // extra len
    try {
      this._writeRaw(lh);
      this._writeRaw(nameBuf);
    } catch (e) {
      this.entryNames.delete(rawName);
      return Promise.reject(e);
    }

    const self = this;
    return new Promise((resolve, reject) => {
      const crc = new Crc32();
      let csize = 0, usize = 0, settled = false;
      let input = null;
      const deflater = zlib.createDeflateRaw({ level: 6 });
      self._deflater = deflater;
      const fail = err => {
        if (settled) return;
        settled = true;
        try { if (input) input.destroy(); } catch (e) { /* ignore */ }
        try { deflater.destroy(); } catch (e) { /* ignore */ }
        // ZIP 输出一旦出现条目错误就整体中止，不能继续输出缺少中央目录项的半损坏包。
        self.abort();
        reject(err instanceof Error ? err : new Error('zip stream failed'));
      };
      deflater.on('data', d => {
        if (settled) return;
        try {
          csize += d.length;
          if (csize > ZIP_UINT32_MAX) return fail(new Error('compressed entry exceeds 32-bit limit'));
          // 背压：输出缓冲区满时暂停压缩，drain 后继续
          const ok = self._writeRaw(d);
          if (!ok && !self.out.destroyed) {
            deflater.pause();
            self.out.once('drain', () => { if (!settled && !self.out.destroyed) deflater.resume(); });
          }
        } catch (e) { fail(e); }
      });
      deflater.on('end', () => {
        self._deflater = null;
        if (settled) return;
        try {
          if (usize > ZIP_UINT32_MAX || csize > ZIP_UINT32_MAX) throw new Error('zip entry exceeds 32-bit limit');
          const dd = Buffer.alloc(16); // 数据描述符
          dd.writeUInt32LE(0x08074b50, 0);
          dd.writeUInt32LE(crc.value(), 4);
          dd.writeUInt32LE(csize, 8);
          dd.writeUInt32LE(usize, 12);
          self._writeRaw(dd);
          self.central.push({
            nameBuf, crc: crc.value(), csize, usize,
            time, date, offset
          });
          settled = true;
          resolve();
        } catch (e) { fail(e); }
      });
      deflater.on('error', fail);
      deflater.on('close', () => { if (!settled) fail(new Error('zip stream closed')); });

      try {
        if (src && Buffer.isBuffer(src.buffer)) {
          usize = src.buffer.length;
          crc.update(src.buffer);
          deflater.end(src.buffer);
          return;
        }
        if (!src || typeof src.path !== 'string' || !src.path) throw new Error('invalid zip source');
        input = fs.createReadStream(src.path);
        self._input = input;
        input.on('data', d => {
          if (settled) return;
          usize += d.length;
          if (usize > ZIP_UINT32_MAX) return fail(new Error('entry exceeds 32-bit limit'));
          crc.update(d);
        });
        input.on('error', fail);
        input.on('close', () => { if (self._input === input) self._input = null; });
        input.pipe(deflater);
      } catch (e) { fail(e); }
    });
  }
  /** 写入中央目录与结束标记，并关闭输出流 */
  finish() {
    if (this.aborted || this.finished) return;
    try {
      const start = this.offset;
      for (const e of this.central) {
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);            // version made by
        cd.writeUInt16LE(20, 6);            // version needed
        cd.writeUInt16LE(0x0808, 8);        // flags（与 local header 一致）
        cd.writeUInt16LE(8, 10);            // method
        cd.writeUInt16LE(e.time, 12);
        cd.writeUInt16LE(e.date, 14);
        cd.writeUInt32LE(e.crc, 16);
        cd.writeUInt32LE(e.csize, 20);
        cd.writeUInt32LE(e.usize, 24);
        cd.writeUInt16LE(e.nameBuf.length, 28);
        // extra/comment/disk/attrs 均为 0
        cd.writeUInt32LE(e.offset, 42);
        this._writeRaw(cd);
        this._writeRaw(e.nameBuf);
      }
      const cdSize = this.offset - start;
      if (start > ZIP_UINT32_MAX || cdSize > ZIP_UINT32_MAX) throw new Error('zip central directory exceeds 32-bit limit');
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(this.central.length, 8);
      eocd.writeUInt16LE(this.central.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(start, 16);
      this._writeRaw(eocd);
      this.finished = true;
      this.out.end();
    } catch (e) {
      this.abort();
      throw e;
    }
  }
}

/* ---------------- ZIP 解析（内存缓冲区） ---------------- */
/**
 * 解析 ZIP 缓冲区，返回 [{ name, content:Buffer }]；失败返回 null。
 * 仅支持 store(0) 与 deflate(8) 条目，足够处理本系统生成的备份。
 * @param {Buffer} buf
 * @param {{maxEntries?:number, maxEntrySize?:number, maxTotalSize?:number}} opts 安全上限
 */
function parseZip(buf, opts = {}) {
  const maxEntries = opts.maxEntries || 20000;
  const maxEntrySize = opts.maxEntrySize || 250 * 1024 * 1024;
  const maxTotalSize = opts.maxTotalSize || 1024 * 1024 * 1024;
  try {
    if (!buf || buf.length < 22) return null;
    // 从尾部扫描 EOCD（注释最长 64K，限制扫描范围）
    let eocd = -1;
    const scanStart = Math.max(0, buf.length - 22 - 65536);
    for (let i = buf.length - 22; i >= scanStart; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const commentLen = buf.readUInt16LE(eocd + 20);
    // 仅支持单磁盘 ZIP；校验中央目录和 EOCD 的边界，拒绝拼接/截断结构。
    if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) return null;
    if (commentLen !== buf.length - eocd - 22) return null;
    if (count > maxEntries || cdOffset > eocd || cdSize > eocd - cdOffset) return null;
    if (cdOffset + cdSize !== eocd) return null;

    const entries = [];
    const entryNames = new Set();
    let totalSize = 0;
    let off = cdOffset;
    for (let i = 0; i < count; i++) {
      if (off > eocd - 46 || buf.readUInt32LE(off) !== 0x02014b50) return null;
      const method = buf.readUInt16LE(off + 10);
      const crcExpected = buf.readUInt32LE(off + 16);
      const csize = buf.readUInt32LE(off + 20);
      const usize = buf.readUInt32LE(off + 24);
      const nlen = buf.readUInt16LE(off + 28);
      const elen = buf.readUInt16LE(off + 30);
      const clen = buf.readUInt16LE(off + 32);
      const lhOff = buf.readUInt32LE(off + 42);
      const next = off + 46 + nlen + elen + clen;
      if (next < off || next > eocd) return null;
      const name = buf.toString('utf8', off + 46, off + 46 + nlen);
      off = next;

      // 目录条目也必须经过路径校验；否则恶意的 ../ 目录名会在跳过前绕过检查。
      if (!validEntryName(name) || entryNames.has(name)) return null;
      entryNames.add(name);
      if (name.endsWith('/')) continue;              // 目录条目跳过
      if (usize > maxEntrySize || csize > buf.length) return null;
      totalSize += usize;
      if (totalSize > maxTotalSize) return null;     // 解压总量超限（防 zip bomb 耗尽内存）
      if (lhOff > buf.length - 30 || buf.readUInt32LE(lhOff) !== 0x04034b50) return null;
      const lhn = buf.readUInt16LE(lhOff + 26);
      const lhe = buf.readUInt16LE(lhOff + 28);
      const dataOff = lhOff + 30 + lhn + lhe;
      if (dataOff < lhOff || dataOff > buf.length || csize > buf.length - dataOff) return null;

      const data = buf.subarray(dataOff, dataOff + csize);
      let content;
      if (method === 0) content = Buffer.from(data);
      else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: usize + 1024 });
      else return null;                              // 其他压缩方法不支持
      if (content.length !== usize) return null;
      const crc = new Crc32();
      crc.update(content);
      if (crc.value() !== crcExpected) return null;
      entries.push({ name, content });
      if (entries.length > maxEntries) return null;
    }
    if (off !== eocd) return null;
    return entries;
  } catch (e) { return null; }
}

module.exports = { ZipWriter, parseZip, Crc32, validEntryName };

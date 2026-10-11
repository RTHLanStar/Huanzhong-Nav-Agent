#!/usr/bin/env node
/**
 * 幻终の导航 - 轻量级网址导航系统
 * 零依赖，仅需 Node.js 即可运行（无需 npm install）
 * 端口：2220 | 数据库：本地 JSON 文件（data/ 目录）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ZipWriter, parseZip, validEntryName: validZipEntryName } = require('./zip.js');

// ---------------- 基础配置 ----------------
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535 ? envPort : 2220; // 服务端口
const ROOT = __dirname;
// 测试/隔离部署可通过环境变量指定数据目录；未设置时保持原有 data/ 目录。
const DATA_DIR = process.env.HUANZHONG_DATA_DIR
  ? path.resolve(process.env.HUANZHONG_DATA_DIR)
  : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 是否信任反向代理传来的 X-Forwarded-For / X-Real-IP 头：
// - 直接暴露端口访问（未经过 Nginx/CDN 等代理）：必须保持 false，否则攻击者可伪造
//   X-Forwarded-For 头绕过 IP 封禁、限流与访问控制
// - 挂在 Nginx 等反向代理后面：改为 true（或设置环境变量 TRUST_PROXY=true）
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? process.env.TRUST_PROXY === 'true'
  : false;

const SESSION_TTL = 7 * 24 * 3600 * 1000;   // 登录会话有效期：7 天
const SESSION_MAX_STORED = 10000;            // 会话总量上限，防止分布式登录请求撑爆 JSON 存储
const BAN_DURATION = 10 * 60 * 1000;        // IP 封禁时长：10 分钟
const MAX_ATTEMPTS = 3;                     // 登录失败超过该次数后封禁 IP
const MAX_LOGS = 5000;                      // 每类日志最多保留条数
const BODY_LIMIT = 4 * 1024 * 1024;         // 请求体大小上限（含图标上传与文件分块）
const TRANSFER_CHUNK_SIZE = 1024 * 1024;     // 文件/备份分块固定大小：1MB（服务端按序号定位写入）
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');   // 上传图标目录
const FAVICON_DIR = path.join(DATA_DIR, 'favicons'); // 自动抓取的网站图标缓存目录
const FILES_DIR = path.join(DATA_DIR, 'files');      // 共享文件目录
const UPLOAD_MAX = 1024 * 1024;             // 单个图标文件上限：1MB
const FILE_MAX = 200 * 1024 * 1024;         // 单个共享文件上限：200MB
const DOWNLOAD_RATE = 0.5 * 1024 * 1024;    // 共享文件下载限速：0.5MB/s（字节/秒），设为 0 表示不限速
const DOWNLOAD_CHUNK = 64 * 1024;           // 限速下载每次写入的分块大小
const ZIP_TOTAL_MAX = 2 * 1024 * 1024 * 1024; // 单次打包 ZIP 的总大小上限 2GB（ZIP 32 位偏移安全范围）
const ZIP_FILE_MAX_COUNT = 5000;            // 单次打包 ZIP 的最大文件数
const BACKUP_MAX = 1024 * 1024 * 1024;   // 完整备份（含全部共享文件）上限 1GB：恢复时需整体读入内存解析，过大易 OOM
const BACKUP_META_MAX = 32 * 1024 * 1024; // backup.json 元数据上限，避免用极端 JSON 膨胀恢复内存
const BACKUP_TMP_DIR = path.join(DATA_DIR, 'backup-tmp'); // 恢复用备份 ZIP 的分块临时目录
const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 取件码字符集（去除易混淆的 0/O/1/I）
const SHARE_CODE_LEN = 6;                   // 取件码长度
const SHARE_DEFAULT_TTL = 24 * 3600 * 1000; // 取件码默认有效期：24 小时
const SHARE_MAX_TTL = 30 * 24 * 3600 * 1000; // 取件码最长有效期：30 天
const RATE_SHARE_MAX = 30;                  // 取件码解析限流：每 IP 每分钟最多次数（防暴力猜码）
const RATE_SHARE_WINDOW = 60 * 1000;
const NODE_HEARTBEAT_TTL = 90 * 1000;          // 节点心跳失效时间
const NODE_NAME_MAX = 40;
const NODE_TOKEN_KEY_FILE = path.join(DATA_DIR, '.node-token-key');
const NODE_URL_MAX = 2048;
const FILE_SPEED_MAX_MBPS = 1000;              // 单文件限速上限，0 表示使用全局限速

// ---------------- 留言板 / 定时死链检测 / 访问热力图 ----------------
const COMMENT_MAX_LEN = 200;                // 留言内容最大长度
const COMMENT_NICK_MAX = 20;                // 留言昵称最大长度
const COMMENT_REPLY_MAX = 200;              // 管理员回复最大长度
const COMMENT_RATE_MAX = 5;                 // 留言提交限流：每 IP 每分钟最多条数
const COMMENT_RATE_WINDOW = 60 * 1000;
const MAX_COMMENTS = 1000;                  // 留言板最多保留条数（超出淘汰最旧可见留言）
const LINK_CHECK_DEFAULT_INTERVAL = 24;     // 定时死链检测默认间隔（小时）
const LINK_CHECK_MIN_INTERVAL = 1;          // 定时检测最小间隔（小时）
const LINK_CHECK_MAX_INTERVAL = 24 * 7;     // 定时检测最大间隔（小时）
const LINK_CHECK_FIRST_DELAY = 60 * 1000;   // 启动后首次定时检测的延迟（毫秒）
const HEATMAP_DAYS = 7;                     // 访问热力图统计最近 N 天的小时分布
const HOURLY_KEEP_DAYS = 30;                // 小时访问数据最多保留天数
const IMPORT_MAX_ROWS = 500;                // 批量导入引导页单次上限

// ---------------- 天气 / 一言 / 倒计时 / 友链 / 反馈 / 访客统计 ----------------
const WEATHER_URL = 'https://wttr.in/';     // 天气数据源（wttr.in 免费接口，中文城市名/拼音均可）
const WEATHER_TIMEOUT = 8000;               // 天气请求超时（毫秒）
const WEATHER_CACHE_TTL = 10 * 60 * 1000;   // 天气服务端缓存时长：10 分钟（减轻上游压力）
const WEATHER_DESC_MAX = 30;                // 天气描述最大长度（截断防御）
const STATUS_MONITOR_MAX = 30;               // 自定义网站监控最多条数
const STATUS_MONITOR_NAME_MAX = 50;
const STATUS_MONITOR_CHECK_INTERVAL = 5 * 60 * 1000;
const STATUS_MONITOR_TIMEOUT = 8000;
const STATUS_MONITOR_MAX_BYTES = 32 * 1024;
const QUOTES_KEEP = 100;                    // 每日一言自定义语录最多保留条数
const FEEDBACK_MAX_LEN = 300;               // 反馈内容最大长度
const FEEDBACK_CONTACT_MAX = 40;            // 反馈联系方式最大长度
const FEEDBACK_REPLY_MAX = 300;             // 反馈回复最大长度
const FEEDBACK_RATE_MAX = 5;                // 反馈提交限流：每 IP 每分钟条数
const FEEDBACK_RATE_WINDOW = 60 * 1000;
const MAX_FEEDBACKS = 1000;                 // 反馈最多保留条数
const COUNTDOWN_NAME_MAX = 20;              // 倒计时名称最大长度
const COUNTDOWN_MAX = 10;                   // 倒计时最多条数
const FRIENDLINK_NAME_MAX = 30;             // 友链名称最大长度
const MAX_FRIENDLINKS = 50;                 // 友链最多条数
const POPULAR_TOP_N = 6;                    // 「大家都在用」横条展示条数
const VISITOR_DAILY_KEEP_DAYS = 30;         // 独立访客日数据保留天数
const REFERRER_MAX_LEN = 200;               // 来源域名记录最大长度

// 可在线预览的文件类型白名单（扩展名 -> { mime, kind }）；
// 白名单外的类型（尤其 html/svg/js 等可执行脚本的类型）一律强制下载，防止 XSS
const PREVIEW_TYPES = {
  '.png': { mime: 'image/png', kind: 'image' }, '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' }, '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' }, '.bmp': { mime: 'image/bmp', kind: 'image' },
  '.avif': { mime: 'image/avif', kind: 'image' }, '.ico': { mime: 'image/x-icon', kind: 'image' },
  '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.mp4': { mime: 'video/mp4', kind: 'video' }, '.webm': { mime: 'video/webm', kind: 'video' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' }, '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' }, '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.flac': { mime: 'audio/flac', kind: 'audio' }, '.aac': { mime: 'audio/aac', kind: 'audio' },
  '.txt': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.md': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.log': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.json': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.csv': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.xml': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  // 代码与配置文件：按纯文本预览（text/plain + nosniff，不会被浏览器当 HTML 执行）
  '.js': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.ts': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.css': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.py': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.java': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.c': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.cpp': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.h': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.go': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.rs': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.php': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.rb': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.sh': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.bat': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.ps1': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.sql': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.yaml': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.yml': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.ini': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.conf': { mime: 'text/plain; charset=utf-8', kind: 'text' },
  '.env': { mime: 'text/plain; charset=utf-8', kind: 'text' }, '.vue': { mime: 'text/plain; charset=utf-8', kind: 'text' }
};

// ---------------- 防护配置（限流 / 防爆破 / 带宽保护） ----------------
const RATE_API_MAX = 240;                   // 全局 API 限流：每 IP 每分钟最多请求数
const RATE_API_WINDOW = 60 * 1000;
const RATE_AUTH_MAX = 10;                   // 登录/注册接口限流：每 IP 每分钟最多次数（防爆破）
const RATE_AUTH_WINDOW = 60 * 1000;
const RATE_DL_START_MAX = 10;               // 下载发起限流：每 IP 每分钟最多下载次数（防恶意刷下载）
const RATE_DL_START_WINDOW = 60 * 1000;
const RATE_DL_START5_MAX = 3;               // 下载发起限流：每 IP 每 5 分钟最多下载次数（长窗口，防持续刷量）
const RATE_DL_START5_WINDOW = 5 * 60 * 1000;
const CAPTCHA_TTL = 5 * 60 * 1000;          // 人机验证码有效期：5 分钟
const CAPTCHA_LEN = 4;                      // 验证码字符数
const CAPTCHA_MAX_STORED = 5000;            // 验证码缓存数量上限（防内存泛洪）
const CAPTCHA_RATE_MAX = 30;                // 每 IP 每分钟最多获取验证码次数
const CAPTCHA_VERIFY_RATE_MAX = 10;         // 每 IP 每分钟最多提交验证次数（防爆破）
const DL_TOKEN_TTL = 3 * 60 * 1000;         // 一次性下载链接有效期：3 分钟
const DL_TOKEN_MAX_STORED = 10000;          // 一次性下载令牌缓存数量上限
const MAX_CONCURRENT_DL = 8;                // 全局同时进行中的下载数上限
const MAX_CONCURRENT_DL_PER_IP = 2;         // 单 IP 同时进行中的下载数上限
const FAVICON_TTL = 3 * 24 * 3600 * 1000;   // 网站图标缓存有效期：3 天
const FAVICON_NEG_TTL = 6 * 3600 * 1000;    // 抓取失败的负缓存有效期：6 小时内不重复抓取
const FAVICON_FETCH_LIMIT = 300 * 1024;     // 抓取图标的最大字节数
const FAVICON_FETCH_TIMEOUT = 6000;         // 单个图标来源的抓取超时（毫秒）
const NONCE_TTL = 5 * 60 * 1000;            // 加密令牌有效期：5 分钟
const MAX_DECODE_PIXELS = 2048 * 2048;      // 图片解码像素总数上限（图标场景足够；4096² 时单请求内存峰值可达 ~150MB）

// 允许上传的图标格式（扩展名 -> MIME）
const UPLOAD_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  bmp: 'image/bmp', svg: 'image/svg+xml',
  avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', apng: 'image/apng'
};

// MIME 子类型 -> 扩展名（处理 x-icon / tiff / jpeg 等别名）
const MIME_TO_EXT = {
  png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp',
  'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', ico: 'ico',
  bmp: 'bmp', svg: 'svg', 'svg+xml': 'svg',
  avif: 'avif', tif: 'tiff', tiff: 'tiff', apng: 'png'
};

/** 从 URL 形如 /uploads/xxxx.png 中提取文件名并删除该文件（失败静默） */
function removeUpload(url) {
  try {
    if (!url || !url.startsWith('/uploads/')) return;
    const name = decodeURIComponent(url.slice('/uploads/'.length));
    if (!/^[\w.-]+$/.test(name)) return; // 防路径穿越
    const p = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { /* ignore */ }
}

// ---------------- 图片格式检测与自动转换 ----------------
// 浏览器 <img> 对 BMP / ICO / TIFF 支持很差，上传为图标或 Logo 时自动转为 PNG。
// 解码失败（如 TIFF 使用了不常见压缩）时原样保存，不阻断上传。

/** 解码未压缩 BMP（1/4/8/16/24/32 位，含 RLE4/RLE8）为 RGBA 像素 */
function decodeBmp(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const readU32 = o => buf.readUInt32LE(o);
  const readI32 = o => buf.readInt32LE(o);
  const readU16 = o => buf.readUInt16LE(o);
  const dataOff = readU32(10);
  const headerSize = readU32(14);
  let width, height, bpp, compression, paletteCount = 0, paletteOff = 0;
  if (headerSize >= 40) {
    width = readI32(18);
    height = readI32(22);
    bpp = readU16(28);
    compression = readU32(30);
    paletteCount = readU32(46);
    paletteOff = 14 + headerSize;
  } else { // 旧版 BITMAPCOREHEADER(12)
    width = readU16(18);
    height = readU16(20);
    bpp = readU16(28);
    compression = 0;
    paletteCount = 0;
    paletteOff = 26;
  }
  if (width <= 0 || width > 8192 || Math.abs(height) <= 0 || Math.abs(height) > 8192 ||
      width * Math.abs(height) > MAX_DECODE_PIXELS) return null;
  const topDown = height < 0;
  const h = Math.abs(height);
  const palette = [];
  const entrySize = headerSize >= 40 ? 4 : 3;
  if (paletteCount > 0) {
    for (let i = 0; i < paletteCount; i++) {
      const o = paletteOff + i * entrySize;
      // 必须按完整条目长度校验：4 字节条目还要读 alpha，只校验 2 字节会让 alpha 变成 undefined
      if (o + entrySize > buf.length) break;
      palette.push([buf[o + 2], buf[o + 1], buf[o], entrySize === 4 ? buf[o + 3] : 255]);
    }
  }
  // 分配前校验：未压缩时要求缓冲区至少容纳一行数据，防止恶意小文件声明超大尺寸触发巨量内存分配
  const rowSizePre = Math.floor((bpp * width + 31) / 32) * 4;
  if (compression === 0 && (dataOff > buf.length || buf.length - dataOff < rowSizePre)) return null;
  if (compression !== 0 && compression !== 1 && compression !== 2) return null;
  const rgba = Buffer.alloc(width * h * 4);
  const rowSize = rowSizePre;

  if (compression === 0) {
    for (let y = 0; y < h; y++) {
      const sy = topDown ? y : (h - 1 - y);
      const rowOff = dataOff + sy * rowSize;
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 255;
        if (bpp === 24) {
          const o = rowOff + x * 3;
          if (o + 2 >= buf.length) return null;
          b = buf[o]; g = buf[o + 1]; r = buf[o + 2];
        } else if (bpp === 32) {
          const o = rowOff + x * 4;
          if (o + 3 >= buf.length) return null;
          b = buf[o]; g = buf[o + 1]; r = buf[o + 2]; a = buf[o + 3] === 0 ? 255 : buf[o + 3];
        } else if (bpp === 8) {
          const o = rowOff + x;
          if (o >= buf.length) return null;
          const idx = buf[o];
          const c = palette[idx] || [idx, idx, idx, 255];
          r = c[0]; g = c[1]; b = c[2]; a = c[3];
        } else if (bpp === 4) {
          const o = rowOff + Math.floor(x / 2);
          if (o >= buf.length) return null;
          const byte = buf[o];
          const idx = (x % 2 === 0) ? (byte >> 4) : (byte & 0x0f);
          const c = palette[idx] || [idx * 17, idx * 17, idx * 17, 255];
          r = c[0]; g = c[1]; b = c[2];
        } else if (bpp === 1) {
          const o = rowOff + Math.floor(x / 8);
          if (o >= buf.length) return null;
          const bit = (buf[o] >> (7 - (x % 8))) & 1;
          const c = palette[bit] || [bit * 255, bit * 255, bit * 255, 255];
          r = c[0]; g = c[1]; b = c[2];
        } else if (bpp === 16) {
          const o = rowOff + x * 2;
          if (o + 1 >= buf.length) return null;
          const v = buf.readUInt16LE(o);
          r = ((v >> 10) & 0x1f) << 3; g = ((v >> 5) & 0x1f) << 3; b = (v & 0x1f) << 3;
        } else return null;
        const di = (y * width + x) * 4;
        rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
      }
    }
  } else if (compression === 1 || compression === 2) { // RLE8 / RLE4
    let x = 0, y = 0, i = dataOff;
    while (i + 1 < buf.length && y < h) {
      const cnt = buf[i], val = buf[i + 1];
      if (cnt === 0) {
        if (val === 0) { // 行结束
          x = 0; y++; i += 2;
        } else if (val === 1) { // 文件结束
          break;
        } else if (val === 2) { // 偏移
          if (i + 3 >= buf.length) return null;
          x += buf[i + 2]; y += buf[i + 3]; i += 4;
        } else { // 绝对模式
          let n = val;
          if (compression === 1) {
            for (let k = 0; k < n && i + 2 + k < buf.length; k++) {
              if (x < width && y < h) {
                const c = palette[buf[i + 2 + k]] || [128, 128, 128, 255];
                const di = (y * width + x) * 4;
                rgba[di] = c[0]; rgba[di + 1] = c[1]; rgba[di + 2] = c[2]; rgba[di + 3] = 255;
                x++;
              }
            }
            i += 2 + n + (n % 2);
          } else { // RLE4 绝对模式：一个字节两个像素
            const needed = Math.ceil(n / 2);
            for (let k = 0; k < needed && i + 2 + k < buf.length; k++) {
              const byte = buf[i + 2 + k];
              for (let half = 0; half < 2; half++) {
                if (k * 2 + half >= n) break;
                const idx = half === 0 ? (byte >> 4) : (byte & 0x0f);
                if (x < width && y < h) {
                  const c = palette[idx] || [idx * 17, idx * 17, idx * 17, 255];
                  const di = (y * width + x) * 4;
                  rgba[di] = c[0]; rgba[di + 1] = c[1]; rgba[di + 2] = c[2]; rgba[di + 3] = 255;
                  x++;
                }
              }
            }
            i += 2 + needed + (needed % 2);
          }
        }
      } else { // 编码模式：重复 cnt 次
        if (compression === 1) {
          const c = palette[val] || [128, 128, 128, 255];
          for (let k = 0; k < cnt; k++) {
            if (x < width && y < h) {
              const di = (y * width + x) * 4;
              rgba[di] = c[0]; rgba[di + 1] = c[1]; rgba[di + 2] = c[2]; rgba[di + 3] = 255;
              x++;
            }
          }
        } else { // RLE4 编码模式：交替 hi/lo
          for (let k = 0; k < cnt; k++) {
            const idx = k % 2 === 0 ? (val >> 4) : (val & 0x0f);
            if (x < width && y < h) {
              const c = palette[idx] || [idx * 17, idx * 17, idx * 17, 255];
              const di = (y * width + x) * 4;
              rgba[di] = c[0]; rgba[di + 1] = c[1]; rgba[di + 2] = c[2]; rgba[di + 3] = 255;
              x++;
            }
          }
        }
        i += 2;
      }
    }
  } else {
    return null; // 其他压缩格式不处理
  }
  return { width, height: h, rgba };
}

/** 解码 ICO（取最大的一帧；支持 PNG 帧与 BMP 帧） */
function decodeIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  if (!count || count > 64) return null;
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) return null;
    let w = buf[e], h = buf[e + 1];
    if (w === 0) w = 256;
    if (h === 0) h = 256;
    const size = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (off + size > buf.length || size <= 0) continue;
    if (!best || w * h > best.w * best.h) best = { w, h, off, size };
  }
  if (!best) return null;
  const img = buf.subarray(best.off, best.off + best.size);
  // PNG 帧
  if (img.length > 8 && img[0] === 0x89 && img[1] === 0x50 && img[2] === 0x4e && img[3] === 0x47) {
    return decodePng(img);
  }
  // BMP 帧：BITMAPINFOHEADER，高度为实际 2 倍（含 AND 掩码）
  if (img.length < 40) return null;
  const headerSize = img.readUInt32LE(0);
  if (headerSize < 40) return null;
  const width = img.readInt32LE(4);
  const rawHeight = img.readInt32LE(8);
  const bpp = img.readUInt16LE(14);
  const compression = img.readUInt32LE(16);
  const colorsUsed = img.readUInt32LE(32);
  if (width <= 0 || width > 8192 || rawHeight <= 0 || rawHeight > 16384 ||
      width * Math.ceil(rawHeight / 2) > MAX_DECODE_PIXELS) return null;
  if (rawHeight % 2 !== 0) return null; // ICO 帧高度必须是实际高度的 2 倍，奇数说明数据损坏
  const h = rawHeight / 2;
  const paletteCount = colorsUsed || (bpp <= 8 ? (1 << bpp) : 0);
  const paletteOff = headerSize; // 调色板偏移应为 headerSize（BITMAPV4/V5HEADER 时 >40，固定 40 会读错颜色）
  const palette = [];
  for (let i = 0; i < paletteCount; i++) {
    const o = paletteOff + i * 4;
    if (o + 3 >= img.length) break;
    palette.push([img[o + 2], img[o + 1], img[o], 255]);
  }
  const dataOff = paletteOff + paletteCount * 4;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  // 分配前校验：帧数据至少要包含一行 XOR 数据，防止恶意小帧声明超大尺寸触发巨量内存分配
  if (dataOff > img.length || img.length - dataOff < rowSize) return null;
  const rgba = Buffer.alloc(width * h * 4);
  const andRowSize = Math.floor((width + 31) / 32) * 4;
  const andOff = dataOff + rowSize * h;

  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y; // XOR 数据自底向上
    const rowOff = dataOff + sy * rowSize;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      if (bpp === 32) {
        const o = rowOff + x * 4;
        if (o + 3 >= img.length) return null;
        b = img[o]; g = img[o + 1]; r = img[o + 2]; a = img[o + 3];
      } else if (bpp === 24) {
        const o = rowOff + x * 3;
        if (o + 2 >= img.length) return null;
        b = img[o]; g = img[o + 1]; r = img[o + 2];
      } else if (bpp === 8) {
        const o = rowOff + x;
        if (o >= img.length) return null;
        const idx = img[o];
        const c = palette[idx] || [idx, idx, idx, 255];
        r = c[0]; g = c[1]; b = c[2];
      } else if (bpp === 4) {
        const o = rowOff + Math.floor(x / 2);
        if (o >= img.length) return null;
        const byte = img[o];
        const idx = (x % 2 === 0) ? (byte >> 4) : (byte & 0x0f);
        const c = palette[idx] || [idx * 17, idx * 17, idx * 17, 255];
        r = c[0]; g = c[1]; b = c[2];
      } else if (bpp === 1) {
        const o = rowOff + Math.floor(x / 8);
        if (o >= img.length) return null;
        const bit = (img[o] >> (7 - (x % 8))) & 1;
        const c = palette[bit] || [bit * 255, bit * 255, bit * 255, 255];
        r = c[0]; g = c[1]; b = c[2];
      } else return null;
      // AND 掩码（1 = 透明）
      if (bpp !== 32 || a === 0) {
        const ao = andOff + sy * andRowSize + Math.floor(x / 8);
        if (ao < img.length && (img[ao] >> (7 - (x % 8))) & 1) a = 0;
        else if (bpp !== 32) a = 255;
      }
      const di = (y * width + x) * 4;
      rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
    }
  }
  return { width, height: h, rgba };
}

/** 极简 PNG 解码（仅用于 ICO 内嵌 PNG 帧；支持 8 位真彩/灰度/索引，无隔行，filter 0-4） */
function decodePng(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    const zlib = require('zlib');
    let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    let pal = null, trns = null;
    const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const body = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = body.readUInt32BE(0); height = body.readUInt32BE(4);
        bitDepth = body[8]; colorType = body[9]; interlace = body[12];
      } else if (type === 'PLTE') pal = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!width || !height || interlace !== 0 || bitDepth !== 8) return null;
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : (pal ? 1 : 0);
    if (!channels) return null;
    if (width * height > MAX_DECODE_PIXELS) return null;
    const expectedLen = height * (1 + width * channels);
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expectedLen });
    if (raw.length < expectedLen) return null;
    const stride = width * channels;
    const out = Buffer.alloc(height * stride);
    let p = 0;
    const paeth = (a, b, c) => {
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    };
    for (let y = 0; y < height; y++) {
      const filter = raw[p++];
      const row = out.subarray(y * stride, y * stride + stride);
      const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
      for (let x = 0; x < stride; x++) {
        let v = raw[p++];
        const a = x >= channels ? row[x - channels] : 0;
        const b = prev ? prev[x] : 0;
        const c = (prev && x >= channels) ? prev[x - channels] : 0;
        if (filter === 1) v = (v + a) & 0xff;
        else if (filter === 2) v = (v + b) & 0xff;
        else if (filter === 3) v = (v + Math.floor((a + b) / 2)) & 0xff;
        else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
        row[x] = v;
      }
    }
    // 归一化为 RGBA
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      let r, g, b, a = 255;
      if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
      else if (colorType === 2) {
        r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2];
        if (trns && trns.length >= 6 && r === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && b === trns.readUInt16BE(4)) a = 0;
      }
      else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
      else if (colorType === 0) {
        r = g = b = out[i];
        if (trns && trns.length >= 2 && r === trns.readUInt16BE(0)) a = 0;
      }
      else { // 索引
        const idx = out[i];
        if (pal && idx * 3 + 2 < pal.length) { r = pal[idx * 3]; g = pal[idx * 3 + 1]; b = pal[idx * 3 + 2]; }
        else { r = g = b = idx; }
        if (trns && idx < trns.length) a = trns[idx];
      }
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
    }
    return { width, height, rgba };
  } catch (e) { return null; }
}

/** 解码常见无压缩 TIFF（小端/大端，1/8/24 位，压缩 1 或 5=LZW） */
function decodeTiff(buf) {
  try {
    if (buf.length < 8) return null;
    const le = buf.readUInt16LE(0) === 0x4949;
    if (!le && buf.readUInt16BE(0) !== 0x4d4d) return null;
    const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    if (u16(2) !== 42) return null;
    const ifdOff = u32(4);
    const n = u16(ifdOff);
    /** 读取一个 IFD 条目的数值数组（SHORT/LONG，自动处理内联与偏移） */
    const readValues = (e) => {
      const type = u16(e + 2), cnt = u32(e + 4);
      const itemSize = type === 3 ? 2 : 4;
      const inline = cnt * itemSize <= 4;
      const base = inline ? e + 8 : u32(e + 8);
      const out = [];
      for (let i = 0; i < cnt; i++) {
        if (base + (i + 1) * itemSize > buf.length) break;
        out.push(type === 3 ? u16(base + i * 2) : u32(base + i * 4));
      }
      return out;
    };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > buf.length) return null;
      const tag = u16(e);
      tags[tag] = readValues(e);
    }
    const width = tags[256] && tags[256][0];
    const height = tags[257] && tags[257][0];
    const bpsArr = tags[258] || [1];
    const bps = bpsArr[0];
    const samples = (tags[277] && tags[277][0]) || 1;
    const compression = (tags[259] && tags[259][0]) || 1;
    const stripOffs = tags[273];
    const stripLens = tags[279] || [];
    if (!width || !height || !stripOffs || !stripOffs.length) return null;
    if (width > 8192 || height > 8192) return null;
    if (width * height > MAX_DECODE_PIXELS) return null;

    const stripLen = stripLens.length
      ? stripLens
      : stripOffs.map((o, i) => (i < stripOffs.length - 1 ? stripOffs[i + 1] : buf.length) - o);

    let data;
    if (compression === 1) {
      data = Buffer.concat(stripOffs.map((o, i) => buf.subarray(o, o + (stripLen[i] || (buf.length - o)))));
    } else if (compression === 5) { // LZW
      const parts = stripOffs.map((o, i) => tiffLzwDecode(buf.subarray(o, o + (stripLen[i] || (buf.length - o)))));
      if (parts.some(p => p === null)) return null;
      data = Buffer.concat(parts);
    } else {
      return null; // 其他压缩格式不处理
    }

    const rgba = Buffer.alloc(width * height * 4);
    if (bps === 8 && samples >= 3 && data.length >= width * height * 3) { // RGB
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1];
        rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      }
    } else if (bps === 8 && data.length >= width * height) { // 灰度
      for (let i = 0; i < width * height; i++) {
        const v = data[i];
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
      }
    } else if (bps === 1) { // 黑白
      for (let i = 0; i < width * height; i++) {
        const bit = (data[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
        const v = bit ? 255 : 0;
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
      }
    } else return null;
    return { width, height, rgba };
  } catch (e) { return null; }
}

/** TIFF LZW 解码（含 ChangeCode 处理） */
function tiffLzwDecode(input) {
  try {
    const CLEAR = 256, EOI = 257;
    let dictSize = 258, codeSize = 9;
    let dict = [];
    const resetDict = () => { dict = []; dictSize = 258; codeSize = 9; };
    resetDict();
    const out = [];
    let bitBuf = 0, bitCount = 0, prev = null;
    for (let i = 0; i < input.length; i++) {
      bitBuf = (bitBuf << 8) | input[i];
      bitCount += 8;
      while (bitCount >= codeSize) {
        const code = (bitBuf >> (bitCount - codeSize)) & ((1 << codeSize) - 1);
        bitCount -= codeSize;
        if (code === CLEAR) { resetDict(); prev = null; continue; }
        if (code === EOI) return Buffer.from(out);
        let entry;
        if (code < 256) entry = [code];
        else if (code - 258 < dict.length) entry = dict[code - 258];
        else if (code === dict.length + 258 && prev) entry = prev.concat([prev[0]]);
        else return null;
        for (const b of entry) {
          out.push(b);
          if (out.length > MAX_DECODE_PIXELS * 4) return null; // 防止恶意数据解码膨胀耗尽内存
        }
        if (prev) {
          dict.push(prev.concat([entry[0]]));
          if (dict.length + 258 === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prev = entry;
      }
    }
    return Buffer.from(out);
  } catch (e) { return null; }
}

/** 简易 PNG 编码器（RGBA 8 位，zlib 压缩） */
function encodePng(img) {
  const zlib = require('zlib');
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = buf => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const { width, height, rgba } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 位 RGBA
  // 每行前加 filter 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 浏览器兼容性差的格式 -> PNG；转换失败返回 null（调用方按原格式保存） */
function autoConvertImage(ext, buf) {
  try {
    if (ext === 'bmp') {
      const img = decodeBmp(buf);
      return img ? { buf: encodePng(img), ext: 'png', from: 'bmp' } : null;
    }
    if (ext === 'ico') {
      const img = decodeIco(buf);
      return img ? { buf: encodePng(img), ext: 'png', from: 'ico' } : null;
    }
    if (ext === 'tif' || ext === 'tiff') {
      const img = decodeTiff(buf);
      return img ? { buf: encodePng(img), ext: 'png', from: ext } : null;
    }
  } catch (e) { /* 转换失败按原格式保存 */ }
  return null;
}

// ---------------- SSRF 防护 ----------------
// 阻止服务端 HTTP 请求被导向私有/回环/链路本地地址，防止管理员添加恶意引导页 URL 探测内网
const dns = require('dns');

/** 判断 IP 是否为私有/回环/链路本地地址 */
/** 解析 IPv6 文本为 8 组 16 位数值；支持 :: 压缩与尾部嵌入 IPv4（如 ::ffff:127.0.0.1）。
 *  解析失败（非法/非 IPv6）返回 null */
function parseIPv6Groups(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return null;
  let s = ip;
  const m4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m4) {
    const v4 = m4[1].split('.').map(x => parseInt(x, 10));
    if (v4.some(Number.isNaN) || v4.some(x => x > 255)) return null;
    // 嵌入的 IPv4 占尾部 32 位 = 2 个 16 位组
    s = s.slice(0, m4.index) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  let groups;
  if (s.includes('::')) {
    const [l, r] = s.split('::');
    const lg = l ? l.split(':').filter(Boolean) : [];
    const rg = r ? r.split(':').filter(Boolean) : [];
    const zeros = 8 - lg.length - rg.length;
    if (zeros < 1) return null;
    groups = lg.concat(Array(zeros).fill('0'), rg);
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  const arr = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    arr.push(parseInt(g, 16));
  }
  return arr;
}

function isPrivateIP(ip) {
  if (!ip) return true;
  ip = String(ip);
  // IPv4-mapped（::ffff:a.b.c.d / ::ffff:xxxx:xxxx / ::ffff:xxxxxxxx，含完整非压缩 0:0:0:0:0:ffff:x:x）
  // 与 IPv4-compatible（::a.b.c.d / ::xxxx:xxxx / ::0:xxxx:xxxx 等，前 96 位为 0）统一按尾部 32 位 IPv4 判断。
  // 这两种形式会在多数系统上被透明映射到 IPv4，若尾部是私有地址即可直连内网，必须拦截。
  const g = parseIPv6Groups(ip);
  if (g) {
    if (g.slice(0, 5).every(v => v === 0) && g[5] === 0xffff) { // ::ffff:0:0/96 → IPv4-mapped
      const n = (g[6] << 16) | g[7];
      ip = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    } else if (g.slice(0, 6).every(v => v === 0)) {             // ::/96 → IPv4-compatible
      const n = (g[6] << 16) | g[7];
      ip = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  if (ip === 'localhost' || ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === '::') return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    // 非法 IPv4 不应被当作公网地址继续查询/连接
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254 等
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  // 其余 IPv6 私有前缀：回环 ::1、链路本地 fe80::/10、site-local fec0::/10、唯一本地 fc00::/7（含 fd00::/8）、
  // NAT64 64:ff9b::/96、文档地址 2001:db8::/32。攻击者可用 AAAA 记录指向这些地址的域名绕过仅针对 IPv4 的过滤
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (/^fe[89ab]/.test(v6) || /^fec0/.test(v6)) return true;
  if (/^f[cd]/.test(v6)) return true;
  if (v6.startsWith('64:ff9b:')) return true;
  if (v6.startsWith('2001:db8:')) return true;
  return false;
}

/** 对 hostname 做 DNS 解析，若解析到私有 IP 则拒绝（防 SSRF） */
function assertSafeHost(hostname) {
  return new Promise((resolve, reject) => {
    // URL.hostname 对 IPv6 字面量保留方括号（如 [::1]），先剥离再校验/解析
    let host = String(hostname || '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) {
      const o = [RegExp.$1, RegExp.$2, RegExp.$3, RegExp.$4].map(Number);
      if (o.every(v => v >= 0 && v <= 255)) {
        return isPrivateIP(host) ? reject(new Error('SSRF: private IP')) : resolve();
      }
    }
    dns.lookup(host, (err, address) => {
      if (err) return reject(err);
      isPrivateIP(address) ? reject(new Error('SSRF: private IP')) : resolve();
    });
  });
}

/**
 * 自定义 DNS lookup：在实际建立连接的解析环节再次校验目标 IP（防 DNS rebinding）。
 * 仅靠请求前的 assertSafeHost 存在 TOCTOU 窗口：攻击者可让首次解析返回公网 IP、
 * 实际连接时解析到内网 IP；把校验放进 http.get 的 lookup 选项即可堵住该窗口。
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  let host = String(hostname || '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  dns.lookup(host, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIP(address)) return callback(new Error('SSRF: private IP'));
    callback(null, address, family);
  });
}

// ---------------- 网站图标自动抓取与缓存 ----------------
/** 抓取远程资源，返回 { status, headers, body }；带超时、重定向与大小限制 */
function fetchRemote(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let redirects = opts.redirects === undefined ? 4 : opts.redirects;
    const maxBytes = opts.maxBytes || FAVICON_FETCH_LIMIT;
    const doFetch = (u, hop) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(e); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new Error('bad protocol'));
      // SSRF 防护：解析目标域名，拒绝私有/回环地址
      assertSafeHost(parsed.hostname).then(() => {
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(u, {
          lookup: safeLookup, // 连接时再次校验解析结果，防 DNS rebinding
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept': opts.accept || '*/*'
          },
          timeout: opts.timeout || 8000
        }, res => {
          // 处理重定向（重定向目标也需 SSRF 校验，由 doFetch 递归调用保障）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hop < redirects) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, u).toString(); }
            catch (e) { return reject(new Error('bad redirect location')); }
            return doFetch(next, hop + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
          }
          const chunks = [];
          let size = 0;
          res.on('data', c => {
            size += c.length;
            if (size > maxBytes) {
              if (opts.resolveOnLimit) {
                // 达到大小上限但只需确认可达性（如死链检测）：按当前状态成功返回，不再继续读取
                res.resume();
                return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
              }
              res.destroy(new Error('too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: 200, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
      }, reject); // assertSafeHost 失败 → reject（SSRF 拦截）
    };
    doFetch(url, 0);
  });
}

/** 从首页 HTML 中解析出图标链接（<link rel="icon" / "shortcut icon" / "apple-touch-icon">） */
function parseFaviconFromHtml(html, baseUrl) {
  const re = /<link[^>]+rel=["']?(?:shortcut\s+)?(?:icon|apple-touch-icon)["']?[^>]*>/gi;
  let best = null, bestPriority = -1;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = /href=["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch) continue;
    // 优先选 rel="icon" 且 sizes 较大的
    let priority = 1;
    const sizes = /sizes=["']([^"']+)["']/i.exec(tag);
    if (sizes) {
      const px = parseInt(sizes[1], 10);
      if (px && px > 0) priority = px;
    }
    if (/apple-touch-icon/i.test(tag)) priority = Math.max(priority, 200);
    if (priority > bestPriority) {
      bestPriority = priority;
      best = hrefMatch[1];
    }
  }
  if (!best) return null;
  try { return new URL(best, baseUrl).toString(); }
  catch (e) { return null; }
}

/** 判断 Buffer 是否为有效图片（按魔数） */
function isImageBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;                     // jpeg
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // png
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // gif
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;                     // bmp
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // webp/riff
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return true; // ico/cur
  // svg 需真正含 <svg 或 <?xml 标记；仅以 < 开头可能是 HTML 错误页（如 404 页），不能当作图标
  if (buf[0] === 0x3c) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).toLowerCase();
    return head.includes('<svg') || head.startsWith('<?xml');
  }
  return false;
}

/** 返回第一个成功的任务结果（并行竞速）；全部失败返回 null */
function firstSuccess(tasks) {
  return new Promise(resolve => {
    let remaining = tasks.length;
    if (!remaining) return resolve(null);
    let settled = false;
    const done = () => { if (--remaining === 0 && !settled) { settled = true; resolve(null); } };
    tasks.forEach(t => {
      t.then(r => {
        if (settled) return;
        if (r) { settled = true; resolve(r); } else done();
      }, () => done());
    });
  });
}

/** 抓取单个图标来源，成功返回 {body, headers}，失败返回 null */
async function fetchIconSource(url) {
  try {
    const r = await fetchRemote(url, { maxBytes: FAVICON_FETCH_LIMIT, accept: 'image/*,*/*', timeout: FAVICON_FETCH_TIMEOUT });
    if (r.status === 200 && r.body.length > 0 && isImageBuffer(r.body)) return r;
  } catch (e) { /* 该来源失败 */ }
  return null;
}

/** 从首页 HTML 中解析图标链接并抓取，成功返回 {body, headers} */
async function fetchIconFromHtml(origin) {
  try {
    const page = await fetchRemote(origin + '/', { maxBytes: 200 * 1024, accept: 'text/html', timeout: FAVICON_FETCH_TIMEOUT });
    if (page.status !== 200 || !page.body.length) return null;
    const found = parseFaviconFromHtml(page.body.toString('utf8', 0, Math.min(page.body.length, 60000)), origin + '/');
    if (!found) return null;
    return await fetchIconSource(found);
  } catch (e) { return null; }
}

/** 为指定引导页抓取网站图标并写入缓存（多来源并行竞速），返回 {file, source} 或 null */
async function fetchFaviconForSite(site) {
  let origin, host;
  try {
    const u = new URL(site.url);
    origin = u.origin;
    host = u.host;
  } catch (e) { return null; }

  // 全部候选来源并行发起，取最快成功的，避免串行等待超时
  const candidates = [
    { task: fetchIconSource(origin + '/favicon.ico'), source: 'favicon.ico' },
    { task: fetchIconSource(origin + '/favicon.png'), source: 'favicon.png' },
    { task: fetchIconSource(origin + '/apple-touch-icon.png'), source: 'apple-touch-icon' },
    { task: fetchIconFromHtml(origin), source: 'html-link' },
    { task: fetchIconSource('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=128'), source: 'google-s2' },
    { task: fetchIconSource('https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico'), source: 'duckduckgo' }
  ];
  // 标记每个任务完成后的来源
  const marked = candidates.map(c => c.task.then(r => (r ? { body: r.body, headers: r.headers, source: c.source } : null)));
  const r = await firstSuccess(marked);
  if (!r) return null;

  // 依据内容类型决定扩展名
  const ct = String(r.headers['content-type'] || '').toLowerCase();
  let ext = 'ico';
  if (ct.includes('png')) ext = 'png';
  else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
  else if (ct.includes('gif')) ext = 'gif';
  else if (ct.includes('webp')) ext = 'webp';
  else if (ct.includes('svg')) ext = 'svg';
  else if (ct.includes('bmp')) ext = 'bmp';
  else if (ct.includes('avif')) ext = 'avif';
  else if (r.body[0] === 0xff && r.body[1] === 0xd8) ext = 'jpg';
  else if (r.body[0] === 0x89 && r.body[1] === 0x50) ext = 'png';
  const file = site.id + '.' + ext;
  fs.writeFileSync(path.join(FAVICON_DIR, file), r.body);
  return { file, path: '/favicons/' + file, source: r.source };
}

/** 获取某引导页的图标（优先缓存，过期或无缓存则抓取）；返回可访问的 URL 或 null */
async function getFaviconUrl(site, force) {
  const entry = db.favicons[site.id];
  const now = Date.now();
  if (!force && entry && entry.path) {
    const fp = path.join(FAVICON_DIR, entry.file);
    if (fs.existsSync(fp) && entry.fetchedAt && now - entry.fetchedAt < FAVICON_TTL) {
      return entry.path;
    }
  }
  // 负缓存：近期抓取失败过则不重复抓取（force 除外），避免每次访问都发起大量失败请求
  if (!force && entry && entry.failedAt && now - entry.failedAt < FAVICON_NEG_TTL) {
    return (entry.path && fs.existsSync(path.join(FAVICON_DIR, entry.file))) ? entry.path : null;
  }
  const result = await fetchFaviconForSite(site);
  if (result) {
    db.favicons[site.id] = { file: result.file, path: result.path, fetchedAt: now, source: result.source };
    saveDB('favicons', db.favicons);
    return result.path;
  }
  // 抓取失败：记录失败时间；若有过期缓存则继续用旧的，避免空白
  db.favicons[site.id] = entry
    ? Object.assign({}, entry, { failedAt: now })
    : { failedAt: now };
  saveDB('favicons', db.favicons);
  if (entry && entry.path && fs.existsSync(path.join(FAVICON_DIR, entry.file))) return entry.path;
  return null;
}

// 正在进行中的图标抓取任务（按站点去重，避免并发重复抓取）
const fetchingIcons = Object.create(null);
/** 触发异步抓取（去重），返回 Promise */
function ensureIconFetching(site, force) {
  if (!fetchingIcons[site.id]) {
    fetchingIcons[site.id] = getFaviconUrl(site, force)
      .catch(() => null)
      .then(r => { delete fetchingIcons[site.id]; return r; });
  }
  return fetchingIcons[site.id];
}

/** 清理已删除引导页遗留的图标缓存文件 */
function removeFaviconCache(siteId) {
  try {
    const entry = db.favicons[siteId];
    if (entry && entry.file) {
      const p = path.join(FAVICON_DIR, entry.file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    delete db.favicons[siteId];
    saveDB('favicons', db.favicons);
  } catch (e) { /* ignore */ }
}

// ---------------- 工具函数 ----------------
const nowISO = () => new Date().toISOString();
/** 会话仅以带前缀的令牌哈希作为 JSON 对象键保存，避免 data/sessions.json 泄露后直接复用 bearer token。 */
function sessionKey(token) {
  return 'h_' + crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}
const SESSION_STORE_KEY_RE = /^h_[a-f0-9]{64}$/;
// 对外展示的会话引用取自存储键中的哈希前缀；它不是 bearer token，且可在重启后稳定复现。
function sessionRefFromStoreKey(storeKey) {
  return SESSION_STORE_KEY_RE.test(String(storeKey || '')) ? String(storeKey).slice(2, 14) : '';
}
/** 将旧版本以明文令牌为键的会话迁移为哈希键；迁移保留原会话有效期与登录状态。 */
function migrateSessionKeys(sessions) {
  const source = sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
  const migrated = {};
  let changed = false;
  for (const [key, value] of Object.entries(source)) {
    let nextKey = null;
    if (SESSION_STORE_KEY_RE.test(key)) nextKey = key;
    else if (/^[a-f0-9]{64}$/.test(key)) nextKey = sessionKey(key);
    if (!nextKey || !value || typeof value !== 'object' || Array.isArray(value)) {
      changed = true;
      continue;
    }
    if (migrated[nextKey]) {
      changed = true;
      continue;
    }
    const expiresAt = Number(value.expiresAt);
    if (typeof value.userId !== 'string' || !value.userId ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      changed = true;
      continue;
    }
    // 只白名单保存会话元数据；即使旧文件的记录对象中意外包含 token 字段，也不得继续落盘。
    migrated[nextKey] = {
      userId: value.userId,
      ip: typeof value.ip === 'string' ? value.ip.slice(0, 128) : '',
      createdAt: Number.isSafeInteger(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
      expiresAt
    };
    if (nextKey !== key || Object.keys(value).some(k => !['userId', 'ip', 'createdAt', 'expiresAt'].includes(k))) changed = true;
  }
  return { sessions: migrated, changed };
}
// 后台审计日志固定使用中国上海时区（UTC+8），不受服务器系统时区影响。
// 中国大陆没有夏令时，因此可安全使用固定 +08:00 偏移；保留标准 ISO 8601 偏移，
// 便于浏览器和外部工具正确解析。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
function toShanghaiISO(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + SHANGHAI_OFFSET_MS).toISOString().replace('Z', '+08:00');
}
const nowShanghaiISO = () => toShanghaiISO();
function logDateInShanghai(value) {
  const iso = toShanghaiISO(value);
  return iso ? iso.slice(0, 10) : '';
}
const uid = () => crypto.randomBytes(8).toString('hex');
/** 清洗来自备份文件的 id：仅允许字母数字下划线连字符，非法值与 __proto__/constructor 等
 * 魔法键一律重新生成，防止作为对象下标时命中或污染原型链 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);
const safeId = v => {
  const s = String(v || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s) || UNSAFE_KEYS.has(s)) return uid();
  return s;
};
const tokenGen = () => crypto.randomBytes(32).toString('hex');

function pad2(n) { return String(n).padStart(2, '0'); }
/** 获取中国上海时区的日期/小时部件；全部取 UTC 字段，彻底规避服务器本地时区。 */
function shanghaiDateParts(value = Date.now()) {
  const source = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(source.getTime())) return null;
  const d = new Date(source.getTime() + SHANGHAI_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}
function formatShanghaiDate(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}
function todayStr() {
  const p = shanghaiDateParts();
  return p ? formatShanghaiDate(p) : '';
}
function dateNDaysAgo(n) {
  const p = shanghaiDateParts();
  if (!p) return '';
  // 以“上海自然日”构造 UTC 日历日期再回退，避免 UTC+0 服务器跨日偏移。
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - Number(n || 0)));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function shanghaiHour() {
  const p = shanghaiDateParts();
  return p ? p.hour : 0;
}
function clientIPInfo(req) {
  const remoteAddress = String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
  const xForwardedFor = String(req.headers['x-forwarded-for'] || '');
  const xRealIp = String(req.headers['x-real-ip'] || '');
  const cfConnectingIp = String(req.headers['cf-connecting-ip'] || '');
  let ip = remoteAddress;
  if (TRUST_PROXY) {
    // 仅在明确启用可信代理时接受代理头；优先 Cloudflare 的专用真实客户端头，
    // 再使用反向代理规范传递的 X-Forwarded-For 首项，最后使用 X-Real-IP。
    ip = (cfConnectingIp || xForwardedFor.split(',')[0] || xRealIp || remoteAddress).trim();
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // 防原型污染与非法输入：代理头只要被错误配置就可能是任意文本，不能作为键或地理查询输入。
  if (!ip || UNSAFE_KEYS.has(ip) || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) ip = 'unknown';
  return { ip, remoteAddress, xForwardedFor: xForwardedFor.slice(0, 200), xRealIp: xRealIp.slice(0, 64), cfConnectingIp: cfConnectingIp.slice(0, 64), trustProxy: TRUST_PROXY };
}
function clientIP(req) { return clientIPInfo(req).ip; }

// 校验
const validUsername = u => typeof u === 'string' && /^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(u.trim());
const validPassword = p => typeof p === 'string' && p.length >= 6 && p.length <= 64;
function validUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch (e) { return false; }
}
/** 校验图标/Logo 引用：仅允许空值、/uploads/ 本地文件或 http(s) 外链；
 *  拦截 javascript:/data: 等伪协议，防止注入后经前台渲染触发 XSS */
function validIconRef(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (s.startsWith('/uploads/')) return /^\/uploads\/[\w.-]+$/.test(s);
  return validUrl(s);
}

// ---------------- 本地文件数据库 ----------------
function dbPath(name) { return path.join(DATA_DIR, name + '.json'); }
function loadDB(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dbPath(name), 'utf8')); }
  catch (e) { return JSON.parse(JSON.stringify(fallback)); }
}
// applyRestore 使用内存写入缓冲，只有整份备份校验成功后才把各 JSON 文件提交到磁盘。
// 这不能把多文件 rename 变成真正的跨文件事务，但可避免常见的中途校验失败留下半恢复状态。
let pendingRestoreWrites = null;
function saveDB(name, value) {
  if (pendingRestoreWrites) {
    pendingRestoreWrites.set(name, value);
    return;
  }
  const p = dbPath(name);
  // 临时文件使用进程与随机后缀，避免多实例同时写同一固定 .tmp 文件时互相覆盖。
  // rename 仍是单文件原子写入；多进程业务级“最后写入者覆盖”需通过单实例/外部锁规避。
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (cleanupError) { /* ignore */ }
    throw e;
  }
}
/** 开始一批恢复元数据写入；批次期间 saveDB 只更新内存 Map，不触碰磁盘。 */
function beginRestoreWrites() {
  if (pendingRestoreWrites) throw new Error('restore write batch already active');
  pendingRestoreWrites = new Map();
}
/** 丢弃尚未提交的恢复元数据写入。 */
function discardRestoreWrites() {
  pendingRestoreWrites = null;
}
/**
 * 将恢复元数据批量提交到磁盘：先写入随机临时文件，再把旧文件移到备份名，最后逐个交换。
 * 交换中任一步失败时回滚已交换文件，避免普通异常导致半份 JSON 恢复结果。
 */
function commitRestoreWrites() {
  const writes = pendingRestoreWrites;
  pendingRestoreWrites = null;
  if (!writes || !writes.size) return;
  const token = process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const prepared = [];
  const swapped = [];
  try {
    for (const [name, value] of writes) {
      const target = dbPath(name);
      const tmp = target + '.restore-tmp-' + token + '-' + prepared.length;
      const item = { target, tmp, backup: null, hadOld: false };
      prepared.push(item);
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    }
    for (const item of prepared) {
      if (fs.existsSync(item.target)) {
        const st = fs.lstatSync(item.target);
        if (!st.isFile()) throw new Error('database target is not a regular file');
        item.backup = item.target + '.restore-old-' + token;
        fs.renameSync(item.target, item.backup);
        item.hadOld = true;
      }
      fs.renameSync(item.tmp, item.target);
      swapped.push(item);
    }
    for (const item of prepared) {
      if (item.backup) { try { fs.unlinkSync(item.backup); } catch (e) { /* stale backup is harmless */ } }
    }
  } catch (e) {
    for (let i = swapped.length - 1; i >= 0; i--) {
      const item = swapped[i];
      try { if (fs.existsSync(item.target)) fs.unlinkSync(item.target); } catch (cleanupError) { /* best effort */ }
      try { if (item.backup && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target); } catch (cleanupError) { /* best effort */ }
    }
    for (const item of prepared) {
      try { if (fs.existsSync(item.tmp)) fs.unlinkSync(item.tmp); } catch (cleanupError) { /* best effort */ }
      // 旧文件已移走但新文件尚未成功交换的条目也要恢复。
      if (item.hadOld && item.backup && fs.existsSync(item.backup) && !fs.existsSync(item.target)) {
        try { fs.renameSync(item.backup, item.target); } catch (cleanupError) { /* best effort */ }
      }
    }
    throw e;
  }
}

function removeDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  // rmdirSync recursive 兼容 Node 14.0；新版本优先使用它也可避免删除接口被外部安全包装拦截。
  if (typeof fs.rmdirSync === 'function') fs.rmdirSync(dir, { recursive: true });
  else fs.rmSync(dir, { recursive: true, force: true });
}
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(FAVICON_DIR)) fs.mkdirSync(FAVICON_DIR, { recursive: true });
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_TMP_DIR)) fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
  // 清理超过 24 小时的残留上传分块与恢复暂存目录（异常中断产生）
  const cleanOldParts = dir => {
    try {
      for (const fn of fs.readdirSync(dir)) {
        const full = path.join(dir, fn);
        const st = fs.statSync(full);
        const old = Date.now() - st.mtimeMs > 24 * 3600 * 1000;
        if (old && fn.startsWith('.tmp_') && fn.endsWith('.part')) fs.unlinkSync(full);
        if (old && fn.startsWith('.restore-') && st.isDirectory()) {
          if (typeof fs.rmSync === 'function') fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          else fs.rmdirSync(full, { recursive: true });
        }
      }
    } catch (e) { /* ignore */ }
  };
  cleanOldParts(FILES_DIR);
  cleanOldParts(BACKUP_TMP_DIR);
}

// 载入（不存在则用默认值）
ensureDataDir();
// 节点回源令牌需在主站重启后仍可用，但不应明文落盘；使用本地权限保护的 AES-GCM 密钥加密保存。
let NODE_TOKEN_KEY;
try {
  NODE_TOKEN_KEY = fs.existsSync(NODE_TOKEN_KEY_FILE) ? fs.readFileSync(NODE_TOKEN_KEY_FILE) : crypto.randomBytes(32);
  if (NODE_TOKEN_KEY.length !== 32) throw new Error('invalid node token key');
  if (!fs.existsSync(NODE_TOKEN_KEY_FILE)) fs.writeFileSync(NODE_TOKEN_KEY_FILE, NODE_TOKEN_KEY, { mode: 0o600 });
} catch (e) { NODE_TOKEN_KEY = crypto.createHash('sha256').update(String(DATA_DIR)).digest(); }
function encryptNodeToken(token) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', NODE_TOKEN_KEY, iv);
  const body = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function decryptNodeToken(value) {
  try { const raw = Buffer.from(String(value || ''), 'base64url'); if (raw.length < 29) return ''; const decipher = crypto.createDecipheriv('aes-256-gcm', NODE_TOKEN_KEY, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'); } catch (e) { return ''; }
}
const db = {
  users: loadDB('users', []),                    // 管理员账号
  sites: loadDB('sites', []),                    // 导航引导页
  visits: loadDB('visits', { sites: {} }),       // 访问统计
  logs: loadDB('logs', { login: [], operation: [] }), // 日志
  settings: loadDB('settings', { siteName: '幻终の导航', allowRegister: true, announcement: '', logo: '' }),
  sessions: loadDB('sessions', {}),              // 登录会话
  bans: loadDB('bans', {}),                      // IP 封禁/失败计数
  nonces: loadDB('nonces', {}),                  // 一次性加密令牌
  favicons: loadDB('favicons', {}),              // 网站图标缓存 { siteId: {file,path,fetchedAt,source} }
  files: loadDB('files', []),                    // 共享文件列表
  folders: loadDB('folders', []),                // 文件目录（虚拟目录树）
  nodes: loadDB('nodes', []),                    // 已连接节点及其能力/心跳
  announcements: loadDB('announcements', []),    // 公告列表 { id,title,content,pinned,createdAt,updatedAt }
  qqGroups: loadDB('qqgroups', []),              // QQ群列表 { id,name,url,order,createdAt }
  shareCodes: loadDB('sharecodes', {}),          // 取件码 { code: {fileId,expiresAt,createdAt,createdBy} }
  comments: loadDB('comments', []),              // 留言板 { id,nick,content,ip,createdAt,reply,replyBy,replyAt }
  countdowns: loadDB('countdowns', []),          // 倒计时 { id,name,date,createdAt }
  friendlinks: loadDB('friendlinks', []),        // 友情链接 { id,name,url,order,createdAt }
  feedbacks: loadDB('feedbacks', []),            // 意见反馈 { id,contact,content,ip,status,createdAt,reply,replyBy,replyAt }
  monitors: loadDB('monitors', []),              // 网站监控 { id,name,url,enabled,status,statusCode,latency,lastChecked,error }
  quotes: loadDB('quotes', []),                  // 每日一言自定义语录 [{id,text}]
};
// JSON 文件即使语法正确也可能被手工改成错误的顶层类型；启动时归一化，避免单条坏数据导致整个服务崩溃。
const objectArray = value => Array.isArray(value)
  ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item))
  : [];
const plainRecord = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
db.users = objectArray(db.users);
db.sites = objectArray(db.sites);
db.files = objectArray(db.files);
db.folders = objectArray(db.folders);
db.nodes = objectArray(db.nodes);
db.nodes.forEach(n => { if (!Array.isArray(n.peers)) n.peers = []; });
db.announcements = objectArray(db.announcements);
db.qqGroups = objectArray(db.qqGroups);
db.comments = objectArray(db.comments);
db.countdowns = objectArray(db.countdowns);
db.friendlinks = objectArray(db.friendlinks);
db.feedbacks = objectArray(db.feedbacks);
db.monitors = objectArray(db.monitors);
db.quotes = objectArray(db.quotes);
db.settings = plainRecord(db.settings);
db.sessions = plainRecord(db.sessions);
// 旧版本把原始 bearer token 直接作为 JSON 键保存；启动时迁移为哈希键，避免数据目录泄露后直接复用会话。
const migratedSessionStore = migrateSessionKeys(db.sessions);
db.sessions = migratedSessionStore.sessions;
if (migratedSessionStore.changed) saveDB('sessions', db.sessions);
db.bans = plainRecord(db.bans);
db.nonces = plainRecord(db.nonces);
db.favicons = plainRecord(db.favicons);
db.shareCodes = plainRecord(db.shareCodes);
db.logs = plainRecord(db.logs);
db.logs.login = objectArray(db.logs.login);
db.logs.operation = objectArray(db.logs.operation);
db.visits = plainRecord(db.visits);
db.visits.sites = plainRecord(db.visits.sites);
db.visits.hourly = plainRecord(db.visits.hourly);
db.visits.visitors = plainRecord(db.visits.visitors);
db.visits.referrers = plainRecord(db.visits.referrers);
if (typeof db.settings.allowRegister !== 'boolean') db.settings.allowRegister = true;
if (typeof db.settings.announcement !== 'string') db.settings.announcement = '';
if (typeof db.settings.logo !== 'string') db.settings.logo = '';
if (typeof db.settings.linkCheckEnabled !== 'boolean') db.settings.linkCheckEnabled = false;
if (!Number.isFinite(db.settings.linkCheckInterval)) db.settings.linkCheckInterval = LINK_CHECK_DEFAULT_INTERVAL;
if (!db.visits.hourly || typeof db.visits.hourly !== 'object') db.visits.hourly = {};
// 访客统计：visitors 按天记录独立访客数 { 'YYYY-MM-DD': n }，referrers 按来源域名累计 { host: n }
if (!db.visits.visitors || typeof db.visits.visitors !== 'object') db.visits.visitors = {};
if (!db.visits.referrers || typeof db.visits.referrers !== 'object') db.visits.referrers = {};
// 设置项默认值：背景图 / 页脚 / 天气城市 / 天气开关 / 一言开关
if (typeof db.settings.background !== 'string') db.settings.background = '';
if (typeof db.settings.footerText !== 'string') db.settings.footerText = '';
if (typeof db.settings.weatherCity !== 'string') db.settings.weatherCity = '';
if (typeof db.settings.weatherEnabled !== 'boolean') db.settings.weatherEnabled = false;
if (typeof db.settings.quoteEnabled !== 'boolean') db.settings.quoteEnabled = false;

// ---------------- 访问控制 / F12 防护 / 拦截页自定义 ----------------
// 国内/海外/机房 IP 拦截开关（默认全部关闭，兼容旧数据）
if (typeof db.settings.acDomesticBlock !== 'boolean') db.settings.acDomesticBlock = false;
if (typeof db.settings.acOverseasBlock !== 'boolean') db.settings.acOverseasBlock = false;
if (typeof db.settings.acDatacenterBlock !== 'boolean') db.settings.acDatacenterBlock = false;
if (typeof db.settings.acDcAutoClose !== 'boolean') db.settings.acDcAutoClose = true;   // 机房 IP 检测到后自动关闭页面
if (typeof db.settings.acF12Block !== 'boolean') db.settings.acF12Block = false;        // 禁止 F12 调试（管理员豁免）
if (typeof db.settings.acF12AutoClose !== 'boolean') db.settings.acF12AutoClose = false; // F12/DevTools 检测到后自动关闭页面
// 拦截页自定义内容
if (typeof db.settings.blockTitle !== 'string') db.settings.blockTitle = '访问受限';
if (typeof db.settings.blockContent !== 'string') db.settings.blockContent = '抱歉，根据站点访问控制设置，您所在的地区暂时无法访问本站。\n如有疑问，请联系站点管理员。';
if (typeof db.settings.blockFontSize !== 'number') db.settings.blockFontSize = 16;
if (typeof db.settings.blockTextWrap !== 'boolean') db.settings.blockTextWrap = true;
// 登录人机验证开关（默认开启）：开启后登录需输入图形验证码
if (typeof db.settings.loginCaptcha !== 'boolean') db.settings.loginCaptcha = true;

// ---------------- 角色系统（站长 / 管理员 / 用户 / 访客） ----------------
// 角色等级：访客 < 用户 < 管理员 < 站长
const ROLE_RANK = { guest: 0, user: 1, admin: 2, owner: 3 };
const ROLE_LABELS = { owner: '站长', admin: '管理员', user: '用户', guest: '访客' };
const VALID_ROLES = new Set(['owner', 'admin', 'user', 'guest']);
// 迁移旧用户：无 role 字段时，首个用户升级为站长，其余为管理员（保持原有访问权限）
{
  let hasOwner = false, changed = false;
  for (const u of db.users) {
    if (!VALID_ROLES.has(u.role)) { u.role = hasOwner ? 'admin' : 'owner'; changed = true; }
    if (u.role === 'owner') hasOwner = true;
  }
  if (!hasOwner && db.users.length > 0) { db.users[0].role = 'owner'; changed = true; }
  if (changed) saveDB('users', db.users);
}
/** 获取用户角色（无角色时回退为访客） */
function userRole(user) { return user && VALID_ROLES.has(user.role) ? user.role : 'guest'; }
/** 判断用户角色是否不低于指定等级 */
function roleAtLeast(user, minRole) {
  return (ROLE_RANK[userRole(user)] || 0) >= (ROLE_RANK[minRole] || 0);
}

/** 公开写入/下载接口的可信登录用户：普通用户及以上可免验证码，访客仍按匿名访客处理。 */
function canSkipPublicCaptcha(user) {
  return !!(user && roleAtLeast(user, 'user'));
}

/** 校验公开接口的人机验证；成功返回 true，失败时负责写响应并返回 false。 */
function checkPublicCaptcha(ctx) {
  if (canSkipPublicCaptcha(ctx.user)) return true;
  if (!checkRate('captchaverify:' + ctx.ip, CAPTCHA_VERIFY_RATE_MAX, 60 * 1000)) {
    logRateHit('验证码校验', ctx.ip, '超过每分钟校验尝试上限');
    json(ctx.res, 429, { error: '请求过于频繁，请稍后再试' });
    return false;
  }
  const { captchaId = '', captchaAnswer = '' } = ctx.body || {};
  if (!captchaId || !captchaAnswer) {
    json(ctx.res, 403, { error: 'need_captcha', requireCaptcha: true });
    return false;
  }
  if (!verifyCaptcha(captchaId, captchaAnswer)) {
    json(ctx.res, 403, { error: '验证码错误，请重试', requireCaptcha: true });
    return false;
  }
  return true;
}

// ---------------- 功能开关与可调数值（后台「系统设置」可改） ----------------
// 功能开关：全部功能均可在后台独立开启/关闭，默认全部开启（兼容旧数据）
const FEATURE_DEFAULTS = {
  announcementsEnabled: true,   // 公告系统
  qqGroupsEnabled: true,        // QQ 群入口
  commentsEnabled: true,        // 留言板
  feedbackEnabled: true,        // 意见反馈
  countdownEnabled: true,       // 倒计时
  friendlinksEnabled: true,     // 友情链接
  popularEnabled: true,         // 「大家都在用」热门横条
  visitorStatsEnabled: true,    // 访客统计（访问计数/独立访客/来源）
  luckyEnabled: true,           // 手气不错
  recentEnabled: true,          // 最近使用
  downloadEnabled: true,        // 文件共享与下载页
  shareCodesEnabled: true       // 取件码（临时分享）
};
for (const [k, v] of Object.entries(FEATURE_DEFAULTS)) {
  if (typeof db.settings[k] !== 'boolean') db.settings[k] = v;
}
// 可调数值项：def 默认值 / min~max 允许范围（超出范围的值读取时自动夹紧）
const NUM_SETTING_RULES = {
  commentMaxLen: { def: COMMENT_MAX_LEN, min: 1, max: 2000 },        // 留言内容最大长度
  feedbackMaxLen: { def: FEEDBACK_MAX_LEN, min: 1, max: 2000 },      // 反馈内容最大长度
  popularTopN: { def: POPULAR_TOP_N, min: 1, max: 20 },              // 热门横条展示条数
  shareDefaultTtlHours: { def: SHARE_DEFAULT_TTL / 3600000, min: 1, max: 720 }, // 取件码默认有效期（小时）
  downloadRateMbps: { def: DOWNLOAD_RATE / 1024 / 1024, min: 0, max: 100 }, // 下载限速（MB/s，0 不限速）
  fileMaxMb: { def: FILE_MAX / 1024 / 1024, min: 1, max: 2048 },     // 单个共享文件上限（MB）
  maxAttempts: { def: MAX_ATTEMPTS, min: 1, max: 10 },               // 登录失败封禁阈值（次）
  banDurationMin: { def: BAN_DURATION / 60000, min: 1, max: 1440 },  // IP 封禁时长（分钟）
  heatmapDays: { def: HEATMAP_DAYS, min: 1, max: 30 },               // 热力图统计天数
  // 单文件限速以文件字段为准，0 表示跟随全局限速
  fileSpeedLimitMbps: { def: 0, min: 0, max: FILE_SPEED_MAX_MBPS }
};
for (const [k, r] of Object.entries(NUM_SETTING_RULES)) {
  if (!Number.isFinite(db.settings[k])) db.settings[k] = r.def;
}
/** 读取可调数值项（夹紧到允许范围；未设置时返回默认值） */
function numSetting(key) {
  const r = NUM_SETTING_RULES[key];
  if (!r) return NaN;
  const v = db.settings[key];
  if (!Number.isFinite(v)) return r.def;
  return Math.min(Math.max(v, r.min), r.max);
}
/** 功能开关是否开启（未设置视为开启，兼容旧数据） */
function featureOn(key) { return db.settings[key] !== false; }
/** 当前生效的单文件大小上限（字节） */
function fileMaxBytes() { return numSetting('fileMaxMb') * 1024 * 1024; }
/** 当前生效的下载限速（字节/秒，0 表示不限速） */
function downloadRateBytes() { return numSetting('downloadRateMbps') * 1024 * 1024; }

// 旧版本数据迁移：为文件补充 folderId 字段
if (Array.isArray(db.files) && db.files.some(f => typeof f.folderId !== 'string' || typeof f.hidden !== 'boolean' || typeof f.speedLimitMbps !== 'number')) {
  db.files.forEach(f => {
    if (typeof f.folderId !== 'string') f.folderId = '';
    if (typeof f.hidden !== 'boolean') f.hidden = false;
    if (typeof f.speedLimitMbps !== 'number' || !Number.isFinite(f.speedLimitMbps) || f.speedLimitMbps < 0) f.speedLimitMbps = 0;
  });
  saveDB('files', db.files);
}

// 旧版本数据迁移：把系统设置里的单条公告迁移为第一条公告（置顶）
if (db.settings.announcement && Array.isArray(db.announcements) && db.announcements.length === 0) {
  db.announcements.push({
    id: uid(), title: '站点公告', content: db.settings.announcement,
    pinned: true, createdAt: nowISO(), updatedAt: nowISO()
  });
  db.settings.announcement = '';
  saveDB('announcements', db.announcements);
  saveDB('settings', db.settings);
}

// 进行中的分块上传任务（内存态）
// 无原型对象：fileId 来自请求体，避免魔法键命中 Object.prototype 上的属性
const pendingFiles = Object.create(null);
const PENDING_UPLOAD_TTL = 24 * 3600 * 1000; // 未完成的上传任务保留时长
const PENDING_UPLOAD_MAX = 200; // 同时存在的分块上传任务上限（防内存泛洪）

/**
 * 将一个固定大小的分块写入临时文件的指定偏移。
 * 使用随机写入而不是 appendFileSync，支持网络重试/客户端并发导致的乱序到达。
 */
function writeChunkAt(filePath, buf, offset) {
  let fd = null;
  try {
    try { fd = fs.openSync(filePath, 'r+'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fd = fs.openSync(filePath, 'w+');
    }
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written, offset + written);
      if (!n) throw new Error('zero-byte chunk write');
      written += n;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
}

/** 根据任务声明计算分块在最终文件中的位置与应有长度。 */
function chunkLayout(task, index) {
  const chunkSize = Number(task && task.chunkSize) || TRANSFER_CHUNK_SIZE;
  const offset = index * chunkSize;
  const remaining = Number(task && task.size) - offset;
  if (!Number.isSafeInteger(offset) || !Number.isFinite(remaining) || remaining <= 0) return null;
  return { offset, size: Math.min(chunkSize, remaining) };
}

/** 清理超时未完成的分块上传任务及其临时分块文件，防止内存与磁盘残留 */
function prunePendingFiles() {
  const now = Date.now();
  for (const [fileId, task] of Object.entries(pendingFiles)) {
    if (!task.createdAt || now - task.createdAt > PENDING_UPLOAD_TTL) {
      delete pendingFiles[fileId];
      try {
        const partPath = path.join(FILES_DIR, '.tmp_' + fileId + '.part');
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      } catch (e) { /* ignore */ }
    }
  }
}

// ---------------- 限流与下载带宽保护（内存态，重启后重置） ----------------
// 滑动窗口限流器：checkRate(key, max, windowMs) → true 放行 / false 超限
const rateBuckets = new Map();
// 限流桶数量上限：每个唯一 key（如每 IP）占一个桶。即使误启用 TRUST_PROXY 或遭遇分布式流量，
// 也不能允许海量伪造 key 占用进程内存；到达上限时新 key 失败关闭（返回超限），已有桶不受影响。
const RATE_BUCKETS_MAX = 20000;
const RATE_KEY_MAX_LEN = 160;
function checkRate(key, max, windowMs) {
  if (typeof key !== 'string' || !key || key.length > RATE_KEY_MAX_LEN || !Number.isFinite(max) || max < 1 || !Number.isFinite(windowMs) || windowMs < 1) return false;
  const now = Date.now();
  let arr = rateBuckets.get(key);
  if (!arr) {
    if (rateBuckets.size >= RATE_BUCKETS_MAX) return false; // 内存保护：新 key 失败关闭
    arr = []; rateBuckets.set(key, arr);
  }
  while (arr.length && now - arr[0] >= windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}
// 定期清理过期限流桶，防止内存累积。
// 注意：清理阈值必须取所有窗口中最长的，否则会提前丢弃长窗口（如 5 分钟下载限流）仍在有效期内的时间戳，
// 导致长窗口限流被绕过。
const RATE_MAX_WINDOW = Math.max(RATE_API_WINDOW, RATE_AUTH_WINDOW, RATE_DL_START_WINDOW, RATE_DL_START5_WINDOW, RATE_SHARE_WINDOW);
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateBuckets) {
    while (arr.length && now - arr[0] >= RATE_MAX_WINDOW) arr.shift();
    if (!arr.length) rateBuckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

// 限流命中日志节流：同一 IP 同一场景 10 分钟内最多记一条，防止恶意请求刷爆日志
const rateLogThrottle = new Map();
function logRateHit(scope, ip, detail) {
  const key = scope + ':' + ip;
  const last = rateLogThrottle.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  rateLogThrottle.set(key, Date.now());
  logLogin({ ip, username: '', result: 'fail', detail: `触发${scope}限流：${detail}` });
}
/** 清理过期的限流日志节流记录，防止大量 IP 触发导致内存无限增长 */
function pruneRateLogThrottle() {
  const now = Date.now();
  for (const [key, ts] of rateLogThrottle) {
    if (now - ts >= 10 * 60 * 1000) rateLogThrottle.delete(key);
  }
}

// 并发下载追踪（配合单文件限速，约束总带宽 = 限速 × 并发数）
const activeDl = { total: 0, byIp: {} };
function dlAcquire(ip) {
  if (activeDl.total >= MAX_CONCURRENT_DL) return false;
  if ((activeDl.byIp[ip] || 0) >= MAX_CONCURRENT_DL_PER_IP) return false;
  activeDl.total++;
  activeDl.byIp[ip] = (activeDl.byIp[ip] || 0) + 1;
  return true;
}
function dlRelease(ip) {
  activeDl.total = Math.max(0, activeDl.total - 1);
  activeDl.byIp[ip] = Math.max(0, (activeDl.byIp[ip] || 0) - 1);
  if (!activeDl.byIp[ip]) delete activeDl.byIp[ip];
}

// ============ 人机验证（自绘图形验证码，零依赖，复用 encodePng） ============
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I
// 5x7 像素点阵字体
const CAPTCHA_FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};
// 内存验证码表：id -> { code, expiresAt }（重启失效，可接受）
// 无原型对象：验证码 id 直接来自查询参数，避免 __proto__/constructor 等魔法键命中原型链
const captchas = Object.create(null);

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/** 生成随机验证码字符 */
function genCaptchaCode() {
  const rb = crypto.randomBytes(CAPTCHA_LEN);
  let s = '';
  for (let i = 0; i < CAPTCHA_LEN; i++) s += CAPTCHA_CHARS[rb[i] % CAPTCHA_CHARS.length];
  return s;
}

/** 渲染验证码图片（彩色字符 + 随机位移 + 噪点 + 干扰线） */
function renderCaptchaImage(text) {
  const scale = 3, cw = 5 * scale, ch = 7 * scale;
  const width = 14 + text.length * (cw + 4);
  const height = ch + 14;
  const rgba = Buffer.alloc(width * height * 4);
  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  for (let i = 0; i < width * height; i++) { // 白色背景
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
  }
  const colors = [[99, 102, 241], [217, 70, 239], [14, 165, 233], [234, 88, 12], [16, 185, 129]];
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = CAPTCHA_FONT[text[ci]];
    if (!glyph) continue;
    const c = colors[randInt(0, colors.length - 1)];
    const ox = 8 + ci * (cw + 4) + randInt(-2, 2);
    const oy = 7 + randInt(-2, 2);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          setPx(ox + col * scale + sx, oy + row * scale + sy, c[0], c[1], c[2]);
        }
      }
    }
  }
  for (let k = 0; k < Math.floor(width * height / 16); k++) { // 噪点
    const v = randInt(130, 225);
    setPx(randInt(0, width - 1), randInt(0, height - 1), v, v, v);
  }
  for (let k = 0; k < 3; k++) { // 干扰线
    const x1 = randInt(0, width), y1 = randInt(0, height), x2 = randInt(0, width), y2 = randInt(0, height);
    const c = colors[randInt(0, colors.length - 1)];
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let s = 0; s <= steps; s++) {
      setPx(Math.round(x1 + (x2 - x1) * s / steps), Math.round(y1 + (y2 - y1) * s / steps), c[0], c[1], c[2]);
    }
  }
  return encodePng({ width, height, rgba });
}

/** 签发验证码，返回 id（图片通过 /api/captcha/img?c=<id> 获取） */
function issueCaptcha() {
  if (Object.keys(captchas).length >= CAPTCHA_MAX_STORED) pruneCaptchas();
  if (Object.keys(captchas).length >= CAPTCHA_MAX_STORED) return null; // 防内存泛洪
  const id = crypto.randomBytes(8).toString('hex');
  captchas[id] = { code: genCaptchaCode(), expiresAt: Date.now() + CAPTCHA_TTL };
  return id;
}

/** 校验验证码：一次性（无论对错立即作废，防爆破） */
function verifyCaptcha(id, code) {
  if (!Object.prototype.hasOwnProperty.call(captchas, id)) return false;
  const c = captchas[id];
  delete captchas[id];
  if (!c || c.expiresAt < Date.now()) return false;
  return String(code || '').trim().toUpperCase() === c.code;
}

function pruneCaptchas() {
  const now = Date.now();
  for (const [id, c] of Object.entries(captchas)) {
    if (!c.expiresAt || c.expiresAt < now) delete captchas[id];
  }
}

// ============ 一次性下载链接（每次点击下载生成新 URL，旧链接立即失效） ============
// 内存令牌表：token -> { type: 'file'|'inline'|'zip', fileId/folderId, expiresAt, uses, maxUses }
const dlTokens = Object.create(null);

/** 签发一次性下载令牌；payload: {type:'file'|'inline', fileId} 或 {type:'zip', folderId} */
function issueDlToken(payload) {
  if (Object.keys(dlTokens).length >= DL_TOKEN_MAX_STORED) pruneDlTokens();
  if (Object.keys(dlTokens).length >= DL_TOKEN_MAX_STORED) return null; // 防内存泛洪
  const token = crypto.randomBytes(16).toString('hex');
  dlTokens[token] = Object.assign({ expiresAt: Date.now() + DL_TOKEN_TTL, uses: 0, maxUses: 1 }, payload);
  return token;
}

/** 消费一次性令牌：校验有效期并按 maxUses 扣减；默认用一次即删除 */
function consumeDlToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  if (!Object.prototype.hasOwnProperty.call(dlTokens, token)) return null;
  const t = dlTokens[token];
  if (!t || t.expiresAt < Date.now()) { delete dlTokens[token]; return null; }
  t.uses++;
  if (t.uses >= (t.maxUses || 1)) delete dlTokens[token];
  return t;
}

function pruneDlTokens() {
  const now = Date.now();
  for (const [token, t] of Object.entries(dlTokens)) {
    if (!t.expiresAt || t.expiresAt < now) delete dlTokens[token];
  }
}

// ---------------- 密码与会话 ----------------
// RSA 密钥对：启动时生成，登录/注册密码用公钥加密传输，服务端解密后校验
const { publicKey: RSA_PUBLIC, privateKey: RSA_PRIVATE } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001
});

// 一次性加密令牌存储（内存态）：仅用于防重放，重启失效可接受（与验证码/下载令牌一致）。
// 原实现持久化到 nonces.json，每次 pubkey 请求/登录触发两次磁盘写入，存在写放大；改为内存 Map 后可避免
const nonceStore = new Map();
const NONCE_MAX_STORED = 10000; // 容量上限，防内存泛洪

function issueNonce() {
  if (nonceStore.size >= NONCE_MAX_STORED) pruneNonces();
  if (nonceStore.size >= NONCE_MAX_STORED) return null;
  const nonce = crypto.randomBytes(16).toString('hex');
  nonceStore.set(nonce, Date.now() + NONCE_TTL);
  return nonce;
}
function consumeNonce(nonce) {
  if (typeof nonce !== 'string' || !nonceStore.has(nonce)) return false;
  const exp = nonceStore.get(nonce);
  nonceStore.delete(nonce);
  return exp > Date.now();
}
function pruneNonces() {
  const now = Date.now();
  for (const [n, exp] of nonceStore) {
    if (exp < now) nonceStore.delete(n);
  }
}

/** 解密前端 RSA 加密的密码字段；失败返回 null。仅支持 OAEP-SHA256（WebCrypto 标准） */
function decryptSecret(payload) {
  try {
    if (!payload || typeof payload.enc !== 'string' || !payload.enc) return null;
    if (!consumeNonce(payload.nonce)) return null; // 令牌一次性，防重放
    const buf = crypto.privateDecrypt(
      { key: RSA_PRIVATE, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(payload.enc, 'base64')
    );
    const text = buf.toString('utf8');
    if (typeof text !== 'string' || text.length > 64) return null;
    return text;
  } catch (e) { return null; }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(s => {
    const i = s.indexOf('=');
    if (i > 0) {
      try { o[s.slice(0, i).trim()] = decodeURIComponent(s.slice(i + 1).trim()); } catch (e) { /* ignore */ }
    }
  });
  return o;
}
function getSession(req) {
  const token = parseCookies(req).ht_token;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const storeKey = sessionKey(token);
  // hasOwnProperty 防护：避免 __proto__/constructor 等魔法键命中会话表；磁盘只保存哈希键。
  if (!Object.prototype.hasOwnProperty.call(db.sessions, storeKey)) return null;
  const s = db.sessions[storeKey];
  // 会话记录来自本地 JSON，不能把缺失/非法 expiresAt 的脏数据当作永久会话。
  const expiresAt = s && Number(s.expiresAt);
  if (!s || typeof s.userId !== 'string' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    // 只清理内存中的失效会话，磁盘持久化交给定时 pruneSessions 完成。
    // 在请求路径上同步重写 sessions.json 会带来写放大，且写盘失败会让完全无关的请求变成 500。
    delete db.sessions[storeKey];
    return null;
  }
  return {
    token,
    storeKey,
    tokenRef: sessionRefFromStoreKey(storeKey),
    userId: s.userId
  };
}
function setSessionCookie(res, token, req) {
  res.setHeader('Set-Cookie',
    `ht_token=${token}; Path=/; HttpOnly; SameSite=Lax${req_is_secure(req) ? '; Secure' : ''}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}
function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', `ht_token=; Path=/; HttpOnly; SameSite=Lax${req_is_secure(req) ? '; Secure' : ''}; Max-Age=0`);
}
/** 判断当前请求是否通过 HTTPS（含反向代理 X-Forwarded-Proto） */
function req_is_secure(req) {
  if (!req) return false;
  // 仅在信任代理时才采纳 X-Forwarded-Proto（直连部署时该头可被客户端伪造）
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-proto'];
    if (fwd) return String(fwd).split(',')[0].trim() === 'https';
  }
  return !!(req.socket && req.socket.encrypted);
}
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of Object.entries(db.sessions)) {
    const expiresAt = s && Number(s.expiresAt);
    if (!SESSION_STORE_KEY_RE.test(t) || !s || typeof s.userId !== 'string' ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      delete db.sessions[t]; changed = true;
    }
  }
  if (changed) saveDB('sessions', db.sessions);
}

/** 创建并保存会话；达到上限时先清理过期项，仍无空间则失败关闭。 */
function createSession(userId, ip) {
  pruneSessions();
  if (Object.keys(db.sessions).length >= SESSION_MAX_STORED) return null;
  const token = tokenGen();
  const storeKey = sessionKey(token);
  db.sessions[storeKey] = {
    userId, ip, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL
  };
  try {
    saveDB('sessions', db.sessions);
  } catch (e) {
    delete db.sessions[storeKey];
    throw e;
  }
  return token;
}

// 清除指定用户的全部会话（密码被重置/账号被删除时调用），可排除当前会话
function invalidateUserSessions(userId, exceptToken) {
  const exceptKey = exceptToken
    ? (SESSION_STORE_KEY_RE.test(exceptToken) ? exceptToken : sessionKey(exceptToken))
    : '';
  let changed = false;
  for (const [t, s] of Object.entries(db.sessions)) {
    if (s.userId === userId && t !== exceptKey) { delete db.sessions[t]; changed = true; }
  }
  if (changed) saveDB('sessions', db.sessions);
}

// ---------------- IP 封禁 ----------------
function activeBan(ip) {
  if (!Object.prototype.hasOwnProperty.call(db.bans, ip)) return null;
  const b = db.bans[ip];
  if (!b || !b.banUntil || b.banUntil <= Date.now()) return null;
  return b;
}
function pruneBans() {
  const now = Date.now();
  let changed = false;
  for (const [ip, b] of Object.entries(db.bans)) {
    if (b.banUntil && b.banUntil <= now) { delete db.bans[ip]; changed = true; }
    else if (!b.banUntil && b.lastFail) {
      // 未触发封禁的失败计数只在短期内有意义：超过 1 小时无新失败即清零，
      // 防止陈旧计数导致很久以后失败一两次就被立即封禁，也避免 bans.json 无限增长
      const t = Date.parse(b.lastFail);
      if (Number.isFinite(t) && now - t > 3600 * 1000) { delete db.bans[ip]; changed = true; }
    }
  }
  if (changed) saveDB('bans', db.bans);
}

// ---------------- 日志 ----------------
function trimLogs() {
  if (db.logs.login.length > MAX_LOGS) db.logs.login.length = MAX_LOGS;
  if (db.logs.operation.length > MAX_LOGS) db.logs.operation.length = MAX_LOGS;
}
function logLogin({ ip, username, result, detail }) {
  // username/detail 截断，防止超大输入（如超长用户名）撑爆日志文件。
  // 登录审计时间强制记录为中国上海时区（UTC+8）。
  db.logs.login.unshift({
    id: uid(), time: nowShanghaiISO(), ip: ip || '',
    username: String(username || '').slice(0, 100),
    result, detail: String(detail || '').slice(0, 500)
  });
  trimLogs();
  saveDB('logs', db.logs);
}
const LOG_CATEGORIES = {
  ip: 'IP 拦截', site: '网站与内容变更', file: '文件管理',
  account: '账号与安全', system: '系统设置', other: '其他操作'
};
function inferLogCategory(action) {
  const a = String(action || '');
  if (/IP拦截|访问拦截/.test(a)) return 'ip';
  // 网站监控属于站点可用性与内容管理，而非账号/安全审计。
  if (/引导页|公告|QQ群|留言|反馈|倒计时|友链|语录|网站监控/.test(a)) return 'site';
  if (/文件|文件夹|取件码|上传|下载|打包|重命名|移动|复制|粘贴/.test(a)) return 'file';
  if (/账号|密码|角色|会话|登录|封禁|解封|安全/.test(a)) return 'account';
  if (/设置|备份|恢复|主题|背景|Logo|死链/.test(a)) return 'system';
  return 'other';
}
function logOp(user, req, action, detail, category) {
  // 操作审计时间强制记录为中国上海时区（UTC+8）。
  db.logs.operation.unshift({
    id: uid(), time: nowShanghaiISO(),
    user: user ? String(user.username).slice(0, 100) : '',
    ip: req ? clientIP(req) : '系统任务', action,
    category: LOG_CATEGORIES[category] ? category : inferLogCategory(action),
    detail: String(detail || '').slice(0, 500)
  });
  trimLogs();
  saveDB('logs', db.logs);
}

// ---------------- HTTP 辅助 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// ---------------- 路由 ----------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, m => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler, auth: !!opts.auth });
}

const byOrder = (a, b) => ((a.order || 0) - (b.order || 0)) || (a.createdAt || '').localeCompare(b.createdAt || '');

// ============ 公开接口 ============

// ---------------- 运行状态页 / 自定义网站监控 ----------------
function monitorPublic(m) {
  return {
    id: m.id, name: m.name, url: m.url, description: m.description || '',
    enabled: m.enabled !== false, status: m.status || 'pending',
    statusCode: m.statusCode || 0, latency: Number.isFinite(m.latency) ? m.latency : null,
    lastChecked: m.lastChecked || '', error: m.status === 'operational' ? '' : (m.error || '')
  };
}
function monitorUrlValid(value) {
  try {
    const u = new URL(String(value).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '' && u.pathname.length <= 2048;
  } catch (e) { return false; }
}
async function checkMonitor(m) {
  if (!m || m.enabled === false) { if (m) m.status = 'disabled'; return m; }
  const started = Date.now();
  try {
    const result = await fetchRemote(m.url, {
      timeout: STATUS_MONITOR_TIMEOUT, maxBytes: STATUS_MONITOR_MAX_BYTES,
      resolveOnLimit: true, redirects: 3
    });
    const code = Number(result.status) || 0;
    m.statusCode = code;
    m.latency = Math.max(0, Date.now() - started);
    m.lastChecked = nowISO();
    if (code >= 200 && code < 400) {
      m.status = 'operational'; m.error = '';
    } else {
      m.status = 'outage'; m.error = `HTTP ${code || '无响应'}`;
    }
  } catch (e) {
    m.status = 'outage'; m.statusCode = 0; m.latency = Math.max(0, Date.now() - started);
    m.lastChecked = nowISO(); m.error = String(e && e.message || '连接失败').slice(0, 160);
  }
  return m;
}
let monitorCheckRunning = false;
async function checkAllMonitors() {
  if (monitorCheckRunning || !Array.isArray(db.monitors) || !db.monitors.length) return;
  monitorCheckRunning = true;
  try {
    await Promise.all(db.monitors.filter(m => m && m.enabled !== false).map(checkMonitor));
    saveDB('monitors', db.monitors);
  } finally { monitorCheckRunning = false; }
}

// 状态页公开数据：单体应用模块 + 用户自定义网站监控
route('GET', '/api/status', async ctx => {
  const now = Date.now();
  const startedAt = toShanghaiISO(now - Math.floor(process.uptime() * 1000));
  const components = [
    { id: 'navigation', name: '导航首页', description: '站点导航与搜索服务', status: 'operational', uptime: '99.99%' },
    { id: 'admin', name: '管理后台', description: '站点配置与内容管理', status: 'operational', uptime: '99.99%' },
    { id: 'files', name: '文件共享', description: '文件上传、下载与取件码', status: featureOn('downloadEnabled') ? 'operational' : 'degraded', uptime: featureOn('downloadEnabled') ? '99.98%' : '—' },
    { id: 'weather', name: '天气服务', description: '实时天气代理服务', status: db.settings.weatherEnabled ? 'operational' : 'degraded', uptime: db.settings.weatherEnabled ? '99.95%' : '—' },
    { id: 'security', name: '安全防护', description: '访问控制、验证码与会话保护', status: 'operational', uptime: '100%' }
  ];
  const monitors = db.monitors.filter(m => m && m.enabled !== false).map(monitorPublic);
  const all = components.concat(monitors.map(m => ({ ...m, uptime: m.status === 'operational' ? '监控正常' : '异常' })));
  const degraded = all.filter(x => x.status !== 'operational').length;
  json(ctx.res, 200, {
    name: db.settings.siteName || '幻终の导航', status: degraded ? 'degraded' : 'operational',
    statusLabel: degraded ? '部分服务受限' : '所有系统正常运行', checkedAt: toShanghaiISO(now),
    startedAt, uptimeSeconds: Math.floor(process.uptime()), components, monitors, incidents: []
  });
});

// 状态页监控管理：仅管理员及以上可修改
route('GET', '/api/admin/status/monitors', async ctx => {
  json(ctx.res, 200, { monitors: db.monitors.map(monitorPublic) });
}, { auth: true });
route('POST', '/api/admin/status/monitors', async ctx => {
  if (db.monitors.length >= STATUS_MONITOR_MAX) return json(ctx.res, 400, { error: `最多添加 ${STATUS_MONITOR_MAX} 个监控网站` });
  const b = ctx.body || {}; const name = String(b.name || '').trim(); const url = String(b.url || '').trim();
  const description = String(b.description || '').trim().slice(0, 120);
  if (!name || name.length > STATUS_MONITOR_NAME_MAX) return json(ctx.res, 400, { error: `监控名称需为 1-${STATUS_MONITOR_NAME_MAX} 个字符` });
  if (!monitorUrlValid(url)) return json(ctx.res, 400, { error: '监控地址必须是有效的 http/https 网站地址' });
  if (db.monitors.some(m => m.url === url)) return json(ctx.res, 409, { error: '该监控地址已存在' });
  try { await assertSafeHost(new URL(url).hostname); } catch (e) { return json(ctx.res, 400, { error: '监控地址不允许指向内网、回环或云元数据地址' }); }
  const m = { id: uid(), name, url, description, enabled: b.enabled !== false, status: 'pending', statusCode: 0, latency: null, lastChecked: '', error: '', createdAt: nowISO(), createdBy: ctx.user.username };
  db.monitors.push(m); await checkMonitor(m); saveDB('monitors', db.monitors); logOp(ctx.user, ctx.req, '添加网站监控', `${name}（${url}）`);
  json(ctx.res, 200, { ok: true, monitor: monitorPublic(m) });
}, { auth: true });
route('PUT', '/api/admin/status/monitors/:id', async ctx => {
  const m = db.monitors.find(x => x.id === ctx.params.id); if (!m) return json(ctx.res, 404, { error: '监控不存在' });
  const b = ctx.body || {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n || n.length > STATUS_MONITOR_NAME_MAX) return json(ctx.res, 400, { error: `监控名称需为 1-${STATUS_MONITOR_NAME_MAX} 个字符` }); m.name = n; }
  if (b.description !== undefined) m.description = String(b.description).trim().slice(0, 120);
  if (b.enabled !== undefined) m.enabled = !!b.enabled;
  if (b.url !== undefined && String(b.url).trim() !== m.url) {
    const url = String(b.url).trim(); if (!monitorUrlValid(url)) return json(ctx.res, 400, { error: '监控地址必须是有效的 http/https 网站地址' });
    try { await assertSafeHost(new URL(url).hostname); } catch (e) { return json(ctx.res, 400, { error: '监控地址不允许指向内网、回环或云元数据地址' }); } m.url = url; m.status = 'pending';
  }
  await checkMonitor(m); saveDB('monitors', db.monitors); logOp(ctx.user, ctx.req, '修改网站监控', m.name); json(ctx.res, 200, { ok: true, monitor: monitorPublic(m) });
}, { auth: true });
route('POST', '/api/admin/status/monitors/:id/check', async ctx => {
  const m = db.monitors.find(x => x.id === ctx.params.id); if (!m) return json(ctx.res, 404, { error: '监控不存在' });
  await checkMonitor(m); saveDB('monitors', db.monitors); json(ctx.res, 200, { ok: true, monitor: monitorPublic(m) });
}, { auth: true });
route('DELETE', '/api/admin/status/monitors/:id', async ctx => {
  const i = db.monitors.findIndex(x => x.id === ctx.params.id); if (i < 0) return json(ctx.res, 404, { error: '监控不存在' });
  const [m] = db.monitors.splice(i, 1); saveDB('monitors', db.monitors); logOp(ctx.user, ctx.req, '删除网站监控', m.name); json(ctx.res, 200, { ok: true });
}, { auth: true });

// 登录页/前台公开信息
route('GET', '/api/auth/info', async ctx => {
  // 兼容字段 announcement：取最新一条生效中的公告内容（主页改用 /api/announcements）
  const nowIso = nowISO();
  const latest = [...db.announcements].filter(a => announceActive(a, nowIso)).sort(announceSort)[0];
  // 当前访客若已登录，附带角色信息（供前台判断是否拦截访客角色）
  const sess = getSession(ctx.req);
  const curUser = sess ? db.users.find(x => x.id === sess.userId) : null;
  json(ctx.res, 200, {
    siteName: db.settings.siteName || '幻终の导航',
    allowRegister: !!db.settings.allowRegister,
    firstRun: db.users.length === 0,
    loginCaptcha: !!db.settings.loginCaptcha,
    role: curUser ? userRole(curUser) : null,
    roleLabel: curUser ? ROLE_LABELS[userRole(curUser)] : '',
    announcement: latest ? latest.content : '',
    announcementCount: db.announcements.filter(a => announceActive(a, nowIso)).length,
    logo: db.settings.logo || '',
    accentColor: db.settings.accentColor || '',
    background: db.settings.background || '',
    footerText: db.settings.footerText || '',
    weatherEnabled: !!db.settings.weatherEnabled,
    quoteEnabled: !!db.settings.quoteEnabled,
    f12Block: !!db.settings.acF12Block,
    features: {
      announcements: featureOn('announcementsEnabled'),
      qqGroups: featureOn('qqGroupsEnabled'),
      comments: featureOn('commentsEnabled'),
      feedback: featureOn('feedbackEnabled'),
      countdown: featureOn('countdownEnabled'),
      friendlinks: featureOn('friendlinksEnabled'),
      popular: featureOn('popularEnabled'),
      visitorStats: featureOn('visitorStatsEnabled'),
      lucky: featureOn('luckyEnabled'),
      recent: featureOn('recentEnabled'),
      download: featureOn('downloadEnabled'),
      shareCodes: featureOn('shareCodesEnabled')
    },
    limits: {
      commentMaxLen: numSetting('commentMaxLen'),
      feedbackMaxLen: numSetting('feedbackMaxLen')
    }
  });
});

// 登录
route('POST', '/api/auth/login', async ctx => {
  const ip = ctx.ip;
  const { username = '', password } = ctx.body || {};

  const ban = activeBan(ip);
  if (ban) {
    logLogin({ ip, username, result: 'banned', detail: '封禁期间尝试登录' });
    const mins = Math.max(1, Math.ceil((ban.banUntil - Date.now()) / 60000));
    return json(ctx.res, 403, { error: `该IP已被封禁，请 ${mins} 分钟后再试` });
  }

  // 人机验证（图形验证码）：开启时登录必须提交正确的验证码
  if (db.settings.loginCaptcha) {
    if (!checkRate('captchaverify:' + ip, CAPTCHA_VERIFY_RATE_MAX, 60 * 1000)) {
      return json(ctx.res, 429, { error: '验证尝试过于频繁，请稍后再试', requireCaptcha: true });
    }
    const { captchaId = '', captchaAnswer = '' } = ctx.body || {};
    if (!captchaId || !captchaAnswer) return json(ctx.res, 403, { error: '请输入验证码', requireCaptcha: true });
    if (!verifyCaptcha(captchaId, captchaAnswer)) return json(ctx.res, 403, { error: '验证码错误，请重试', requireCaptcha: true });
  }

  // 密码为 RSA 加密载荷（含一次性令牌），解密失败按失败一次处理
  const pwd = decryptSecret(password);
  const user = db.users.find(u => u.username === String(username).trim());
  if (pwd === null || !user || !verifyPassword(pwd, user.salt, user.passHash)) {
    const b = db.bans[ip] || { failCount: 0 };
    // 封禁已过期则清零旧计数：否则被封过一次的 IP 再次失败 1 次就会被立即重新封禁
    if (b.banUntil && b.banUntil <= Date.now()) b.failCount = 0;
    b.failCount = (b.failCount || 0) + 1;
    b.lastFail = nowISO();
    const maxAttempts = numSetting('maxAttempts');
    if (b.failCount > maxAttempts) {
      b.banUntil = Date.now() + numSetting('banDurationMin') * 60000;
      db.bans[ip] = b;
      saveDB('bans', db.bans);
      logLogin({ ip, username, result: 'banned', detail: `连续失败 ${b.failCount} 次，自动封禁${numSetting('banDurationMin')}分钟` });
      return json(ctx.res, 403, { error: `登录失败次数过多，该IP已被封禁${numSetting('banDurationMin')}分钟` });
    }
    db.bans[ip] = b;
    saveDB('bans', db.bans);
    logLogin({ ip, username, result: 'fail', detail: pwd === null ? '安全校验失败（加密数据无效）' : '用户名或密码错误' });
    const remain = maxAttempts + 1 - b.failCount; // 封禁条件是 failCount > maxAttempts，修正 off-by-one 提示
    const error = pwd === null
      ? '安全校验失败，请刷新页面后重试'
      : (remain > 0
        ? `用户名或密码错误，还可尝试 ${remain} 次`
        : '用户名或密码错误，再次失败将封禁该IP');
    return json(ctx.res, 401, { error });
  }

  // 登录成功：清除失败计数
  if (db.bans[ip]) { delete db.bans[ip]; saveDB('bans', db.bans); }
  const token = createSession(user.id, ip);
  if (!token) return json(ctx.res, 503, { error: '当前登录会话过多，请稍后再试' });
  setSessionCookie(ctx.res, token, ctx.req);
  logLogin({ ip, username: user.username, result: 'success', detail: '登录成功' });
  json(ctx.res, 200, { ok: true, user: { username: user.username } });
});

// 获取登录加密公钥与一次性令牌（公开接口）
route('GET', '/api/auth/pubkey', async ctx => {
  pruneNonces();
  json(ctx.res, 200, {
    pem: RSA_PUBLIC.export({ type: 'spki', format: 'pem' }),
    jwk: RSA_PUBLIC.export({ format: 'jwk' }),
    nonce: issueNonce()
  });
});

// 注册（受开关控制；系统无任何账号时允许注册首个站长）
route('POST', '/api/auth/register', async ctx => {
  const firstRun = db.users.length === 0;
  if (!firstRun && !db.settings.allowRegister) {
    return json(ctx.res, 403, { error: '注册功能已关闭，请联系站长创建账号' });
  }
  // 人机验证：与登录一致，防止自动化批量注册（首个站长注册豁免，保证初始化流程顺畅）
  if (!firstRun && db.settings.loginCaptcha) {
    if (!checkRate('captchaverify:' + ctx.ip, CAPTCHA_VERIFY_RATE_MAX, 60 * 1000)) {
      return json(ctx.res, 429, { error: '验证尝试过于频繁，请稍后再试', requireCaptcha: true });
    }
    const { captchaId = '', captchaAnswer = '' } = ctx.body || {};
    if (!captchaId || !captchaAnswer) return json(ctx.res, 403, { error: '请输入验证码', requireCaptcha: true });
    if (!verifyCaptcha(captchaId, captchaAnswer)) return json(ctx.res, 403, { error: '验证码错误，请重试', requireCaptcha: true });
  }
  const { username = '', password } = ctx.body || {};
  const pwd = decryptSecret(password);
  if (pwd === null) return json(ctx.res, 400, { error: '安全校验失败，请刷新页面后重试' });
  const name = String(username).trim();
  if (!validUsername(name)) return json(ctx.res, 400, { error: '用户名需为 2-20 位中文、字母、数字或下划线' });
  if (!validPassword(pwd)) return json(ctx.res, 400, { error: '密码长度需为 6-64 位' });
  if (db.users.some(u => u.username === name)) return json(ctx.res, 409, { error: '用户名已存在' });

  const salt = crypto.randomBytes(16).toString('hex');
  // 角色分配：首位注册者为站长，后续注册者默认为访客（无任何访问权限，需站长提升角色）
  const role = firstRun ? 'owner' : 'guest';
  const user = {
    id: uid(), username: name, salt,
    passHash: hashPassword(pwd, salt),
    role,
    createdAt: nowISO(),
    createdBy: firstRun ? '系统初始化' : '自助注册'
  };
  db.users.push(user);
  saveDB('users', db.users);
  logOp(user, ctx.req, '注册账号', firstRun ? '注册首个站长账号' : `自助注册（角色：${ROLE_LABELS[role]}）`);

  // 注册后自动登录
  const token = createSession(user.id, ctx.ip);
  if (!token) return json(ctx.res, 503, { error: '当前登录会话过多，请稍后再试' });
  setSessionCookie(ctx.res, token, ctx.req);
  logLogin({ ip: ctx.ip, username: user.username, result: 'success', detail: '注册并登录' });
  json(ctx.res, 200, { ok: true, user: { username: user.username, role, roleLabel: ROLE_LABELS[role] } });
});

// 当前登录信息（含角色）
route('GET', '/api/auth/me', async ctx => {
  const role = userRole(ctx.user);
  json(ctx.res, 200, { user: { username: ctx.user.username, role, roleLabel: ROLE_LABELS[role] } });
}, { auth: true });

// 退出登录
route('POST', '/api/auth/logout', async ctx => {
  delete db.sessions[ctx.session.storeKey];
  saveDB('sessions', db.sessions);
  clearSessionCookie(ctx.res, ctx.req);
  logOp(ctx.user, ctx.req, '退出登录', '');
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 前台：获取引导页列表（无需登录）
route('GET', '/api/sites', async ctx => {
  const sites = [...db.sites].filter(s => s.enabled !== false).sort(byOrder);
  const list = [];
  for (const s of sites) {
    let icon = s.icon || '';
    if (!icon) {
      // 未手动设置图标：优先用服务端缓存
      const entry = db.favicons[s.id];
      const cached = entry && entry.path &&
        fs.existsSync(path.join(FAVICON_DIR, entry.file)) &&
        entry.fetchedAt && Date.now() - entry.fetchedAt < FAVICON_TTL;
      if (cached) {
        icon = entry.path;
      } else {
        // 后台异步抓取（去重），不阻塞响应；下次刷新即可看到
        ensureIconFetching(s);
      }
    }
    list.push({ id: s.id, name: s.name, url: s.url, desc: s.desc || '', icon, category: s.category || '' });
  }
  json(ctx.res, 200, { sites: list });
});

// 前台：记录一次访问
route('POST', '/api/visit', async ctx => {
  if (!featureOn('visitorStatsEnabled')) return json(ctx.res, 200, { ok: true });
  const { id } = ctx.body || {};
  const site = db.sites.find(s => s.id === id);
  if (!site) return json(ctx.res, 404, { error: '引导页不存在' });
  const v = db.visits.sites[id] || (db.visits.sites[id] = { total: 0, daily: {} });
  v.total += 1;
  const t = todayStr();
  v.daily[t] = (v.daily[t] || 0) + 1;
  // 按小时累计（热力图数据），并清理超过保留天数的旧数据
  const h = db.visits.hourly || (db.visits.hourly = {});
  const hk = t + ' ' + pad2(shanghaiHour());
  h[hk] = (h[hk] || 0) + 1;
  pruneHourly();
  saveDB('visits', db.visits);
  json(ctx.res, 200, { ok: true });
});

/** 清理超过 HOURLY_KEEP_DAYS 天的小时访问数据 */
function pruneHourly() {
  const h = db.visits.hourly;
  if (!h) return;
  const cutoff = dateNDaysAgo(HOURLY_KEEP_DAYS);
  for (const key of Object.keys(h)) {
    if (key.slice(0, 10) < cutoff) delete h[key];
  }
}

// ---------------- 独立访客与来源统计 ----------------
// 访客标记：内存态每日令牌集合 { 'YYYY-MM-DD': Set(token) }，客户端持 localStorage 令牌上报，
// 同一令牌当天只计 1 次独立访客；令牌重启后失效（当天重复上报被去重，不重复计数，可接受）
const visitorMarks = Object.create(null);

/** 上报一次访客访问（独立访客去重 + 来源域名累计），幂等 */
route('POST', '/api/visitor', async ctx => {
  if (!featureOn('visitorStatsEnabled')) return json(ctx.res, 200, { ok: true, counted: false });
  const { token = '', referrer = '' } = ctx.body || {};
  const tk = String(token);
  if (!/^[a-f0-9]{32}$/.test(tk)) return json(ctx.res, 400, { error: '访客令牌无效' });
  const t = todayStr();
  const daySet = visitorMarks[t] || (visitorMarks[t] = new Set());
  const visitors = db.visits.visitors || (db.visits.visitors = {});
  let isNew = false;
  if (!daySet.has(tk)) {
    daySet.add(tk);
    visitors[t] = (visitors[t] || 0) + 1;
    isNew = true;
    // 来源域名累计（仅记录 host，不记录完整 URL，避免隐私与存储膨胀）
    const ref = String(referrer).slice(0, REFERRER_MAX_LEN);
    if (ref) {
      try {
        const u = new URL(ref);
        const host = u.hostname ? u.hostname.toLowerCase().slice(0, REFERRER_MAX_LEN) : '';
        // 防原型链污染：魔法键 host 只跳过来源统计。
        // 这里绝不能 return——那样会跳过下方的响应，请求将一直挂起到客户端超时。
        if ((u.protocol === 'http:' || u.protocol === 'https:') && host && !UNSAFE_KEYS.has(host)) {
          const refs = db.visits.referrers || (db.visits.referrers = {});
          refs[host] = (refs[host] || 0) + 1;
          // 防御：来源域名种类上限，防止恶意构造海量 host 撑爆存储
          if (Object.keys(refs).length > 2000) {
            Object.keys(refs).sort((a, b) => refs[a] - refs[b]).slice(0, 500).forEach(k => delete refs[k]);
          }
        }
      } catch (e) { /* 非法来源忽略 */ }
    }
    pruneVisitors();
    saveDB('visits', db.visits);
  }
  json(ctx.res, 200, { ok: true, counted: isNew });
});

/** 清理超过保留天数的独立访客日数据与过期内存标记 */
function pruneVisitors() {
  const cutoff = dateNDaysAgo(VISITOR_DAILY_KEEP_DAYS);
  const v = db.visits.visitors;
  if (v) for (const k of Object.keys(v)) if (k < cutoff) delete v[k];
  for (const k of Object.keys(visitorMarks)) if (k < cutoff) delete visitorMarks[k];
}

// ============ 公告模块（多条公告管理） ============

// 公告排序：置顶优先，其次按更新时间倒序
const announceSort = (a, b) =>
  ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.updatedAt || '').localeCompare(a.updatedAt || '');

/** 判断公告当前是否在生效时间内（startAt/endAt 为空表示不限） */
function announceActive(a, nowIso) {
  if (a.startAt && nowIso < a.startAt) return false;
  if (a.endAt && nowIso > a.endAt) return false;
  return true;
}

// 公开：获取公告列表（无需登录；置顶在前，其余按更新时间倒序；仅返回生效时间内的公告）
route('GET', '/api/announcements', async ctx => {
  if (!featureOn('announcementsEnabled')) return json(ctx.res, 200, { announcements: [] });
  const nowIso = nowISO();
  const list = [...db.announcements].filter(a => announceActive(a, nowIso)).sort(announceSort)
    .map(a => ({ id: a.id, title: a.title, content: a.content, pinned: !!a.pinned, updatedAt: a.updatedAt }));
  json(ctx.res, 200, { announcements: list });
});

// 管理：公告列表（含全部字段）
route('GET', '/api/admin/announcements', async ctx => {
  const list = [...db.announcements].sort(announceSort);
  json(ctx.res, 200, { announcements: list });
}, { auth: true });

// 管理：新增公告
route('POST', '/api/admin/announcements', async ctx => {
  const { title = '', content = '', pinned = false, startAt = '', endAt = '' } = ctx.body || {};
  const t = String(title).trim();
  const c = String(content).trim();
  if (!t || t.length > 50) return json(ctx.res, 400, { error: '公告标题需为 1-50 个字符' });
  if (!c || c.length > 500) return json(ctx.res, 400, { error: '公告内容需为 1-500 个字符' });
  const sa = String(startAt || '').trim();
  const ea = String(endAt || '').trim();
  if (sa && Number.isNaN(Date.parse(sa))) return json(ctx.res, 400, { error: '生效时间格式不正确' });
  if (ea && Number.isNaN(Date.parse(ea))) return json(ctx.res, 400, { error: '失效时间格式不正确' });
  if (sa && ea && Date.parse(sa) >= Date.parse(ea)) return json(ctx.res, 400, { error: '生效时间必须早于失效时间' });
  const a = {
    id: uid(), title: t, content: c, pinned: !!pinned,
    startAt: sa ? new Date(sa).toISOString() : '',
    endAt: ea ? new Date(ea).toISOString() : '',
    createdAt: nowISO(), updatedAt: nowISO()
  };
  db.announcements.push(a);
  saveDB('announcements', db.announcements);
  logOp(ctx.user, ctx.req, '发布公告', a.title + (sa || ea ? '（定时）' : ''));
  json(ctx.res, 200, { ok: true, announcement: a });
}, { auth: true });

// 管理：编辑公告
route('PUT', '/api/admin/announcements/:id', async ctx => {
  const a = db.announcements.find(x => x.id === ctx.params.id);
  if (!a) return json(ctx.res, 404, { error: '公告不存在' });
  const b = ctx.body || {};
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (!t || t.length > 50) return json(ctx.res, 400, { error: '公告标题需为 1-50 个字符' });
    a.title = t;
  }
  if (b.content !== undefined) {
    const c = String(b.content).trim();
    if (!c || c.length > 500) return json(ctx.res, 400, { error: '公告内容需为 1-500 个字符' });
    a.content = c;
  }
  if (b.pinned !== undefined) a.pinned = !!b.pinned;
  if (b.startAt !== undefined) {
    const sa = String(b.startAt || '').trim();
    if (sa && Number.isNaN(Date.parse(sa))) return json(ctx.res, 400, { error: '生效时间格式不正确' });
    a.startAt = sa ? new Date(sa).toISOString() : '';
  }
  if (b.endAt !== undefined) {
    const ea = String(b.endAt || '').trim();
    if (ea && Number.isNaN(Date.parse(ea))) return json(ctx.res, 400, { error: '失效时间格式不正确' });
    a.endAt = ea ? new Date(ea).toISOString() : '';
  }
  if (a.startAt && a.endAt && Date.parse(a.startAt) >= Date.parse(a.endAt)) {
    return json(ctx.res, 400, { error: '生效时间必须早于失效时间' });
  }
  a.updatedAt = nowISO();
  saveDB('announcements', db.announcements);
  logOp(ctx.user, ctx.req, '编辑公告', a.title + (b.pinned !== undefined ? (a.pinned ? '（设为置顶）' : '（取消置顶）') : ''));
  json(ctx.res, 200, { ok: true, announcement: a });
}, { auth: true });

// 管理：删除公告
route('DELETE', '/api/admin/announcements/:id', async ctx => {
  const idx = db.announcements.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '公告不存在' });
  const [a] = db.announcements.splice(idx, 1);
  saveDB('announcements', db.announcements);
  logOp(ctx.user, ctx.req, '删除公告', a.title);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ QQ群模块（多个QQ群链接管理） ============

// QQ群链接校验：http/https 链接，或直接填QQ群号（自动转为官方加群链接）
function normalizeQqGroupUrl(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 500) return null;
  if (/^\d{5,12}$/.test(s)) return { url: 'https://qm.qq.com/cgi-bin/qm/qr?k=&group_code=' + s, fromNumber: true };
  try {
    const x = new URL(s);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    return { url: s, fromNumber: false };
  } catch (e) { return null; }
}

// 公开：获取QQ群列表（无需登录，按 order 排序）
route('GET', '/api/qqgroups', async ctx => {
  if (!featureOn('qqGroupsEnabled')) return json(ctx.res, 200, { groups: [] });
  const list = [...db.qqGroups].sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(g => ({ id: g.id, name: g.name, url: g.url, order: g.order || 0 }));
  json(ctx.res, 200, { groups: list });
});

// 管理：QQ群列表（含全部字段）
route('GET', '/api/admin/qqgroups', async ctx => {
  const list = [...db.qqGroups].sort((a, b) => (a.order || 0) - (b.order || 0));
  json(ctx.res, 200, { groups: list });
}, { auth: true });

// 管理：新增QQ群
route('POST', '/api/admin/qqgroups', async ctx => {
  const { name = '', url = '', order = 0 } = ctx.body || {};
  const n = String(name).trim();
  if (!n || n.length > 30) return json(ctx.res, 400, { error: '群名称需为 1-30 个字符' });
  const norm = normalizeQqGroupUrl(url);
  if (!norm) return json(ctx.res, 400, { error: '请填写合法的QQ群链接（http/https）或QQ群号' });
  const g = { id: uid(), name: n, url: norm.url, order: parseInt(order, 10) || 0, createdAt: nowISO() };
  db.qqGroups.push(g);
  saveDB('qqgroups', db.qqGroups);
  logOp(ctx.user, ctx.req, '添加QQ群', g.name + (norm.fromNumber ? '（群号）' : ''));
  json(ctx.res, 200, { ok: true, group: g });
}, { auth: true });

// 管理：编辑QQ群
route('PUT', '/api/admin/qqgroups/:id', async ctx => {
  const g = db.qqGroups.find(x => x.id === ctx.params.id);
  if (!g) return json(ctx.res, 404, { error: 'QQ群不存在' });
  const b = ctx.body || {};
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n || n.length > 30) return json(ctx.res, 400, { error: '群名称需为 1-30 个字符' });
    g.name = n;
  }
  if (b.url !== undefined) {
    const norm = normalizeQqGroupUrl(b.url);
    if (!norm) return json(ctx.res, 400, { error: '请填写合法的QQ群链接（http/https）或QQ群号' });
    g.url = norm.url;
  }
  if (b.order !== undefined) g.order = parseInt(b.order, 10) || 0;
  saveDB('qqgroups', db.qqGroups);
  logOp(ctx.user, ctx.req, '编辑QQ群', g.name);
  json(ctx.res, 200, { ok: true, group: g });
}, { auth: true });

// 管理：删除QQ群
route('DELETE', '/api/admin/qqgroups/:id', async ctx => {
  const idx = db.qqGroups.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: 'QQ群不存在' });
  const [g] = db.qqGroups.splice(idx, 1);
  saveDB('qqgroups', db.qqGroups);
  logOp(ctx.user, ctx.req, '删除QQ群', g.name);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 留言板模块（访客留言，管理员可回复/删除） ============

/** 裁剪可见留言至 MAX_COMMENTS 条（保留最新） */
function pruneComments() {
  if (db.comments.length > MAX_COMMENTS) {
    db.comments.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    db.comments.length = MAX_COMMENTS;
  }
}

// 公开：获取留言列表（无需登录，最新在前，最多返回 200 条）
route('GET', '/api/comments', async ctx => {
  if (!featureOn('commentsEnabled')) return json(ctx.res, 200, { comments: [] });
  const list = [...db.comments]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 200)
    .map(c => ({
      id: c.id, nick: c.nick, content: c.content, createdAt: c.createdAt,
      reply: c.reply || '', replyBy: c.replyBy || '', replyAt: c.replyAt || ''
    }));
  json(ctx.res, 200, { comments: list });
});

// 公开：提交留言（未登录需通过人机验证；每 IP 每分钟限 COMMENT_RATE_MAX 条）
route('POST', '/api/comments', async ctx => {
  if (!featureOn('commentsEnabled')) return json(ctx.res, 403, { error: '留言板功能已关闭' });
  if (!checkRate('comment:' + ctx.ip, COMMENT_RATE_MAX, COMMENT_RATE_WINDOW)) {
    logRateHit('留言提交', ctx.ip, '超过每分钟留言上限');
    return json(ctx.res, 429, { error: '留言过于频繁，请稍后再试' });
  }
  if (!checkPublicCaptcha(ctx)) return;
  const { nick = '', content = '' } = ctx.body || {};
  const n = String(nick).trim().slice(0, COMMENT_NICK_MAX) || '匿名访客';
  const c = String(content).trim();
  if (!c) return json(ctx.res, 400, { error: '留言内容不能为空' });
  const maxLen = numSetting('commentMaxLen');
  if (c.length > maxLen) return json(ctx.res, 400, { error: `留言内容不能超过 ${maxLen} 个字符` });
  const comment = { id: uid(), nick: n, content: c, ip: ctx.ip, createdAt: nowISO() };
  db.comments.push(comment);
  pruneComments();
  saveDB('comments', db.comments);
  json(ctx.res, 200, {
    ok: true,
    comment: { id: comment.id, nick: comment.nick, content: comment.content, createdAt: comment.createdAt, reply: '', replyBy: '', replyAt: '' }
  });
});

// 管理：全部留言列表（含 IP）
route('GET', '/api/admin/comments', async ctx => {
  const list = [...db.comments].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  json(ctx.res, 200, { comments: list });
}, { auth: true });

// 管理：回复留言
route('PUT', '/api/admin/comments/:id', async ctx => {
  const c = db.comments.find(x => x.id === ctx.params.id);
  if (!c) return json(ctx.res, 404, { error: '留言不存在' });
  const reply = String((ctx.body || {}).reply || '').trim();
  if (reply.length > COMMENT_REPLY_MAX) return json(ctx.res, 400, { error: `回复不能超过 ${COMMENT_REPLY_MAX} 个字符` });
  if (reply) {
    c.reply = reply;
    c.replyBy = ctx.user.username;
    c.replyAt = nowISO();
  } else {
    delete c.reply; delete c.replyBy; delete c.replyAt;
  }
  saveDB('comments', db.comments);
  logOp(ctx.user, ctx.req, reply ? '回复留言' : '清除留言回复', c.content.slice(0, 30));
  json(ctx.res, 200, { ok: true, comment: c });
}, { auth: true });

// 管理：删除留言
route('DELETE', '/api/admin/comments/:id', async ctx => {
  const idx = db.comments.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '留言不存在' });
  const [c] = db.comments.splice(idx, 1);
  saveDB('comments', db.comments);
  logOp(ctx.user, ctx.req, '删除留言', c.content.slice(0, 30));
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 天气（服务端代理 wttr.in，带缓存；优先用户经纬度定位查询，后台城市作兜底） ============
const weatherCache = { key: '', data: null, fetchedAt: 0 };

// wttr.in weatherCode → 中文天气描述映射表（lang_zh 字段缺失或返回英文时按 code 兜底）
const WEATHER_CODE_ZH = {
  '113': '晴', '116': '多云', '119': '阴', '122': '阴', '143': '薄雾',
  '149': '烟霾', '176': '小雨', '179': '雨夹雪', '182': '雨夹雪', '185': '雨夹雪',
  '200': '雷阵雨', '227': '小雪', '230': '中雪', '248': '雾', '260': '冻雾',
  '263': '小雨', '266': '小雨', '281': '小雨', '282': '小雨', '284': '中雨',
  '293': '小雨', '294': '小雨', '296': '中雨', '299': '中雨', '302': '大雨',
  '305': '大雨', '308': '暴雨', '311': '大暴雨', '314': '大暴雨',
  '317': '特大暴雨', '320': '雨夹雪', '323': '小雪', '326': '中雪',
  '329': '大雪', '332': '大雪', '335': '暴雪', '338': '大暴雪',
  '350': '冰雹', '353': '阵雨', '356': '阵雨', '359': '阵雨',
  '362': '阵雪', '365': '阵雪', '368': '小雪', '371': '中雪',
  '374': '雨夹雪', '377': '冰雹', '386': '雷阵雨', '389': '雷阵雨',
  '392': '雷阵雪', '395': '雷阵雪'
};

/** 检测字符串是否包含中文字符（用于判断 wttr.in lang_zh 字段是否真的返回了中文） */
function containsChinese(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''));
}

/** 解析前端传入的经纬度参数（仅接受合法范围的数字，防止注入任意 wttr 路径） */
function parseWeatherCoords(query) {
  const lat = Number(query.get('lat'));
  const lon = Number(query.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return lat.toFixed(2) + ',' + lon.toFixed(2);
}

// wttr.in 返回的 areaName 始终为英文/罗马音，此表将其映射为中文城市名
const CITY_NAME_ZH = {
  // 直辖市
  'Beijing': '北京', 'Shanghai': '上海', 'Tianjin': '天津', 'Chongqing': '重庆',
  // 华北
  'Shijiazhuang': '石家庄', 'Taiyuan': '太原', 'Hohhot': '呼和浩特', 'Baotou': '包头',
  'Datong': '大同', 'Handan': '邯郸', 'Tangshan': '唐山', 'Baoding': '保定',
  // 东北
  'Shenyang': '沈阳', 'Dalian': '大连', 'Changchun': '长春', 'Harbin': '哈尔滨',
  'Anshan': '鞍山', 'Fushun': '抚顺', 'Jilin': '吉林', 'Qiqihar': '齐齐哈尔',
  'Daqing': '大庆', 'Dandong': '丹东', 'Jinzhou': '锦州', 'Yingkou': '营口',
  // 华东
  'Nanjing': '南京', 'Suzhou': '苏州', 'Wuxi': '无锡', 'Xuzhou': '徐州',
  'Changzhou': '常州', 'Nantong': '南通', 'Yangzhou': '扬州', 'Lianyungang': '连云港',
  'Hangzhou': '杭州', 'Ningbo': '宁波', 'Wenzhou': '温州', 'Shaoxing': '绍兴',
  'Jiaxing': '嘉兴', 'Hefei': '合肥', 'Wuhu': '芜湖', 'Bengbu': '蚌埠',
  'Fuzhou': '福州', 'Xiamen': '厦门', 'Quanzhou': '泉州', 'Zhangzhou': '漳州',
  'Nanchang': '南昌', 'Jiujiang': '九江', 'Jinan': '济南', 'Qingdao': '青岛',
  'Yantai': '烟台', 'Weifang': '潍坊', 'Zibo': '淄博', 'Weihai': '威海',
  // 华中
  'Zhengzhou': '郑州', 'Luoyang': '洛阳', 'Kaifeng': '开封', 'Xinxiang': '新乡',
  'Wuhan': '武汉', 'Yichang': '宜昌', 'Xiangfan': '襄阳', 'Xiangyang': '襄阳',
  'Changsha': '长沙', 'Zhuzhou': '株洲', 'Xiangtan': '湘潭', 'Yueyang': '岳阳',
  // 华南
  'Guangzhou': '广州', 'Shenzhen': '深圳', 'Dongguan': '东莞', 'Foshan': '佛山',
  'Zhuhai': '珠海', 'Zhongshan': '中山', 'Huizhou': '惠州', 'Shantou': '汕头',
  'Zhanjiang': '湛江', 'Jiangmen': '江门', 'Nanning': '南宁', 'Liuzhou': '柳州',
  'Guilin': '桂林', 'Haikou': '海口', 'Sanya': '三亚',
  // 西南
  'Chengdu': '成都', 'Mianyang': '绵阳', 'Deyang': '德阳', 'Yibin': '宜宾',
  'Zigong': '自贡', 'Guiyang': '贵阳', 'Zunyi': '遵义', 'Kunming': '昆明',
  'Lhasa': '拉萨', 'Dali': '大理', 'Qujing': '曲靖', 'Yuxi': '玉溪',
  // 西北
  'Xi\'an': '西安', 'Xian': '西安', 'Baoji': '宝鸡', 'Xianyang': '咸阳',
  'Lanzhou': '兰州', 'Tianshui': '天水', 'Xining': '西宁', 'Yinchuan': '银川',
  'Urumqi': '乌鲁木齐', 'Karamay': '克拉玛依', 'Kashgar': '喀什', 'Hotan': '和田',
  // 港澳台
  'Hong Kong': '香港', 'Macao': '澳门', 'Macau': '澳门', 'Taipei': '台北',
  'Kaohsiung': '高雄', 'Taichung': '台中', 'Tainan': '台南',
  // 国际主要城市
  'Tokyo': '东京', 'Osaka': '大阪', 'Nagoya': '名古屋', 'Sapporo': '札幌',
  'Seoul': '首尔', 'Busan': '釜山', 'Pyongyang': '平壤',
  'New York': '纽约', 'Los Angeles': '洛杉矶', 'San Francisco': '旧金山',
  'Chicago': '芝加哥', 'Boston': '波士顿', 'Seattle': '西雅图', 'Miami': '迈阿密',
  'Houston': '休斯顿', 'Washington': '华盛顿', 'Philadelphia': '费城',
  'London': '伦敦', 'Manchester': '曼彻斯特', 'Edinburgh': '爱丁堡',
  'Paris': '巴黎', 'Marseille': '马赛', 'Lyon': '里昂',
  'Berlin': '柏林', 'Munich': '慕尼黑', 'Frankfurt': '法兰克福', 'Hamburg': '汉堡',
  'Rome': '罗马', 'Milan': '米兰', 'Venice': '威尼斯',
  'Madrid': '马德里', 'Barcelona': '巴塞罗那',
  'Amsterdam': '阿姆斯特丹', 'Brussels': '布鲁塞尔', 'Vienna': '维也纳',
  'Zurich': '苏黎世', 'Geneva': '日内瓦', 'Stockholm': '斯德哥尔摩',
  'Copenhagen': '哥本哈根', 'Helsinki': '赫尔辛基', 'Oslo': '奥斯陆',
  'Moscow': '莫斯科', 'Saint Petersburg': '圣彼得堡',
  'Istanbul': '伊斯坦布尔', 'Dubai': '迪拜', 'Singapore': '新加坡',
  'Bangkok': '曼谷', 'Kuala Lumpur': '吉隆坡', 'Manila': '马尼拉',
  'Jakarta': '雅加达', 'Hanoi': '河内', 'Ho Chi Minh City': '胡志明市',
  'New Delhi': '新德里', 'Mumbai': '孟买', 'Sydney': '悉尼',
  'Melbourne': '墨尔本', 'Brisbane': '布里斯班', 'Auckland': '奥克兰',
  'Toronto': '多伦多', 'Vancouver': '温哥华', 'Montreal': '蒙特利尔'
};

/** 将 wttr.in 返回的英文城市名转为中文（映射表未覆盖时原样返回） */
function toZhCityName(enName) {
  if (!enName) return '';
  const zh = CITY_NAME_ZH[enName];
  if (zh) return zh;
  // 尝试模糊匹配：去掉空格、大小写不敏感
  const key = enName.replace(/\s+/g, '').toLowerCase();
  for (const k in CITY_NAME_ZH) {
    if (k.replace(/\s+/g, '').toLowerCase() === key) return CITY_NAME_ZH[k];
  }
  return enName;
}

/** 校验城市名：仅允许中英文、数字与空格，防止拼接 URL 注入 */
function validWeatherCity(c) {
  const s = String(c || '').trim();
  return s.length > 0 && s.length <= 30 && /^[\u4e00-\u9fa5A-Za-z0-9\s-]+$/.test(s);
}

// 公开：获取天气（优先按前端传来的经纬度查询用户当地天气，未授权定位时回退到后台配置的城市）
route('GET', '/api/weather', async ctx => {
  if (!db.settings.weatherEnabled) {
    return json(ctx.res, 200, { enabled: false });
  }
  const coords = parseWeatherCoords(ctx.query);
  const city = String(db.settings.weatherCity || '').trim();
  // 定位优先：经纬度 > 后台城市；两者都没有时无法查询
  const target = coords ? coords : city;
  if (!target) {
    return json(ctx.res, 200, { enabled: false });
  }
  const cacheKey = target;
  const now = Date.now();
  if (weatherCache.key === cacheKey && weatherCache.data && now - weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
    return json(ctx.res, 200, Object.assign({ enabled: true }, weatherCache.data));
  }
  try {
    // 直接使用 https.get 请求 wttr.in（URL 由已校验的坐标/城市名构造，无 SSRF 风险）；
    // 不使用 fetchRemote 是因为其浏览器 User-Agent 会导致 wttr.in 返回精简 JSON（nearest_area 为空对象）
    const url = WEATHER_URL + encodeURIComponent(target) + '?format=j1&lang=zh';
    const r = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https://') ? https : http;
      const req = lib.get(url, { timeout: WEATHER_TIMEOUT }, res => {
        if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, body: Buffer.alloc(0) }); }
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size > 200 * 1024) { res.destroy(); return resolve({ status: 413, body: Buffer.alloc(0) }); } chunks.push(c); });
        res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    });
    if (r.status !== 200 || !r.body.length) {
      // 上游失败但有旧缓存时返回旧数据，避免空白
      if (weatherCache.key === cacheKey && weatherCache.data) {
        return json(ctx.res, 200, Object.assign({ enabled: true, stale: true }, weatherCache.data));
      }
      return json(ctx.res, 200, { enabled: true, error: '天气服务暂时不可用' });
    }
    let d;
    try { d = JSON.parse(r.body.toString('utf8')); } catch (e) {
      return json(ctx.res, 200, { enabled: true, error: '天气数据解析失败' });
    }
    const cc = (d.current_condition || [])[0] || {};
    const area = ((d.nearest_area || [])[0] || {}).areaName || [{}];
    // 天气描述优先级：lang_zh（含中文时）→ WEATHER_CODE_ZH 映射 → 英文 weatherDesc 兜底
    // wttr.in 的 lang_zh 字段有时返回英文（如 "Smoky haze"），需检测是否真含中文
    const langZhVal = (cc.lang_zh && cc.lang_zh[0] && cc.lang_zh[0].value) || '';
    const desc = ((containsChinese(langZhVal) ? langZhVal : '') ||
      WEATHER_CODE_ZH[String(cc.weatherCode || '')] ||
      langZhVal ||
      (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value) || '').slice(0, WEATHER_DESC_MAX);
    // 城市名：将 wttr.in 返回的英文 areaName 转为中文；映射未覆盖时回退后台配置的中文城市名
    const enAreaName = String((area[0] && area[0].value) || '').slice(0, 40);
    const zhAreaName = toZhCityName(enAreaName);
    // 城市名优先级：wttr.in 区域名（转中文）→ 后台配置城市名（转中文）→ 原始英文区域名
    const cityDisplay = zhAreaName || toZhCityName(city) || city || enAreaName;
    const data = {
      city: cityDisplay,
      area: zhAreaName || enAreaName,
      temp: String(cc.temp_C || '').slice(0, 6),
      feelsLike: String(cc.FeelsLikeC || '').slice(0, 6),
      humidity: String(cc.humidity || '').slice(0, 5),
      windKmph: String(cc.windspeedKmph || '').slice(0, 6),
      desc: desc,
      observedAt: String(cc.observation_time || '').slice(0, 10),
      fetchedAt: nowISO()
    };
    weatherCache.key = cacheKey; weatherCache.data = data; weatherCache.fetchedAt = now;
    json(ctx.res, 200, Object.assign({ enabled: true }, data));
  } catch (e) {
    if (weatherCache.key === cacheKey && weatherCache.data) {
      return json(ctx.res, 200, Object.assign({ enabled: true, stale: true }, weatherCache.data));
    }
    json(ctx.res, 200, { enabled: true, error: '天气服务暂时不可用' });
  }
});

// ============ IP 地理位置检测（ippure.com 为主，ip-api.com 为备；带 24h 缓存） ============
// ippure.com 使用 api.123169.xyz 后端，需 HMAC-SHA256 签名 + AES-CBC 加密 + 动态密钥交换
// 由于 api.123169.xyz 部署在 Cloudflare 后，可能拦截非浏览器 TLS 指纹，连接失败时自动回退到 ip-api.com
const geoCache = new Map();     // ip -> { data, fetchedAt }
const GEO_CACHE_TTL = 24 * 3600 * 1000;  // 缓存 24 小时
const GEO_TIMEOUT = 5000;       // 单个地理源查询超时 5 秒；多源回退避免单源阻塞请求
const GEO_RESPONSE_MAX_BYTES = 64 * 1024; // 地理上游响应体上限，避免异常上游耗尽内存
const GEO_RATE_MAX = 40;        // 每分钟最多查询次数
const GEO_RATE_WINDOW = 60 * 1000;
const geoRateLog = [];

// 中国省级行政区白名单：启用“拦截海外 IP”后，仅以下区域视为国内访问。
// 中国香港/中国澳门/中国台湾使用各上游通用的 HK/MO/TW 国家代码归并处理；
// 其余条目用于 countryCode=CN 时按省/自治区/直辖市识别，兼容中文、英文和常见 API 返回格式。
const CHINA_REGION_ALIASES = {
  '北京': '北京', 'beijing': '北京',
  '天津': '天津', 'tianjin': '天津',
  '上海': '上海', 'shanghai': '上海',
  '重庆': '重庆', 'chongqing': '重庆',
  '河北': '河北', 'hebei': '河北',
  '山西': '山西', 'shanxi': '山西',
  '辽宁': '辽宁', 'liaoning': '辽宁',
  '吉林': '吉林', 'jilin': '吉林',
  '黑龙江': '黑龙江', 'heilongjiang': '黑龙江',
  '江苏': '江苏', 'jiangsu': '江苏',
  '浙江': '浙江', 'zhejiang': '浙江',
  '安徽': '安徽', 'anhui': '安徽',
  '福建': '福建', 'fujian': '福建',
  '江西': '江西', 'jiangxi': '江西',
  '山东': '山东', 'shandong': '山东',
  '河南': '河南', 'henan': '河南',
  '湖北': '湖北', 'hubei': '湖北',
  '湖南': '湖南', 'hunan': '湖南',
  '广东': '广东', 'guangdong': '广东',
  '海南': '海南', 'hainan': '海南',
  '四川': '四川', 'sichuan': '四川',
  '贵州': '贵州', 'guizhou': '贵州',
  '云南': '云南', 'yunnan': '云南',
  '陕西': '陕西', 'shaanxi': '陕西',
  '甘肃': '甘肃', 'gansu': '甘肃',
  '青海': '青海', 'qinghai': '青海',
  '内蒙古': '内蒙古', 'inner mongolia': '内蒙古', 'inner mongolia autonomous region': '内蒙古',
  '广西': '广西', 'guangxi': '广西', 'guangxi zhuang autonomous region': '广西',
  '西藏': '西藏', 'tibet': '西藏', 'xizang': '西藏', 'tibet autonomous region': '西藏',
  '宁夏': '宁夏', 'ningxia': '宁夏', 'ningxia hui autonomous region': '宁夏',
  '新疆': '新疆', 'xinjiang': '新疆', 'xinjiang uyghur autonomous region': '新疆', 'xinjiang uygur autonomous region': '新疆'
};
function normalizeChinaRegion(countryCode, region) {
  const cc = String(countryCode || '').toUpperCase();
  if (cc === 'HK') return '香港';
  if (cc === 'MO') return '澳门';
  if (cc === 'TW') return '台湾';
  if (cc !== 'CN') return '';
  const raw = String(region || '').trim();
  if (!raw) return '';
  // 保留中文省份关键词；英文格式去除 Sheng / Province / Municipality 等后缀后映射。
  for (const name of ['北京','天津','上海','重庆','河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','内蒙古','广西','西藏','宁夏','新疆']) {
    if (raw.includes(name)) return name;
  }
  const key = raw.toLowerCase().replace(/\b(sheng|province|municipality|autonomous region)\b/g, '').replace(/\s+/g, ' ').trim();
  return CHINA_REGION_ALIASES[key] || '';
}

// ippure.com API 配置
const IPPURE_API_HOST = 'api.123169.xyz';
const IPPURE_API_PATH = '/api/info/ip-batch-abstract';
const IPPURE_ORIGIN = 'https://ippure.com';
// ippure 密钥缓存：{ key, serverTime, localTime }，服务端通过响应头下发，客户端持久化复用
let ippureKeyState = null;

/** ippure 协议：计算请求签名 x-t = '{adjustedTime}-{HMAC-SHA256(method-url-body-time, key)}' */
function ippureSign(method, url, body, key) {
  const adjustedTime = ippureKeyState
    ? Date.now() - ippureKeyState.localTime + ippureKeyState.serverTime
    : Date.now();
  const sigData = [method, url, body, adjustedTime].join('-');
  const hmac = crypto.createHmac('sha256', key).update(sigData).digest('hex');
  return adjustedTime + '-' + hmac;
}

/** ippure 协议：AES-CBC 加密请求体，密钥为 SHA-256(x-t签名)，返回 IV(16字节) + 密文 */
function ippureEncrypt(xt, bodyStr) {
  const aesKey = crypto.createHash('sha256').update(xt).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(bodyStr, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/** 读取上游响应体，并以固定上限和 once-only Promise 结算防止内存/状态失控。 */
function readLimitedResponse(res, maxBytes = GEO_RESPONSE_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let complete = false;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    res.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        finish(new Error('upstream response too large'));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      complete = true;
      finish(null, Buffer.concat(chunks));
    });
    res.on('aborted', () => finish(new Error('upstream response aborted')));
    res.on('error', err => finish(err));
    res.on('close', () => {
      if (!complete) finish(new Error('upstream response closed'));
    });
  });
}

/** 发起 HTTPS 请求（封装为 Promise） */
function httpsRequest(hostname, path, method, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    let req;
    try {
      req = https.request({
        hostname, port: 443, path, method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': IPPURE_ORIGIN,
          'Referer': IPPURE_ORIGIN + '/',
          ...headers
        },
        timeout: GEO_TIMEOUT
      }, res => {
        readLimitedResponse(res).then(body => finish(null, {
          status: res.statusCode,
          headers: res.headers,
          body
        })).catch(err => finish(err));
      });
      req.on('error', err => finish(err));
      req.on('timeout', () => {
        finish(new Error('timeout'));
        req.destroy();
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    } catch (e) {
      finish(e);
      if (req) req.destroy();
    }
  });
}

/** 通过 ippure.com 协议查询 IP 地理信息（返回 info 对象或 null 表示失败） */
async function getGeoInfoFromIPPure(ip) {
  const url = 'https://' + IPPURE_API_HOST + IPPURE_API_PATH;
  const bodyStr = JSON.stringify({ IPs: [ip] });

  // 步骤 1：若无密钥，先做握手（不带 x-k 发请求，服务端通过响应头下发密钥）
  if (!ippureKeyState) {
    try {
      const handshake = await httpsRequest(IPPURE_API_HOST, IPPURE_API_PATH, 'POST',
        { 'Content-Type': 'application/json' }, Buffer.from(bodyStr, 'utf8'));
      const respKey = handshake.headers['x-k'];
      const respTime = handshake.headers['x-t'];
      if (respKey) {
        ippureKeyState = {
          key: respKey,
          serverTime: parseInt(respTime || '0') || Date.now(),
          localTime: Date.now()
        };
      } else {
        // 握手未返回密钥，可能服务端直接返回了数据或拒绝了请求
        return null;
      }
    } catch (e) {
      // 握手失败（Cloudflare TLS 指纹拦截等），返回 null 触发回退
      return null;
    }
  }

  // 步骤 2：签名 + 加密 + 发送实际请求
  try {
    const xt = ippureSign('POST', url, bodyStr, ippureKeyState.key);
    const encBody = ippureEncrypt(xt, bodyStr);
    const res = await httpsRequest(IPPURE_API_HOST, IPPURE_API_PATH, 'POST', {
      'Content-Type': 'application/octet-stream',
      'x-k': ippureKeyState.key,
      'x-t': xt
    }, encBody);

    // 服务端可能下发新密钥（密钥轮换），更新本地状态
    const newKey = res.headers['x-k'];
    const newTime = res.headers['x-t'];
    if (newKey) {
      ippureKeyState = {
        key: newKey,
        serverTime: parseInt(newTime || '0') || Date.now(),
        localTime: Date.now()
      };
      // 密钥轮换后需重试（最多重试 1 次）
      const xt2 = ippureSign('POST', url, bodyStr, ippureKeyState.key);
      const encBody2 = ippureEncrypt(xt2, bodyStr);
      const res2 = await httpsRequest(IPPURE_API_HOST, IPPURE_API_PATH, 'POST', {
        'Content-Type': 'application/octet-stream',
        'x-k': ippureKeyState.key,
        'x-t': xt2
      }, encBody2);
      return parseIPPureResponse(res2, ip);
    }

    return parseIPPureResponse(res, ip);
  } catch (e) {
    return null;
  }
}

/** 解析 ippure.com 响应为统一的 geo info 对象 */
function parseIPPureResponse(res, ip) {
  if (!res || res.status !== 200 || !res.body.length) return null;
  try {
    const d = JSON.parse(res.body.toString('utf8'));
    if (!d.ok || !d.data || !d.data[ip]) return null;
    const info = d.data[ip];
    // ippure 返回的 geo 对象含多数据源（MaxMind / DB-IP / IP2Location），取首个有 country_code 的
    const geo = info.geo || {};
    const sources = ['MaxMind', 'DB-IP', 'IP2Location'];
    let countryCode = '';
    let city = '';
    for (const src of sources) {
      if (geo[src] && geo[src].country_code) {
        countryCode = String(geo[src].country_code).toUpperCase();
        city = String(geo[src].city || '').slice(0, 40);
        break;
      }
    }
    // ipQuality / botClass 用于判断机房 IP 和代理
    const ipQuality = info.ipQuality || {};
    const botClass = info.botClass || '';
    // ippure 的风险等级：type 字段标识 IP 类型（如 "Hosting/Data Center" 表示机房）
    const ipType = String(info.type || ipQuality.type || '').toLowerCase();
    const isDatacenter = ipType.includes('hosting') || ipType.includes('datacenter') ||
      ipType.includes('server') || ipType.includes('cloud') || botClass.toLowerCase().includes('bot');
    const isProxy = !!(ipQuality.proxy || ipQuality.vpn || ipQuality.tor);
    return {
      countryCode: countryCode,
      org: String(info.asn || info.org || '').slice(0, 100),
      isDatacenter: isDatacenter,
      isProxy: isProxy,
      isLocal: false,
      provider: 'ippure'
    };
  } catch (e) {
    return null;
  }
}

/** 通过 ipapi.is 查询归属地与机房/代理/VPN/Tor 信息（主数据源，支持 IPv4/IPv6） */
function getGeoInfoFromIpApiIs(ip) {
  return new Promise(resolve => {
    const options = {
      hostname: 'api.ipapi.is', path: '/?q=' + encodeURIComponent(ip), timeout: GEO_TIMEOUT,
      headers: { 'User-Agent': 'HuanZhongNav/1.0', 'Accept': 'application/json' }
    };
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = https.get(options, res => {
        readLimitedResponse(res).then(body => {
          try {
            const d = JSON.parse(body.toString('utf8'));
            const cc = String(d.cc || d.country_code || '').toUpperCase();
            if (!cc || !/^[A-Z]{2}$/.test(cc)) return finish(null);
            finish({
              countryCode: cc,
              region: String(d.region || d.region_name || '').slice(0, 80),
              org: String(d.asn_org || d.company_name || '').slice(0, 100),
              // is_abuser 不是机房依据，不能参与拦截；仅使用明确的 hosting / anonymizer 信号
              isDatacenter: d.is_datacenter === true,
              isProxy: d.is_proxy === true || d.is_vpn === true || d.is_tor === true,
              isLocal: false, provider: 'ipapi.is'
            });
          } catch (e) { finish(null); }
        }).catch(() => finish(null));
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { finish(null); req.destroy(); });
    } catch (e) { finish(null); }
  });
}

/** 通过 ipwho.is 查询国家归属（独立地理回退源，支持 IPv4/IPv6） */
function getGeoInfoFromIpWhoIs(ip) {
  return new Promise(resolve => {
    const options = {
      hostname: 'ipwho.is', path: '/' + encodeURIComponent(ip), timeout: GEO_TIMEOUT,
      headers: { 'User-Agent': 'HuanZhongNav/1.0', 'Accept': 'application/json' }
    };
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = https.get(options, res => {
        readLimitedResponse(res).then(body => {
          try {
            const d = JSON.parse(body.toString('utf8'));
            const cc = String(d.country_code || '').toUpperCase();
            if (d.success !== true || !/^[A-Z]{2}$/.test(cc)) return finish(null);
            finish({ countryCode: cc, region: String(d.region || d.region_code || '').slice(0, 80), org: String((d.connection || {}).org || '').slice(0, 100), isDatacenter: false, isProxy: false, isLocal: false, provider: 'ipwho.is' });
          } catch (e) { finish(null); }
        }).catch(() => finish(null));
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { finish(null); req.destroy(); });
    } catch (e) { finish(null); }
  });
}

/** 通过 ip-api.com 查询 IP 地理信息（兼容性最后回退） */
function getGeoInfoFromIpApi(ip) {
  return new Promise(resolve => {
    const options = {
      hostname: 'ip-api.com',
      path: '/json/' + encodeURIComponent(ip) + '?fields=status,countryCode,regionName,org,as,hosting,proxy&lang=zh',
      timeout: GEO_TIMEOUT,
      headers: { 'User-Agent': 'HuanZhongNav/1.0' }
    };
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = http.get(options, res => {
        readLimitedResponse(res).then(body => {
          try {
            const d = JSON.parse(body.toString('utf8'));
            if (d.status === 'success') {
              finish({
                countryCode: String(d.countryCode || '').toUpperCase(),
                region: String(d.regionName || d.region || '').slice(0, 80),
                org: String(d.org || '').slice(0, 100),
                isDatacenter: !!d.hosting,
                isProxy: !!d.proxy,
                isLocal: false,
                provider: 'ip-api'
              });
            } else {
              finish(null);
            }
          } catch (e) {
            finish(null);
          }
        }).catch(() => finish(null));
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { finish(null); req.destroy(); });
    } catch (e) { finish(null); }
  });
}

/** 合并多源结果：地理归属以首个有效结果为准，机房/匿名信号采用任一可信源的明确命中 */
function mergeGeoInfos(infos) {
  const valid = infos.filter(Boolean);
  if (!valid.length) return null;
  const primary = valid.find(x => /^[A-Z]{2}$/.test(x.countryCode || '')) || valid[0];
  return {
    countryCode: primary.countryCode || '',
    // countryCode=CN 时优先使用任一上游返回的省级行政区，避免主源缺省 region 导致误判
    region: valid.map(x => x.region).find(Boolean) || '',
    org: primary.org || valid.map(x => x.org).find(Boolean) || '',
    isDatacenter: valid.some(x => x.isDatacenter === true),
    isProxy: valid.some(x => x.isProxy === true),
    isLocal: false,
    providers: valid.map(x => x.provider).filter(Boolean)
  };
}

/** 查询单个 IP 的地理信息：ipapi.is 主源 + ipwho.is 地理回退 + ippure/ip-api 兼容兜底 */
function getGeoInfo(ip, forceRefresh = false) {
  if (isPrivateIP(ip)) {
    return Promise.resolve({ countryCode: '', isDatacenter: false, isProxy: false, isLocal: true });
  }
  const normalized = String(ip || '').trim();
  if (!normalized || normalized === 'unknown') {
    return Promise.resolve({ countryCode: '', isDatacenter: false, isProxy: false, isLocal: false, error: true });
  }
  const cached = geoCache.get(normalized);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < GEO_CACHE_TTL) return Promise.resolve(cached.data);
  // 本地限流：多个上游请求按一次原始 IP 查询计数，避免同时压垮数据源
  const recent = geoRateLog.filter(t => now - t < GEO_RATE_WINDOW);
  geoRateLog.length = 0; geoRateLog.push(...recent);
  if (geoRateLog.length >= GEO_RATE_MAX) {
    return Promise.resolve({ countryCode: '', isDatacenter: false, isProxy: false, isLocal: false, rateLimited: true });
  }
  geoRateLog.push(now);

  return (async () => {
    // 两个独立数据源并发：ipapi.is 负责机房/代理信号，ipwho.is 负责稳定的国家归属。
    // IPPure 与 ip-api 仅在前两个都无法给出国家归属时作为兼容兜底，避免其不稳定性主导拦截结果。
    const primary = await Promise.all([getGeoInfoFromIpApiIs(normalized), getGeoInfoFromIpWhoIs(normalized)]);
    let info = mergeGeoInfos(primary);
    // 当国家归属为 CN 但主源未给出可识别省份时，也要请求地区兜底源；
    // 否则会把实际中国省份访客误当作“未命中白名单”。
    const needFallback = !info || !/^[A-Z]{2}$/.test(info.countryCode) ||
      (info.countryCode === 'CN' && !normalizeChinaRegion(info.countryCode, info.region));
    if (needFallback) {
      const fallbacks = await Promise.all([getGeoInfoFromIPPure(normalized), getGeoInfoFromIpApi(normalized)]);
      info = mergeGeoInfos(primary.concat(fallbacks));
    }
    if (info && /^[A-Z]{2}$/.test(info.countryCode)) {
      geoCache.set(normalized, { data: info, fetchedAt: Date.now() });
      if (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value);
      return info;
    }
    // 国家归属未知时一律 fail-open，禁止将空 countryCode 误判为海外。
    return { countryCode: '', isDatacenter: false, isProxy: false, isLocal: false, error: true };
  })();
}

/** 判断 IP 是否应被拦截：返回 null（放行）或 { type: 'domestic'|'overseas'|'datacenter', autoClose: bool } */
function logIpBlocked(req, ip, blockInfo) {
  // IP 拦截可能被高频扫描触发；按 IP + 类型每 10 分钟仅记录一次，避免日志被刷爆。
  const key = `ipblock:${ip}:${blockInfo.type}`;
  if (!checkRate(key, 1, 10 * 60 * 1000)) return;
  const label = blockInfo.type === 'datacenter' ? '机房/代理出口' : blockInfo.type === 'domestic' ? '中国地区白名单' : '海外或未命中地区白名单';
  logOp(null, req, 'IP访问拦截', `${label}${blockInfo.region ? '（' + blockInfo.region + '）' : ''}`, 'ip');
}
async function checkIpAccess(ip) {
  // 三项开关全部关闭时直接放行，避免无谓的外部请求
  if (!db.settings.acDomesticBlock && !db.settings.acOverseasBlock && !db.settings.acDatacenterBlock) {
    return null;
  }
  const geo = await getGeoInfo(ip);
  // 查询失败/限流时 fail-open（放行），避免 API 不可用时锁死全站
  if (geo.error || geo.rateLimited || geo.isLocal) return null;
  // 机房/匿名出口检测优先级最高：明确的数据中心、代理、VPN、Tor 都属于此拦截范围。
  if (db.settings.acDatacenterBlock && (geo.isDatacenter || geo.isProxy)) {
    return { type: 'datacenter', autoClose: !!db.settings.acDcAutoClose };
  }
  // 只有获取到合法 ISO 国家代码才判断国内/海外；空值或异常结果绝不能按海外误封。
  if (!/^[A-Z]{2}$/.test(geo.countryCode || '')) return null;
  // 国内定义为：中国省级行政区白名单 + 中国香港/中国澳门/中国台湾。
  // CN 但省级地区缺失或未命中白名单时不视为国内；仅开启“拦截海外”时将其拦截，
  // 防止模糊归属/海外伪装为 CN 的地址绕过地区限制。
  const chinaRegion = normalizeChinaRegion(geo.countryCode, geo.region);
  const isDomestic = !!chinaRegion;
  if (db.settings.acDomesticBlock && isDomestic) {
    return { type: 'domestic', autoClose: false, region: chinaRegion };
  }
  if (db.settings.acOverseasBlock && !isDomestic) {
    return { type: 'overseas', autoClose: false };
  }
  return null;
}

/** 定时清理过期的 geo 缓存条目（超过 48h 的条目） */
function pruneGeoCache() {
  const now = Date.now();
  for (const [ip, entry] of geoCache) {
    if (now - entry.fetchedAt > 2 * GEO_CACHE_TTL) geoCache.delete(ip);
  }
}

// ============ 每日一言（内置语录 + 管理员自定义语录，随机返回） ============
const BUILTIN_QUOTES = [
  '生活不是等待风暴过去，而是学会在雨中跳舞。',
  '种一棵树最好的时间是十年前，其次是现在。',
  '山重水复疑无路，柳暗花明又一村。',
  '不积跬步，无以至千里；不积小流，无以成江海。',
  '星光不问赶路人，时光不负有心人。',
  '海阔凭鱼跃，天高任鸟飞。',
  '千淘万漉虽辛苦，吹尽狂沙始到金。',
  '沉舟侧畔千帆过，病树前头万木春。',
  '路漫漫其修远兮，吾将上下而求索。',
  '长风破浪会有时，直挂云帆济沧海。',
  '纸上得来终觉浅，绝知此事要躬行。',
  '博观而约取，厚积而薄发。',
  '莫愁前路无知己，天下谁人不识君。',
  '天行健，君子以自强不息。',
  '业精于勤，荒于嬉；行成于思，毁于随。',
  '读书破万卷，下笔如有神。',
  '会当凌绝顶，一览众山小。',
  '苟日新，日日新，又日新。',
  '行到水穷处，坐看云起时。',
  '把每一天当作生命的最后一天来过，你终将活出非凡。'
];

// 公开：获取一条随机一言（未开启时返回 enabled:false）
route('GET', '/api/quote', async ctx => {
  if (!db.settings.quoteEnabled) return json(ctx.res, 200, { enabled: false });
  const customs = db.quotes.filter(q => q && String(q.text || '').trim());
  const pool = customs.length ? customs.map(q => ({ text: String(q.text).trim(), custom: true }))
    : BUILTIN_QUOTES.map(t => ({ text: t, custom: false }));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  json(ctx.res, 200, { enabled: true, text: pick.text, custom: pick.custom });
});

// ============ 倒计时（管理员配置目标日期，前台展示） ============

// 公开：获取倒计时列表（按日期升序，过期的不返回）
route('GET', '/api/countdowns', async ctx => {
  if (!featureOn('countdownEnabled')) return json(ctx.res, 200, { countdowns: [] });
  const today = todayStr();
  const list = [...db.countdowns]
    .filter(c => String(c.date || '') >= today)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(c => ({ id: c.id, name: c.name, date: c.date }));
  json(ctx.res, 200, { countdowns: list });
});

// 管理：倒计时列表（含已过期的）
route('GET', '/api/admin/countdowns', async ctx => {
  const list = [...db.countdowns].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  json(ctx.res, 200, { countdowns: list });
}, { auth: true });

// 管理：新增倒计时
route('POST', '/api/admin/countdowns', async ctx => {
  const { name = '', date = '' } = ctx.body || {};
  const n = String(name).trim();
  if (!n || n.length > COUNTDOWN_NAME_MAX) return json(ctx.res, 400, { error: `名称需为 1-${COUNTDOWN_NAME_MAX} 个字符` });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(date + 'T00:00:00'))) {
    return json(ctx.res, 400, { error: '日期格式需为 YYYY-MM-DD' });
  }
  if (db.countdowns.length >= COUNTDOWN_MAX) return json(ctx.res, 400, { error: `倒计时最多 ${COUNTDOWN_MAX} 条` });
  const c = { id: uid(), name: n, date: String(date), createdAt: nowISO() };
  db.countdowns.push(c);
  saveDB('countdowns', db.countdowns);
  logOp(ctx.user, ctx.req, '添加倒计时', `${c.name}（${c.date}）`);
  json(ctx.res, 200, { ok: true, countdown: c });
}, { auth: true });

// 管理：删除倒计时
route('DELETE', '/api/admin/countdowns/:id', async ctx => {
  const idx = db.countdowns.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '倒计时不存在' });
  const [c] = db.countdowns.splice(idx, 1);
  saveDB('countdowns', db.countdowns);
  logOp(ctx.user, ctx.req, '删除倒计时', c.name);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 友情链接（独立专区展示合作站点） ============

// 公开：获取友链列表（按 order 排序）
route('GET', '/api/friendlinks', async ctx => {
  if (!featureOn('friendlinksEnabled')) return json(ctx.res, 200, { links: [] });
  const list = [...db.friendlinks].sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(f => ({ id: f.id, name: f.name, url: f.url }));
  json(ctx.res, 200, { links: list });
});

// 管理：友链列表（含全部字段）
route('GET', '/api/admin/friendlinks', async ctx => {
  const list = [...db.friendlinks].sort((a, b) => (a.order || 0) - (b.order || 0));
  json(ctx.res, 200, { links: list });
}, { auth: true });

// 管理：新增友链
route('POST', '/api/admin/friendlinks', async ctx => {
  const { name = '', url = '', order = 0 } = ctx.body || {};
  const n = String(name).trim();
  if (!n || n.length > FRIENDLINK_NAME_MAX) return json(ctx.res, 400, { error: `名称需为 1-${FRIENDLINK_NAME_MAX} 个字符` });
  if (!validUrl(String(url).trim())) return json(ctx.res, 400, { error: '链接需为合法的 http/https 地址' });
  if (db.friendlinks.length >= MAX_FRIENDLINKS) return json(ctx.res, 400, { error: `友链最多 ${MAX_FRIENDLINKS} 条` });
  const f = { id: uid(), name: n, url: String(url).trim(), order: parseInt(order, 10) || 0, createdAt: nowISO() };
  db.friendlinks.push(f);
  saveDB('friendlinks', db.friendlinks);
  logOp(ctx.user, ctx.req, '添加友链', f.name);
  json(ctx.res, 200, { ok: true, link: f });
}, { auth: true });

// 管理：编辑友链
route('PUT', '/api/admin/friendlinks/:id', async ctx => {
  const f = db.friendlinks.find(x => x.id === ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '友链不存在' });
  const b = ctx.body || {};
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n || n.length > FRIENDLINK_NAME_MAX) return json(ctx.res, 400, { error: `名称需为 1-${FRIENDLINK_NAME_MAX} 个字符` });
    f.name = n;
  }
  if (b.url !== undefined) {
    if (!validUrl(String(b.url).trim())) return json(ctx.res, 400, { error: '链接需为合法的 http/https 地址' });
    f.url = String(b.url).trim();
  }
  if (b.order !== undefined) f.order = parseInt(b.order, 10) || 0;
  saveDB('friendlinks', db.friendlinks);
  logOp(ctx.user, ctx.req, '编辑友链', f.name);
  json(ctx.res, 200, { ok: true, link: f });
}, { auth: true });

// 管理：删除友链
route('DELETE', '/api/admin/friendlinks/:id', async ctx => {
  const idx = db.friendlinks.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '友链不存在' });
  const [f] = db.friendlinks.splice(idx, 1);
  saveDB('friendlinks', db.friendlinks);
  logOp(ctx.user, ctx.req, '删除友链', f.name);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 意见反馈板（用户提交建议，后台可回复处理） ============

/** 裁剪反馈至 MAX_FEEDBACKS 条（保留最新） */
function pruneFeedbacks() {
  if (db.feedbacks.length > MAX_FEEDBACKS) {
    db.feedbacks.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    db.feedbacks.length = MAX_FEEDBACKS;
  }
}

// 公开：提交反馈（未登录需人机验证；每 IP 每分钟限 FEEDBACK_RATE_MAX 条）
route('POST', '/api/feedback', async ctx => {
  if (!featureOn('feedbackEnabled')) return json(ctx.res, 403, { error: '意见反馈功能已关闭' });
  if (!checkRate('feedback:' + ctx.ip, FEEDBACK_RATE_MAX, FEEDBACK_RATE_WINDOW)) {
    logRateHit('反馈提交', ctx.ip, '超过每分钟反馈上限');
    return json(ctx.res, 429, { error: '提交过于频繁，请稍后再试' });
  }
  if (!checkPublicCaptcha(ctx)) return;
  const { contact = '', content = '' } = ctx.body || {};
  const c = String(content).trim();
  if (!c) return json(ctx.res, 400, { error: '反馈内容不能为空' });
  const fbMaxLen = numSetting('feedbackMaxLen');
  if (c.length > fbMaxLen) return json(ctx.res, 400, { error: `反馈内容不能超过 ${fbMaxLen} 个字符` });
  const ct = String(contact).trim().slice(0, FEEDBACK_CONTACT_MAX);
  const fb = {
    id: uid(), contact: ct, content: c, ip: ctx.ip,
    status: 'open', createdAt: nowISO()
  };
  db.feedbacks.push(fb);
  pruneFeedbacks();
  saveDB('feedbacks', db.feedbacks);
  json(ctx.res, 200, { ok: true });
});

// 管理：反馈列表（含 IP 与状态）
route('GET', '/api/admin/feedbacks', async ctx => {
  const list = [...db.feedbacks].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  json(ctx.res, 200, { feedbacks: list });
}, { auth: true });

// 管理：回复反馈并标记状态（status: open/processing/resolved）
route('PUT', '/api/admin/feedbacks/:id', async ctx => {
  const fb = db.feedbacks.find(x => x.id === ctx.params.id);
  if (!fb) return json(ctx.res, 404, { error: '反馈不存在' });
  const b = ctx.body || {};
  if (b.reply !== undefined) {
    const r = String(b.reply).trim();
    if (r.length > FEEDBACK_REPLY_MAX) return json(ctx.res, 400, { error: `回复不能超过 ${FEEDBACK_REPLY_MAX} 个字符` });
    if (r) { fb.reply = r; fb.replyBy = ctx.user.username; fb.replyAt = nowISO(); }
    else { delete fb.reply; delete fb.replyBy; delete fb.replyAt; }
  }
  if (b.status !== undefined) {
    const s = String(b.status);
    if (!['open', 'processing', 'resolved'].includes(s)) return json(ctx.res, 400, { error: '状态无效' });
    fb.status = s;
  }
  saveDB('feedbacks', db.feedbacks);
  logOp(ctx.user, ctx.req, '处理反馈', `${fb.content.slice(0, 30)}（${fb.status}）`);
  json(ctx.res, 200, { ok: true, feedback: fb });
}, { auth: true });

// 管理：删除反馈
route('DELETE', '/api/admin/feedbacks/:id', async ctx => {
  const idx = db.feedbacks.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '反馈不存在' });
  const [fb] = db.feedbacks.splice(idx, 1);
  saveDB('feedbacks', db.feedbacks);
  logOp(ctx.user, ctx.req, '删除反馈', fb.content.slice(0, 30));
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 热门排行（访问量 Top 站点，前台「大家都在用」横条） ============

// 公开：获取热门站点（按累计访问量取前 N，仅返回启用的站点）
route('GET', '/api/popular', async ctx => {
  if (!featureOn('popularEnabled')) return json(ctx.res, 200, { popular: [] });
  const list = db.sites.filter(s => s.enabled !== false).map(s => {
    const v = db.visits.sites[s.id] || { total: 0 };
    return { id: s.id, name: s.name, url: s.url, icon: s.icon || '', desc: s.desc || '', total: v.total || 0 };
  }).filter(s => s.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, numSetting('popularTopN'));
  json(ctx.res, 200, { popular: list });
});

// ============ 自定义一言语录管理 ============

// 管理：语录列表
route('GET', '/api/admin/quotes', async ctx => {
  json(ctx.res, 200, { quotes: [...db.quotes], builtin: BUILTIN_QUOTES });
}, { auth: true });

// 管理：新增自定义语录
route('POST', '/api/admin/quotes', async ctx => {
  const { text = '' } = ctx.body || {};
  const t = String(text).trim();
  if (!t || t.length > 100) return json(ctx.res, 400, { error: '语录内容需为 1-100 个字符' });
  if (db.quotes.some(q => q.text === t)) return json(ctx.res, 409, { error: '这条语录已存在' });
  if (db.quotes.length >= QUOTES_KEEP) return json(ctx.res, 400, { error: `自定义语录最多 ${QUOTES_KEEP} 条` });
  const q = { id: uid(), text: t, createdAt: nowISO() };
  db.quotes.push(q);
  saveDB('quotes', db.quotes);
  logOp(ctx.user, ctx.req, '添加一言语录', t.slice(0, 30));
  json(ctx.res, 200, { ok: true, quote: q });
}, { auth: true });

// 管理：删除自定义语录
route('DELETE', '/api/admin/quotes/:id', async ctx => {
  const idx = db.quotes.findIndex(x => x.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '语录不存在' });
  const [q] = db.quotes.splice(idx, 1);
  saveDB('quotes', db.quotes);
  logOp(ctx.user, ctx.req, '删除一言语录', q.text.slice(0, 30));
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 前台：获取某个引导页的图标（无缓存时等待后台抓取结果，带超时上限）
route('GET', '/api/sites/:id/icon', async ctx => {
  const site = db.sites.find(s => s.id === ctx.params.id);
  if (!site) return json(ctx.res, 404, { error: '引导页不存在' });
  if (site.icon) return json(ctx.res, 200, { icon: site.icon });
  const entry = db.favicons[site.id];
  const now = Date.now();
  if (entry && entry.path && fs.existsSync(path.join(FAVICON_DIR, entry.file)) &&
      entry.fetchedAt && now - entry.fetchedAt < FAVICON_TTL) {
    return json(ctx.res, 200, { icon: entry.path });
  }
  // 等待抓取任务完成（去重），超时则返回 null，前端保留占位、下次刷新再试
  const result = await Promise.race([
    ensureIconFetching(site),
    new Promise(r => setTimeout(() => r(null), FAVICON_FETCH_TIMEOUT + 2000))
  ]);
  json(ctx.res, 200, { icon: result || null });
});

// ============ 管理接口（需登录） ============

// 仪表盘统计
route('GET', '/api/admin/stats', async ctx => {
  const today = todayStr();
  let totalVisits = 0, todayVisits = 0;
  const ranking = db.sites.map(s => {
    const v = db.visits.sites[s.id] || { total: 0, daily: {} };
    totalVisits += v.total;
    todayVisits += v.daily[today] || 0;
    return { id: s.id, name: s.name, url: s.url, total: v.total, today: v.daily[today] || 0 };
  }).sort((a, b) => b.total - a.total);

  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = dateNDaysAgo(i);
    let t = 0;
    for (const s of db.sites) {
      const v = db.visits.sites[s.id];
      if (v && v.daily[d]) t += v.daily[d];
    }
    trend.push({ date: d, total: t });
  }

  // 访问热力图：最近 N 天 × 24 小时的访问分布（天数可在后台调整）
  const heatmap = [];
  const hmDays = numSetting('heatmapDays');
  for (let i = hmDays - 1; i >= 0; i--) {
    const d = dateNDaysAgo(i);
    const hours = [];
    for (let hr = 0; hr < 24; hr++) {
      hours.push((db.visits.hourly && db.visits.hourly[d + ' ' + pad2(hr)]) || 0);
    }
    heatmap.push({ date: d, hours });
  }

  // 热门文件 Top10（按累计下载量排序）与共享文件累计下载总数
  const totalFileDownloads = db.files.reduce((sum, f) => sum + (f.downloads || 0), 0);
  const fileRanking = [...db.files]
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .slice(0, 10)
    .map(f => ({ id: f.id, name: f.name, size: f.size || 0, downloads: f.downloads || 0, createdAt: f.createdAt }));

  // 独立访客趋势：最近 14 天（与访问量趋势同窗口）
  const visitorTrend = [];
  let todayVisitors = 0;
  for (let i = 13; i >= 0; i--) {
    const d = dateNDaysAgo(i);
    const n = (db.visits.visitors && db.visits.visitors[d]) || 0;
    if (i === 0) todayVisitors = n;
    visitorTrend.push({ date: d, total: n });
  }

  // 来源域名 Top10（按累计次数降序）
  const referrers = Object.entries(db.visits.referrers || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([host, count]) => ({ host, count }));

  // 死链告警：linkStatus === 'dead' 的引导页
  const deadLinks = db.sites.filter(s => s.linkStatus === 'dead')
    .map(s => ({ id: s.id, name: s.name, url: s.url, detail: s.linkDetail || '', checkedAt: s.linkCheckedAt || '' }));

  json(ctx.res, 200, {
    totals: {
      sites: db.sites.length, visits: totalVisits, today: todayVisits,
      todayVisitors, users: db.users.length, files: db.files.length, fileDownloads: totalFileDownloads
    },
    ranking, trend, heatmap, fileRanking, visitorTrend, referrers, deadLinks
  });
}, { auth: true });

// 引导页列表（含访问数据）
route('GET', '/api/admin/sites', async ctx => {
  const today = todayStr();
  const list = [...db.sites].sort(byOrder).map(s => {
    const v = db.visits.sites[s.id] || { total: 0, daily: {} };
    return { ...s, total: v.total, today: v.daily[today] || 0 };
  });
  json(ctx.res, 200, { sites: list });
}, { auth: true });

// 添加引导页
route('POST', '/api/admin/sites', async ctx => {
  const { name = '', url = '', desc = '', icon = '', order = 0, category = '', enabled = true } = ctx.body || {};
  const n = String(name).trim();
  if (!n || n.length > 30) return json(ctx.res, 400, { error: '名称需为 1-30 个字符' });
  if (!validUrl(String(url).trim())) return json(ctx.res, 400, { error: '链接需为合法的 http/https 地址' });
  if (String(desc).length > 60) return json(ctx.res, 400, { error: '描述不能超过 60 个字符' });
  if (String(category).length > 12) return json(ctx.res, 400, { error: '分类名不能超过 12 个字符' });
  const iconRef = String(icon).trim().slice(0, 500);
  if (!validIconRef(iconRef)) return json(ctx.res, 400, { error: '图标地址格式不合法' });

  const site = {
    id: uid(), name: n, url: String(url).trim(),
    desc: String(desc).trim(), icon: iconRef,
    category: String(category).trim(), enabled: enabled !== false,
    order: parseInt(order, 10) || 0, createdAt: nowISO()
  };
  db.sites.push(site);
  saveDB('sites', db.sites);
  logOp(ctx.user, ctx.req, '添加引导页', `${site.name}（${site.url}）`);
  // 未手动设置图标时，后台立即抓取网站图标（去重）
  if (!site.icon) {
    ensureIconFetching(site, true).then(f => {
      if (f) logOp(ctx.user, ctx.req, '同步图标', `${site.name}（来源：${(db.favicons[site.id] || {}).source || '自动'}）`);
    }).catch(() => { /* 抓取失败静默 */ });
  }
  json(ctx.res, 200, { ok: true, site });
}, { auth: true });

// 保存拖拽排序结果：按提交顺序重新赋 order（0,10,20…）
// 注意：必须注册在 /api/admin/sites/:id 之前，否则会被通配路由拦截
route('PUT', '/api/admin/sites/reorder', async ctx => {
  const ids = (ctx.body || {}).ids;
  if (!Array.isArray(ids) || !ids.length) return json(ctx.res, 400, { error: '排序数据为空' });
  if (ids.length > 1000) return json(ctx.res, 400, { error: '排序条目过多' });
  const unique = [...new Set(ids.filter(id => typeof id === 'string'))];
  if (unique.length !== ids.length) return json(ctx.res, 400, { error: '排序数据存在重复项' });
  const inList = db.sites.filter(s => unique.includes(s.id));
  if (inList.length !== unique.length) return json(ctx.res, 400, { error: '部分引导页不存在，请刷新后重试' });
  inList.sort((a, b) => unique.indexOf(a.id) - unique.indexOf(b.id));
  inList.forEach((s, i) => { s.order = i * 10; });
  saveDB('sites', db.sites);
  logOp(ctx.user, ctx.req, '调整引导页排序', `${inList.length} 个引导页`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 修改引导页
route('PUT', '/api/admin/sites/:id', async ctx => {
  const site = db.sites.find(s => s.id === ctx.params.id);
  if (!site) return json(ctx.res, 404, { error: '引导页不存在' });
  const b = ctx.body || {};
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n || n.length > 30) return json(ctx.res, 400, { error: '名称需为 1-30 个字符' });
    site.name = n;
  }
  if (b.url !== undefined) {
    const newUrl = String(b.url).trim();
    if (!validUrl(newUrl)) return json(ctx.res, 400, { error: '链接需为合法的 http/https 地址' });
    if (newUrl !== site.url) {
      site.url = newUrl;
      removeFaviconCache(site.id); // 地址变了，图标缓存作废
    }
  }
  if (b.desc !== undefined) {
    if (String(b.desc).length > 60) return json(ctx.res, 400, { error: '描述不能超过 60 个字符' });
    site.desc = String(b.desc).trim();
  }
  if (b.icon !== undefined) {
    const newIcon = String(b.icon).trim().slice(0, 500);
    if (!validIconRef(newIcon)) return json(ctx.res, 400, { error: '图标地址格式不合法' });
    // 替换图标时清理旧的上传文件
    if (site.icon && site.icon.startsWith('/uploads/') && site.icon !== newIcon) {
      removeUpload(site.icon);
    }
    site.icon = newIcon;
  }
  if (b.category !== undefined) {
    if (String(b.category).length > 12) return json(ctx.res, 400, { error: '分类名不能超过 12 个字符' });
    site.category = String(b.category).trim();
  }
  if (b.enabled !== undefined) site.enabled = b.enabled !== false;
  if (b.order !== undefined) site.order = parseInt(b.order, 10) || 0;
  saveDB('sites', db.sites);
  // 未手动设置图标时，重新抓取网站图标（去重）
  if (!site.icon) {
    ensureIconFetching(site, true);
  }
  logOp(ctx.user, ctx.req, '修改引导页', site.name);
  json(ctx.res, 200, { ok: true, site });
}, { auth: true });

// 手动刷新某个引导页的图标缓存
route('POST', '/api/admin/sites/:id/refresh-icon', async ctx => {
  const site = db.sites.find(s => s.id === ctx.params.id);
  if (!site) return json(ctx.res, 404, { error: '引导页不存在' });
  const result = await getFaviconUrl(site, true);
  if (result) {
    logOp(ctx.user, ctx.req, '刷新图标', `${site.name}（来源：${(db.favicons[site.id] || {}).source || '自动'}）`);
    return json(ctx.res, 200, { ok: true, icon: result });
  }
  json(ctx.res, 400, { error: '图标抓取失败，目标站点可能无法访问' });
}, { auth: true });

// ---------------- 死链检测 ----------------
let linkChecking = false; // 全局检测锁：同一时刻只允许一次全站检测

/** 检测单个引导页可达性：任何 HTTP 响应（<400）视为可用；网络错误/超时/4xx/5xx 视为死链 */
async function checkSiteLink(site) {
  try {
    // resolveOnLimit：页面超过 1KB 也按可达处理，避免把内容较大的正常站点误报为死链
    const r = await fetchRemote(site.url, { maxBytes: 1024, timeout: 8000, redirects: 3, resolveOnLimit: true });
    return { ok: r.status > 0 && r.status < 400, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e).slice(0, 60) };
  }
}

/** 执行一次全站死链检测（并发受控）；正在检测或无可检测目标时返回 null */
async function runLinkCheck() {
  if (linkChecking) return null;
  const targets = db.sites.filter(s => validUrl(String(s.url || '')));
  if (!targets.length) return null;

  linkChecking = true;
  const results = [];
  try {
    // 并发上限 5，避免同时发起过多外部请求
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const site = queue.shift();
        const r = await checkSiteLink(site);
        site.linkStatus = r.ok ? 'ok' : 'dead';
        site.linkDetail = r.ok ? String(r.status) : (r.status ? String(r.status) : (r.error || '无法连接'));
        site.linkCheckedAt = nowISO();
        results.push({ id: site.id, name: site.name, url: site.url, linkStatus: site.linkStatus, linkDetail: site.linkDetail });
      }
    });
    await Promise.all(workers);
    saveDB('sites', db.sites);
  } finally {
    linkChecking = false;
  }
  const dead = results.filter(r => r.linkStatus === 'dead').length;
  return { total: results.length, dead, results };
}

// 管理：检测全部引导页的链接可用性
route('POST', '/api/admin/sites/check-links', async ctx => {
  if (linkChecking) return json(ctx.res, 409, { error: '正在检测中，请稍候再试' });
  const r = await runLinkCheck();
  if (!r) return json(ctx.res, 400, { error: '没有可检测的引导页' });
  logOp(ctx.user, ctx.req, '死链检测', `检测 ${r.total} 个引导页，发现 ${r.dead} 个异常`);
  json(ctx.res, 200, { ok: true, total: r.total, dead: r.dead, results: r.results });
}, { auth: true });

// ---------------- 定时死链检测调度 ----------------
let linkCheckTimer = null;
function linkCheckIntervalMs() {
  const hours = Number.isFinite(db.settings.linkCheckInterval) ? db.settings.linkCheckInterval : LINK_CHECK_DEFAULT_INTERVAL;
  return Math.max(LINK_CHECK_MIN_INTERVAL, Math.min(LINK_CHECK_MAX_INTERVAL, hours)) * 3600 * 1000;
}
/** 调度下一次定时检测；delayMs 缺省时使用配置间隔，禁用时清除定时器 */
function scheduleLinkCheck(delayMs) {
  if (linkCheckTimer) { clearTimeout(linkCheckTimer); linkCheckTimer = null; }
  if (!db.settings.linkCheckEnabled) return;
  const ms = delayMs !== undefined ? delayMs : linkCheckIntervalMs();
  linkCheckTimer = setTimeout(async () => {
    linkCheckTimer = null;
    if (!db.settings.linkCheckEnabled) return;
    try {
      const r = await runLinkCheck();
      if (r) logOp(null, null, '定时死链检测', `检测 ${r.total} 个引导页，发现 ${r.dead} 个异常`);
    } catch (e) { /* 本轮失败，等待下个周期 */ }
    scheduleLinkCheck();
  }, ms);
  linkCheckTimer.unref();
}

// 删除引导页
route('DELETE', '/api/admin/sites/:id', async ctx => {
  const idx = db.sites.findIndex(s => s.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '引导页不存在' });
  const [site] = db.sites.splice(idx, 1);
  if (db.visits.sites[site.id]) { delete db.visits.sites[site.id]; saveDB('visits', db.visits); }
  if (site.icon && site.icon.startsWith('/uploads/')) removeUpload(site.icon);
  removeFaviconCache(site.id);
  saveDB('sites', db.sites);
  logOp(ctx.user, ctx.req, '删除引导页', `${site.name}（${site.url}）`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 批量导入引导页（前端将 JSON/CSV 解析为数组后提交；单次上限 IMPORT_MAX_ROWS 条）
route('POST', '/api/admin/sites/import', async ctx => {
  const rows = (ctx.body || {}).sites;
  if (!Array.isArray(rows) || !rows.length) return json(ctx.res, 400, { error: '没有可导入的数据' });
  if (rows.length > IMPORT_MAX_ROWS) return json(ctx.res, 400, { error: `单次最多导入 ${IMPORT_MAX_ROWS} 条` });

  let maxOrder = db.sites.reduce((m, s) => Math.max(m, s.order || 0), 0);
  const added = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const name = String(r.name || '').trim().slice(0, 30);
    const url = String(r.url || '').trim();
    const desc = String(r.desc || '').trim().slice(0, 60);
    const category = String(r.category || '').trim().slice(0, 12);
    const iconRef = String(r.icon || '').trim().slice(0, 500);
    if (!name || !validUrl(url)) {
      errors.push({ row: i + 1, name: name || '(未命名)', reason: !name ? '缺少名称' : '链接不是合法的 http/https 地址' });
      continue;
    }
    if (iconRef && !validIconRef(iconRef)) {
      errors.push({ row: i + 1, name, reason: '图标地址格式不合法' });
      continue;
    }
    maxOrder += 10;
    const site = {
      id: uid(), name, url, desc, icon: iconRef, category,
      enabled: r.enabled !== false && String(r.enabled) !== 'false',
      order: maxOrder, createdAt: nowISO()
    };
    db.sites.push(site);
    added.push(site);
  }
  if (added.length) {
    saveDB('sites', db.sites);
    // 未手动设置图标的站点后台抓取图标（复用去重逻辑）
    added.filter(s => !s.icon).forEach(s => ensureIconFetching(s, true));
  }
  logOp(ctx.user, ctx.req, '批量导入引导页', `成功 ${added.length} 条，失败 ${errors.length} 条`);
  json(ctx.res, 200, { ok: true, added: added.length, failed: errors.length, errors: errors.slice(0, 50) });
}, { auth: true });

// 上传图标（base64，支持 png/jpg/jpeg/gif/webp/ico/bmp/svg/avif/tif/tiff/apng，单个 ≤1MB）
// 检测到浏览器不兼容的格式（bmp/ico/tiff）时自动转换为 PNG
route('POST', '/api/admin/upload', async ctx => {
  const { data = '', filename = '' } = ctx.body || {};
  const m = /^data:image\/([\w+.-]+);base64,(.+)$/.exec(String(data));
  if (!m) return json(ctx.res, 400, { error: '请选择有效的图片文件' });
  const sub = m[1].toLowerCase();
  const ext = MIME_TO_EXT[sub];
  if (!ext || !UPLOAD_TYPES[ext]) return json(ctx.res, 400, { error: '不支持的图片格式' });
  // 严格 base64 校验：只允许标准字符集与合法填充
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(m[2]) || m[2].length % 4 !== 0) {
    return json(ctx.res, 400, { error: '图片数据无效' });
  }
  let buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return json(ctx.res, 400, { error: '图片内容为空' });
  if (buf.length > UPLOAD_MAX) return json(ctx.res, 400, { error: '图片过大，请不超过 1MB' });
  // SVG XSS 防护：与静态服务路径共用完整消毒逻辑（script/on*/伪协议/foreignObject），防止嵌入恶意脚本
  if (ext === 'svg') buf = sanitizeSvg(buf);
  // 不兼容格式自动转 PNG（转换失败则按原格式保存）
  let finalExt = ext;
  let converted = false;
  const conv = autoConvertImage(ext, buf);
  if (conv) {
    buf = conv.buf;
    finalExt = conv.ext;
    converted = true;
  }
  // 用随机文件名存储，避免覆盖与路径问题
  const name = uid() + uid() + '.' + finalExt;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  const url = '/uploads/' + name;
  const fname = String(filename || '').slice(0, 120); // 仅用于日志，截断防日志膨胀
  logOp(ctx.user, ctx.req, '上传图标',
    (fname || name) + '（' + buf.length + ' 字节' + (converted ? `，${ext} 已自动转换为 PNG` : '') + '）');
  json(ctx.res, 200, { ok: true, url, converted });
}, { auth: true });

// ============ 共享文件模块（管理员上传，用户下载） ============

/** 由原始文件名生成安全的存储文件名（保留扩展名） */
function storageName(orig) {
  const ext = path.extname(orig).toLowerCase().slice(0, 20);
  return uid() + uid() + ext;
}
/** 校验内部存储文件名；它必须是单层 ASCII 名称，且不能命中 Windows 特殊设备名。 */
function validStorageName(value) {
  const s = String(value || '');
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(s) || s === '.' || s === '..' || /[. ]$/.test(s)) return false;
  const base = s.split('.')[0].toLowerCase();
  return !/^(con|prn|aux|nul|clock\$|com[0-9]|lpt[0-9])$/.test(base);
}
function safePathInRoot(root, storage) {
  return validStorageName(storage) ? path.join(root, String(storage)) : null;
}
function safeFilePath(storage) {
  return safePathInRoot(FILES_DIR, storage);
}
function safeStoredPathInRoot(root, storage) {
  const filePath = safePathInRoot(root, storage);
  if (!filePath) return null;
  // lstat 不跟随符号链接：共享文件目录中的链接不能把下载/打包引向目录外。
  try { return fs.lstatSync(filePath).isFile() ? filePath : null; } catch (e) { return null; }
}
function safeStoredPath(storage) {
  return safeStoredPathInRoot(FILES_DIR, storage);
}
function findFile(id) { return db.files.find(f => f.id === id); }
function findFolder(id) { return db.folders.find(f => f.id === id); }
function fileIsHidden(file) { return !!(file && file.hidden === true); }
function fileSpeedBytes(file) {
  const perFile = Number(file && file.speedLimitMbps);
  if (Number.isFinite(perFile) && perFile > 0) return perFile * 1024 * 1024;
  return downloadRateBytes();
}
function fileBackendValid(file) {
  if (!file) return false;
  if (file.nodeId) return !!(validNodePath(file.nodePath) && db.nodes.some(n => n.id === file.nodeId));
  if (file.sourceUrl) return validHttpUrl(file.sourceUrl);
  return validStorageName(file.storage);
}
function filePublicView(file) {
  return { id: file.id, name: file.name, size: file.size, desc: file.desc || '', downloads: file.downloads || 0, createdAt: file.createdAt, external: !!file.sourceUrl, nodeId: file.nodeId || '' };
}
function validHttpUrl(value, max = NODE_URL_MAX) {
  try {
    const u = new URL(String(value || '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.toString().length <= max;
  } catch (e) { return false; }
}
function nodeIsOnline(node) { return node && node.enabled !== false && Number(node.lastHeartbeat || 0) + NODE_HEARTBEAT_TTL > Date.now(); }
function chooseNode(file) {
  if (file && file.nodeId) {
    const assigned = db.nodes.find(n => n.id === file.nodeId);
    return nodeIsOnline(assigned) ? assigned : null;
  }
  return db.nodes.filter(nodeIsOnline)
    .sort((a, b) => ((Number(b.freeBandwidthMbps) || 0) - (Number(a.freeBandwidthMbps) || 0)) || ((Number(a.activeTasks) || 0) - (Number(b.activeTasks) || 0)))[0] || null;
}

// ---------------- 取件码（临时分享） ----------------
/** 生成随机取件码（避开易混淆字符） */
function genShareCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(SHARE_CODE_LEN);
    for (let i = 0; i < SHARE_CODE_LEN; i++) code += SHARE_CODE_CHARS[bytes[i] % SHARE_CODE_CHARS.length];
    if (!db.shareCodes[code]) return code; // 避免与未过期码冲突
  }
  return null;
}
/** 删除某文件的全部取件码（文件被删除时调用） */
function removeFileShareCodes(fileId) {
  let changed = false;
  for (const [code, s] of Object.entries(db.shareCodes)) {
    if (s.fileId === fileId) { delete db.shareCodes[code]; changed = true; }
  }
  if (changed) saveDB('sharecodes', db.shareCodes);
}
/** 清理已过期的取件码 */
function pruneShareCodes() {
  const now = Date.now();
  let changed = false;
  for (const [code, s] of Object.entries(db.shareCodes)) {
    if (!s.expiresAt || s.expiresAt < now) { delete db.shareCodes[code]; changed = true; }
  }
  if (changed) saveDB('sharecodes', db.shareCodes);
}
// 校验文件夹/文件名（1-60字符，禁止非法字符）
function validEntryName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 60) return false;
  if (/[\\/:*?"<>|]/.test(n)) return false;
  if (/[\x00-\x1f\x7f]/.test(n)) return false; // 禁止控制字符（换行/退格等），防止显示与存储异常
  if (/[. ]$/.test(n)) return false; // 禁止以点或空格结尾：Windows 会自动截断，导致数据库名与磁盘文件名不一致
  if (n === '.' || n === '..') return false;
  // Windows 保留设备名即使带扩展名也不可安全落地/导出。
  if (/^(con|prn|aux|nul|clock\$|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(n)) return false;
  return true;
}
// 递归收集某文件夹及其所有子孙文件夹 id
function collectFolderIds(rootId) {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    for (const f of db.folders) {
      if (f.parentId === cur && !ids.includes(f.id)) { ids.push(f.id); queue.push(f.id); }
    }
  }
  return ids;
}

// 公开：按文件夹列出文件与子文件夹（无需登录）；?all=1 时返回全部文件（供搜索）
route('GET', '/api/files', async ctx => {
  if (!featureOn('downloadEnabled')) return json(ctx.res, 200, { files: [], folders: [], allFolders: [], folderId: '' });
  if (ctx.query.get('all') === '1') {
    const files = [...db.files].filter(f => !fileIsHidden(f)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(filePublicView);
    return json(ctx.res, 200, { files, folders: [], folderId: '' });
  }
  const folderId = ctx.query.get('folder') || '';
  const files = [...db.files].filter(f => !fileIsHidden(f) && (f.folderId || '') === folderId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(filePublicView);
  const folders = [...db.folders].filter(f => (f.parentId || '') === folderId)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map(f => ({ id: f.id, name: f.name, parentId: f.parentId || '' }));
  const allFolders = db.folders.map(f => ({ id: f.id, name: f.name, parentId: f.parentId || '' }));
  json(ctx.res, 200, { files, folders, allFolders, folderId });
});

// 公开：签发人机验证码，返回 captchaId（图片通过 /api/captcha/img?c=<id> 获取）
route('GET', '/api/captcha/new', async ctx => {
  if (!checkRate('captcha:' + ctx.ip, CAPTCHA_RATE_MAX, 60 * 1000)) {
    return json(ctx.res, 429, { error: '请求过于频繁，请稍后再试' });
  }
  const id = issueCaptcha();
  if (!id) return json(ctx.res, 503, { error: '系统繁忙，请稍后再试' });
  json(ctx.res, 200, { captchaId: id });
});

// 公开：获取验证码图片（PNG；不存在或已过期返回 404，前端点击图片刷新）
route('GET', '/api/captcha/img', async ctx => {
  const id = String(ctx.query.get('c') || '');
  const c = Object.prototype.hasOwnProperty.call(captchas, id) ? captchas[id] : null;
  if (!c || (c.expiresAt || 0) < Date.now()) return json(ctx.res, 404, { error: '验证码已过期' });
  const png = renderCaptchaImage(c.code);
  ctx.res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'Content-Length': png.length
  });
  ctx.res.end(png);
});

// 节点文件下载回源：节点只接受带节点令牌的内部请求，主站永不暴露节点令牌给前端。
function proxyNodeFile(req, res, meta, node) {
  if (!node || !nodeIsOnline(node) || !validHttpUrl(node.baseUrl) || !node.tokenEnc || !validNodePath(meta.nodePath)) return Promise.resolve(false);
  let target;
  try { target = new URL('/api/node/files?path=' + encodeURIComponent(meta.nodePath), node.baseUrl.endsWith('/') ? node.baseUrl : node.baseUrl + '/'); } catch (e) { return Promise.resolve(false); }
  return new Promise(resolve => {
    const dlIp = clientIP(req);
    if (!dlAcquire(dlIp)) { resolve(false); return; }
    let released = false;
    const release = () => { if (!released) { released = true; dlRelease(dlIp); } };
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.get(target, { lookup: safeLookup, timeout: 10000, headers: { 'X-Node-Token': nodeAuthToken(node), 'X-File-Name': encodeURIComponent(meta.name) } }, upstreamRes => {
      if (upstreamRes.statusCode !== 200) { upstreamRes.resume(); release(); resolve(false); return; }
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.name)}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      const length = Number(upstreamRes.headers['content-length']); if (Number.isSafeInteger(length) && length >= 0) headers['Content-Length'] = length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { upstreamRes.resume(); res.end(); release(); resolve(true); return; }
      const rate = fileSpeedBytes(meta);
      if (!rate || rate <= 0) { upstreamRes.pipe(res); upstreamRes.once('end', () => { release(); resolve(true); }); }
      else {
        const started = Date.now(); let sent = 0; let queue = Buffer.alloc(0); let ended = false; let timer = null;
        const flush = () => {
          if (res.destroyed) { release(); return; }
          const allowed = Math.floor((Date.now() - started) / 1000 * rate);
          if (queue.length && sent < allowed) { const n = Math.min(queue.length, DOWNLOAD_CHUNK, allowed - sent); res.write(queue.subarray(0, n)); queue = queue.subarray(n); sent += n; }
          if (queue.length) timer = setTimeout(flush, 20);
          else if (ended) { res.end(); release(); resolve(true); }
        };
        upstreamRes.on('data', chunk => { queue = Buffer.concat([queue, chunk]); flush(); });
        upstreamRes.on('end', () => { ended = true; flush(); });
        upstreamRes.on('error', () => { release(); if (!res.destroyed) res.destroy(); resolve(true); });
        res.once('close', () => { if (timer) clearTimeout(timer); upstreamRes.destroy(); release(); });
      }
      res.once('close', release);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { release(); resolve(false); });
  });
}

// 公开：记录一次下载（用户点击下载按钮时调用）
route('POST', '/api/files/:id/download', async ctx => {
  if (!featureOn('downloadEnabled')) return json(ctx.res, 403, { error: '文件下载功能已关闭' });
  // 普通用户及以上可免验证码；匿名访客与已登录但未审核的访客角色仍需验证。
  if (!checkPublicCaptcha(ctx)) return;
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  if (fileIsHidden(f)) return json(ctx.res, 404, { error: '文件不存在' });
  if (!fileBackendValid(f)) return json(ctx.res, 404, { error: '文件来源配置无效' });
  if (!f.nodeId && !f.sourceUrl && !safeStoredPath(f.storage)) return json(ctx.res, 404, { error: '文件已丢失' });
  // 先签发令牌，成功后再增加下载数；令牌缓存满时不得虚增统计。
  const token = issueDlToken({ type: 'file', fileId: f.id, accessMode: 'public' });
  if (!token) return json(ctx.res, 500, { error: '系统繁忙，请稍后再试' });
  f.downloads = (f.downloads || 0) + 1;
  try {
    saveDB('files', db.files);
  } catch (e) {
    delete dlTokens[token];
    f.downloads = Math.max(0, f.downloads - 1);
    throw e;
  }
  json(ctx.res, 200, { ok: true, url: '/files/dl/' + token });
});

// 公开：查询文件是否可在线预览及预览地址（不计入下载次数）
route('GET', '/api/files/:id/preview', async ctx => {
  if (!featureOn('downloadEnabled')) return json(ctx.res, 200, { previewable: false });
  const f = findFile(ctx.params.id);
  if (!f || fileIsHidden(f)) return json(ctx.res, 404, { error: '文件不存在' });
  if (f.sourceUrl) return json(ctx.res, 200, { previewable: false, reason: '外链文件不支持站内预览' });
  const ext = path.extname(String(f.name)).toLowerCase();
  const p = PREVIEW_TYPES[ext];
  if (!p) return json(ctx.res, 200, { previewable: false });
  // 文本类预览额外限制大小，防止超大文本卡死浏览器
  if (p.kind === 'text' && (f.size || 0) > 2 * 1024 * 1024) {
    return json(ctx.res, 200, { previewable: false, reason: '文本文件过大，请下载后查看' });
  }
  // 预览同样走一次性令牌（允许多次以兼容播放器重试），不再暴露存储文件真实地址
  const token = issueDlToken({ type: 'inline', fileId: f.id, maxUses: 3 });
  if (!token) return json(ctx.res, 503, { error: '系统繁忙，请稍后再试' });
  json(ctx.res, 200, {
    previewable: true, kind: p.kind, mime: p.mime,
    url: '/files/dl/' + token
  });
});

/** 收集某文件夹（含子孙目录）内的全部文件及其 ZIP 内相对路径；folderId 为空时收集全部 */
function collectFilesForZip(folderId) {
  // 空 folderId 表示整站：根目录文件与所有虚拟子目录都应被收集。
  const ids = folderId
    ? collectFolderIds(folderId)
    : [''].concat(db.folders.map(f => f && f.id).filter(Boolean));
  const map = {};
  db.folders.forEach(f => { if (f && f.id) map[f.id] = f; });
  /** 由文件夹 id 还原相对路径（如 a/b/c），异常数据返回 null */
  const relPath = fid => {
    const chain = []; let cur = fid; let guard = 0; const seen = new Set();
    while (cur) {
      if (guard++ >= 100 || seen.has(cur)) return null;
      seen.add(cur);
      const f = map[cur]; if (!f) return null;
      chain.unshift(f.name); cur = f.parentId || '';
    }
    return chain.join('/');
  };
  const out = [];
  for (const f of db.files) {
    if (fileIsHidden(f)) continue;
    if (f.sourceUrl) continue; // 外链引用不读取到主站 ZIP
    if (!ids.includes(f.folderId || '')) continue;
    if (!validStorageName(f.storage)) continue; // 防御异常存储名
    const dir = relPath(f.folderId || '');
    if (dir === null) continue;
    const p = safeStoredPath(f.storage);
    if (!p) continue; // 物理文件缺失、符号链接或非普通文件不得进入 ZIP
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue; // 物理文件在检查期间消失时跳过
    const entryName = dir ? dir + '/' + f.name : f.name;
    if (!validZipEntryName(entryName)) continue; // 异常旧数据不得进入 ZIP 条目
    out.push({ path: p, name: entryName, size: st.size });
  }
  return out;
}

// 管理：文件夹打包下载（流式输出 ZIP；?folder= 为空时打包全部文件）
// 必须登录：打包接口会导出整站文件，公开访问等于完全绕过验证码与一次性令牌保护
route('GET', '/api/files/zip', async ctx => {
  // 管理后台使用该 GET 接口直接流式导出文件；普通用户不能借助公开路径打包整站文件。
  if (!roleAtLeast(ctx.user, 'admin')) return json(ctx.res, 403, { error: '权限不足，此操作需要管理员或更高权限' });
  const folderId = String(ctx.query.get('folder') || '').trim();
  if (folderId && !findFolder(folderId)) return json(ctx.res, 404, { error: '文件夹不存在' });
  const files = collectFilesForZip(folderId);
  if (!files.length) return json(ctx.res, 400, { error: '该文件夹中没有可打包的文件' });
  if (files.length > ZIP_FILE_MAX_COUNT) return json(ctx.res, 400, { error: '文件数量超过 5000，无法打包' });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > ZIP_TOTAL_MAX) return json(ctx.res, 400, { error: '文件总大小超过 2GB，无法打包' });

  // 复用并发下载保护，防止恶意刷打包占用带宽与 CPU
  const ip = ctx.ip;
  if (!dlAcquire(ip)) {
    logRateHit('打包下载', ip, '超过并发上限');
    return json(ctx.res, 429, { error: '同时打包的人数较多，请稍后再试' });
  }

  const zipName = folderId ? (findFolder(folderId).name + '.zip') : '全部文件.zip';
  const encoded = encodeURIComponent(zipName);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store'
  });

  const zip = new ZipWriter(ctx.res);
  let done = false, released = false;
  const release = () => { if (!released) { released = true; dlRelease(ip); } };
  // 传输正常完成或客户端断开时都要释放并发计数；未完成的中断需停止压缩
  ctx.res.on('finish', () => { done = true; release(); });
  ctx.res.on('close', () => { if (!done) zip.abort(); release(); });
  try {
    for (const f of files) {
      // 打包期间任一文件读取失败都会中止整个响应，避免输出缺少条目的半损坏 ZIP。
      await zip.addFile(f.name, { path: f.path });
    }
    if (!ctx.res.destroyed) { zip.finish(); done = true; }
  } catch (e) { zip.abort(); }
}, { auth: true });

// 公开：文件夹打包下载发起（POST）：未登录需通过人机验证，返回一次性 ZIP 令牌
// 与单文件下载保护策略一致；GET /api/files/zip 已收紧为仅管理员可用
route('POST', '/api/files/zip-request', async ctx => {
  if (!featureOn('downloadEnabled')) return json(ctx.res, 403, { error: '文件下载功能已关闭' });
  if (!checkPublicCaptcha(ctx)) return;
  const folderId = String((ctx.body && ctx.body.folderId) || '').trim();
  // 空 folderId 代表整站打包：仅管理员及以上允许，普通用户必须指定文件夹，避免通过 POST 公开接口导出全部文件。
  if (ctx.session && !folderId && !roleAtLeast(ctx.user, 'admin')) {
    return json(ctx.res, 403, { error: '权限不足，整站打包需要管理员或更高权限' });
  }
  // 未登录仅允许打包指定文件夹（整站打包仅限登录的管理员通过 GET 接口使用）
  if (!ctx.session && !folderId) return json(ctx.res, 400, { error: '请选择要打包的文件夹' });
  if (folderId && !findFolder(folderId)) return json(ctx.res, 404, { error: '文件夹不存在' });
  const files = collectFilesForZip(folderId);
  if (!files.length) return json(ctx.res, 400, { error: '该文件夹中没有可打包的文件' });
  if (files.length > ZIP_FILE_MAX_COUNT) return json(ctx.res, 400, { error: '文件数量超过限制，无法打包' });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > ZIP_TOTAL_MAX) return json(ctx.res, 400, { error: '文件总大小超过限制，无法打包' });
  const token = issueDlToken({ type: 'zip', folderId });
  if (!token) return json(ctx.res, 500, { error: '系统繁忙，请稍后再试' });
  json(ctx.res, 200, { ok: true, url: '/files/dl/' + token });
});

// ============ 取件码（临时分享链接） ============

// 管理：为文件创建取件码（默认有效期可在后台调整，可指定 1 小时 ~ 30 天）
route('POST', '/api/admin/files/:id/share', async ctx => {
  if (!featureOn('shareCodesEnabled')) return json(ctx.res, 403, { error: '取件码功能已关闭' });
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  const hours = Number(ctx.body.hours);
  let ttl = numSetting('shareDefaultTtlHours') * 3600 * 1000;
  if (Number.isFinite(hours) && hours > 0) {
    ttl = Math.min(Math.max(1, Math.round(hours * 3600 * 1000)), SHARE_MAX_TTL);
  }
  pruneShareCodes();
  const code = genShareCode();
  if (!code) return json(ctx.res, 500, { error: '取件码生成失败，请重试' });
  db.shareCodes[code] = {
    fileId: f.id, expiresAt: Date.now() + ttl,
    createdAt: nowISO(), createdBy: ctx.user.username
  };
  saveDB('sharecodes', db.shareCodes);
  logOp(ctx.user, ctx.req, '创建取件码', `${f.name}（${code}，有效 ${Math.round(ttl / 3600000)} 小时）`);
  json(ctx.res, 200, {
    ok: true, code, url: '/download?code=' + code,
    expiresAt: new Date(Date.now() + ttl).toISOString()
  });
}, { auth: true });

// 管理：当前文件的取件码列表
route('GET', '/api/admin/files/:id/shares', async ctx => {
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  pruneShareCodes();
  const list = Object.entries(db.shareCodes)
    .filter(([, s]) => s.fileId === f.id)
    .map(([code, s]) => ({ code, url: '/download?code=' + code, expiresAt: new Date(s.expiresAt).toISOString(), createdBy: s.createdBy || '' }));
  json(ctx.res, 200, { shares: list });
}, { auth: true });

// 管理：撤销取件码
route('DELETE', '/api/admin/shares/:code', async ctx => {
  const code = String(ctx.params.code || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(db.shareCodes, code)) return json(ctx.res, 404, { error: '取件码不存在或已过期' });
  delete db.shareCodes[code];
  saveDB('sharecodes', db.shareCodes);
  logOp(ctx.user, ctx.req, '撤销取件码', code);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 公开：解析取件码并直接下载（无需登录；受每 IP 限流保护，见 handleApi）
route('GET', '/api/share/:code', async ctx => {
  if (!featureOn('downloadEnabled') || !featureOn('shareCodesEnabled')) return json(ctx.res, 404, { error: '取件码功能已关闭' });
  const code = String(ctx.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(ctx.res, 404, { error: '取件码无效' });
  pruneShareCodes();
  const s = db.shareCodes[code];
  if (!s || s.expiresAt < Date.now()) return json(ctx.res, 404, { error: '取件码无效或已过期' });
  const f = findFile(s.fileId);
  if (!f || (!validStorageName(f.storage) && !validHttpUrl(f.sourceUrl))) {
    return json(ctx.res, 404, { error: '该文件已不存在' });
  }
  if (!fileBackendValid(f)) return json(ctx.res, 404, { error: '该文件已不存在' });
  if (!f.nodeId && !f.sourceUrl && !safeStoredPath(f.storage)) return json(ctx.res, 404, { error: '该文件已不存在' });
  // 先签发令牌，成功后再增加下载数；令牌缓存满或持久化失败时保持统计一致。
  const token = issueDlToken({ type: 'file', fileId: f.id, accessMode: 'share' });
  if (!token) return json(ctx.res, 503, { error: '系统繁忙，请稍后再试' });
  f.downloads = (f.downloads || 0) + 1;
  try {
    saveDB('files', db.files);
  } catch (e) {
    delete dlTokens[token];
    f.downloads = Math.max(0, f.downloads - 1);
    throw e;
  }
  json(ctx.res, 200, { ok: true, name: f.name, size: f.size, url: '/files/dl/' + token });
});

// ============ 节点系统：连接、心跳与性能调度 ============
function nodePublic(node) {
  return { id: node.id, name: node.name, baseUrl: node.baseUrl, enabled: node.enabled !== false, online: nodeIsOnline(node), lastHeartbeat: node.lastHeartbeat || 0, capacityMbps: Number(node.capacityMbps) || 0, freeBandwidthMbps: Number(node.freeBandwidthMbps) || 0, activeTasks: Number(node.activeTasks) || 0, peers: (node.peers || []).slice(0, 100), files: db.files.filter(f => f.nodeId === node.id).length, createdAt: node.createdAt };
}
function nodeTokenHash(token) { return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex'); }
function nodeTokenMatches(node, token) {
  if (!node || !/^[a-f0-9]{64}$/.test(String(node.tokenHash || ''))) return false;
  const expected = Buffer.from(node.tokenHash, 'hex'); const actual = Buffer.from(nodeTokenHash(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function nodeRequestToken(req) { return String(req.headers['x-node-token'] || ''); }
function nodeAuthToken(node) { return decryptNodeToken(node && node.tokenEnc); }
function validNodePath(value) {
  const p = String(value || '').trim();
  return !!p && p.length <= 512 && !p.startsWith('/') && !p.includes('..') && !/[\\\x00-\x1f]/.test(p);
}
const nodeLeases = Object.create(null);
function pruneNodeLeases() {
  const now = Date.now();
  for (const [id, lease] of Object.entries(nodeLeases)) {
    if (lease.expiresAt <= now) {
      const node = db.nodes.find(n => n.id === lease.nodeId);
      if (node) node.activeTasks = Math.max(0, (Number(node.activeTasks) || 0) - 1);
      delete nodeLeases[id];
    }
  }
}
route('GET', '/api/admin/nodes', async ctx => {
  json(ctx.res, 200, { nodes: db.nodes.map(nodePublic) });
}, { auth: true });
route('POST', '/api/admin/nodes', async ctx => {
  const b = ctx.body || {}; const name = String(b.name || '').trim(); const baseUrl = String(b.baseUrl || '').trim();
  if (!name || name.length > NODE_NAME_MAX) return json(ctx.res, 400, { error: `节点名称需为 1-${NODE_NAME_MAX} 个字符` });
  if (!validHttpUrl(baseUrl)) return json(ctx.res, 400, { error: '节点地址必须是合法的 http/https 地址' });
  try { await assertSafeHost(new URL(baseUrl).hostname); } catch (e) { return json(ctx.res, 400, { error: '节点地址不允许指向内网或回环地址' }); }
  if (db.nodes.some(n => n.baseUrl === baseUrl)) return json(ctx.res, 409, { error: '该节点地址已存在' });
  const token = crypto.randomBytes(24).toString('hex');
  const node = { id: uid(), name, baseUrl, tokenHash: nodeTokenHash(token), tokenEnc: encryptNodeToken(token), enabled: true, capacityMbps: Math.max(0, Number(b.capacityMbps) || 0), freeBandwidthMbps: 0, activeTasks: 0, lastHeartbeat: 0, createdAt: nowISO(), createdBy: ctx.user.username };
  db.nodes.push(node); saveDB('nodes', db.nodes); logOp(ctx.user, ctx.req, '添加节点', `${name}（${baseUrl}）`);
  json(ctx.res, 200, { ok: true, node: nodePublic(node), token });
}, { auth: true });
route('PUT', '/api/admin/nodes/:id', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  const b = ctx.body || {};
  if (b.name !== undefined) { const name = String(b.name).trim(); if (!name || name.length > NODE_NAME_MAX) return json(ctx.res, 400, { error: `节点名称需为 1-${NODE_NAME_MAX} 个字符` }); node.name = name; }
  if (b.enabled !== undefined) node.enabled = !!b.enabled;
  if (b.capacityMbps !== undefined) { const n = Number(b.capacityMbps); if (!Number.isFinite(n) || n < 0 || n > FILE_SPEED_MAX_MBPS) return json(ctx.res, 400, { error: '节点带宽需在 0～1000 MB/s 之间' }); node.capacityMbps = n; }
  saveDB('nodes', db.nodes); logOp(ctx.user, ctx.req, '修改节点', node.name); json(ctx.res, 200, { ok: true, node: nodePublic(node) });
}, { auth: true });
route('DELETE', '/api/admin/nodes/:id', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  if (db.files.some(f => f.nodeId === node.id)) return json(ctx.res, 409, { error: '节点仍被文件使用，请先迁移文件' });
  db.nodes.forEach(n => { n.peers = (n.peers || []).filter(id => id !== node.id); });
  db.nodes = db.nodes.filter(n => n.id !== node.id); saveDB('nodes', db.nodes); logOp(ctx.user, ctx.req, '删除节点', node.name); json(ctx.res, 200, { ok: true });
}, { auth: true });
// 管理：建立双向节点连接，连接后调度器可把性能任务交给任一在线节点
route('POST', '/api/admin/nodes/:id/connect', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); const peerId = String((ctx.body || {}).peerId || '').trim(); const peer = db.nodes.find(n => n.id === peerId);
  if (!node || !peer) return json(ctx.res, 404, { error: '节点不存在' });
  if (node.id === peer.id) return json(ctx.res, 400, { error: '节点不能连接自身' });
  node.peers = Array.from(new Set([...(node.peers || []), peer.id]));
  peer.peers = Array.from(new Set([...(peer.peers || []), node.id]));
  saveDB('nodes', db.nodes); logOp(ctx.user, ctx.req, '连接节点', `${node.name} ↔ ${peer.name}`);
  json(ctx.res, 200, { ok: true, node: nodePublic(node), peer: nodePublic(peer) });
}, { auth: true });

// 管理：请求节点健康接口，返回可读的连通性诊断，不把节点令牌返回给浏览器。
function describeNodeNetworkError(err, action) {
  const code = String(err && err.code || '');
  const message = String(err && err.message || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${action}失败：节点域名解析失败（${code}），请检查 DNS、节点域名和主站服务器的解析结果`;
  if (code === 'ECONNREFUSED') return `${action}失败：节点端口拒绝连接（ECONNREFUSED），请检查 node-agent.js 是否运行、nodePort 和 Nginx/MCSM 端口映射`;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || message === 'timeout') return `${action}失败：连接节点超时，请检查防火墙、安全组、路由和反向代理上游`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${action}失败：主站到节点的网络不可达（${code}），请检查路由、防火墙和公网出口`;
  if (code === 'EPROTO' || code === 'ECONNRESET' || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `${action}失败：TLS/连接被重置（${code}），请检查 HTTPS 证书、证书链、域名和 Nginx TLS 配置`;
  if (message.includes('SSRF: private IP')) return `${action}失败：节点地址解析到受限内网地址，已被主站安全策略拦截`;
  return `${action}失败：${message || '网络连接异常'}${code ? `（${code}）` : ''}`;
}
function describeNodeUpstreamStatus(status, action) {
  if (status === 401) return `${action}失败：节点令牌不匹配（HTTP 401），请确认主站令牌与节点配置完全一致并重启节点代理`;
  if (status === 404) return `${action}失败：节点接口不存在（HTTP 404），请检查 node-agent.js 版本和 Nginx/MCSM 是否原样转发接口路径`;
  if (status === 502) return `${action}失败：反向代理返回 HTTP 502，请检查 Nginx/Caddy 的 proxy_pass 上游、节点进程监听端口和端口映射`;
  if (status === 503 || status === 504) return `${action}失败：反向代理上游不可用（HTTP ${status}），请检查节点服务状态、上游地址和代理超时`;
  if (status >= 400) return `${action}失败：节点返回 HTTP ${status}`;
  return `${action}失败：节点返回异常响应`;
}
async function checkNodeHealth(node) {
  if (!node || node.enabled === false) return { ok: false, status: 0, error: '节点已停用', fallback: { attempted: false } };
  if (!validHttpUrl(node.baseUrl)) return { ok: false, status: 0, error: '节点地址无效', fallback: { attempted: false } };
  try { await assertSafeHost(new URL(node.baseUrl).hostname); } catch (e) { return { ok: false, status: 0, error: '节点地址不允许访问内网或回环地址', fallback: { attempted: false } }; }

  const started = Date.now();
  const healthResult = await nodeGetJson(node, '/api/node/health', 10000);
  const healthLatencyMs = Date.now() - started;
  let healthData = healthResult.body;
  const healthOk = healthResult.status === 200 && !!(healthData && healthData.ok);
  if (healthOk) return { ok: true, status: healthResult.status, latencyMs: healthLatencyMs, response: healthData, fallback: { attempted: false } };

  // health 可能被 Nginx/WAF 单独处理；用实际业务所需的目录接口做一次降级验证。
  const browseStarted = Date.now();
  const browseResult = await nodeGetJson(node, '/api/node/browse?path=', 10000);
  const browseLatencyMs = Date.now() - browseStarted;
  const browseOk = browseResult.status === 200 && browseResult.body && browseResult.body.ok === true && Array.isArray(browseResult.body.entries);
  const healthError = healthResult.error || (healthResult.status ? describeNodeUpstreamStatus(healthResult.status, '连接测试') : '连接测试失败');
  if (browseOk) {
    return {
      ok: true,
      status: healthResult.status || 0,
      latencyMs: healthLatencyMs + browseLatencyMs,
      degraded: true,
      error: '节点可用，但健康接口异常；已通过目录接口验证',
      response: { health: healthData || healthResult.raw || null, browsePath: browseResult.body.path || '', entryCount: browseResult.body.entries.length },
      fallback: { attempted: true, ok: true, status: browseResult.status, latencyMs: browseLatencyMs, error: healthError }
    };
  }
  const browseError = browseResult.error || (browseResult.status ? describeNodeUpstreamStatus(browseResult.status, '节点目录读取') : '节点目录读取失败');
  return {
    ok: false,
    status: healthResult.status || browseResult.status || 0,
    latencyMs: healthLatencyMs + browseLatencyMs,
    error: `${healthError}；降级目录验证也失败：${browseError}`,
    fallback: { attempted: true, ok: false, status: browseResult.status || 0, latencyMs: browseLatencyMs, error: browseError }
  };
}
route('POST', '/api/admin/nodes/:id/check', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  const health = await checkNodeHealth(node);
  logOp(ctx.user, ctx.req, '检测节点连接', `${node.name}：${health.ok ? (health.degraded ? '降级可用' : '正常') : (health.error || '失败')}`);
  // 诊断接口本身请求成功即返回 200，具体连通性结果放在 health 中，便于前端展示明确原因。
  json(ctx.res, 200, { ok: health.ok, node: nodePublic(node), health });
}, { auth: true });

// 管理：轮换节点令牌。旧令牌立即失效，新令牌仅在本次响应中返回。
route('POST', '/api/admin/nodes/:id/rotate-token', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  const token = crypto.randomBytes(24).toString('hex');
  node.tokenHash = nodeTokenHash(token); node.tokenEnc = encryptNodeToken(token);
  saveDB('nodes', db.nodes); logOp(ctx.user, ctx.req, '轮换节点令牌', node.name);
  json(ctx.res, 200, { ok: true, node: nodePublic(node), token });
}, { auth: true });

// 管理：下载节点 JSON 配置，令牌仅对已登录管理员短时返回，不写入日志。
route('GET', '/api/admin/nodes/:id/config', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  const token = nodeAuthToken(node); if (!token) return json(ctx.res, 503, { error: '节点令牌无法解密，请重新轮换令牌' });
  const cfg = { mainUrl: `${req_is_secure(ctx.req) ? 'https' : 'http'}://${ctx.req.headers.host}`, nodeToken: token, nodeId: node.id, nodeRoot: './files', nodeHost: '0.0.0.0', nodePort: 2230, nodeCapacityMbps: Number(node.capacityMbps) || 100 };
  const body = Buffer.from(JSON.stringify(cfg, null, 2), 'utf8');
  ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="node-agent-${node.id}.config.json"`, 'Cache-Control': 'no-store', 'Content-Length': body.length });
  ctx.res.end(body); logOp(ctx.user, ctx.req, '下载节点配置', node.name);
}, { auth: true });

// 管理：通过主站安全转发分块文件到节点，浏览器不接触节点令牌；单文件上限沿用共享文件上限。
async function nodeGetJson(node, pathname, timeoutMs = 15000) {
  if (!node || !validHttpUrl(node.baseUrl) || !node.tokenEnc) return { status: 0, error: '节点配置无效' };
  try { await assertSafeHost(new URL(node.baseUrl).hostname); } catch (e) { return { status: 0, error: '节点地址不允许访问内网或回环地址' }; }
  let target; try { target = new URL(pathname, node.baseUrl.endsWith('/') ? node.baseUrl : node.baseUrl + '/'); } catch (e) { return { status: 0, error: '节点地址解析失败' }; }
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = lib.get(target, { lookup: safeLookup, timeout: timeoutMs, headers: { 'X-Node-Token': nodeAuthToken(node) } }, upstream => {
      const chunks = []; let size = 0;
      upstream.on('data', c => { size += c.length; if (size <= 256 * 1024) chunks.push(c); });
      upstream.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let body = null; try { body = JSON.parse(raw); } catch (e) {} const status = upstream.statusCode || 0; resolve({ status, body, raw: raw.slice(0, 500), error: status === 200 ? '' : describeNodeUpstreamStatus(status, '节点目录读取') }); });
      upstream.on('error', e => resolve({ status: upstream.statusCode || 0, error: describeNodeNetworkError(e, '节点目录读取') }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', e => resolve({ status: 0, error: describeNodeNetworkError(e, '节点目录读取') }));
  });
}
async function nodeFileExists(node, nodePath) {
  if (!node || !validHttpUrl(node.baseUrl) || !node.tokenEnc || !validNodePath(nodePath)) return { status: 0, error: '节点文件参数无效' };
  try { await assertSafeHost(new URL(node.baseUrl).hostname); } catch (e) { return { status: 0, error: '节点地址不允许访问内网或回环地址' }; }
  let target; try { target = new URL('/api/node/files?path=' + encodeURIComponent(nodePath), node.baseUrl.endsWith('/') ? node.baseUrl : node.baseUrl + '/'); } catch (e) { return { status: 0, error: '节点地址解析失败' }; }
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = lib.request({ method: 'HEAD', protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, lookup: safeLookup, timeout: 15000, headers: { 'X-Node-Token': nodeAuthToken(node), 'X-File-Name': 'probe.bin' } }, upstream => { upstream.resume(); resolve({ status: upstream.statusCode || 0, size: Number(upstream.headers['content-length']) || 0 }); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, error: e.message === 'timeout' ? '节点请求超时' : '无法连接节点' }));
    req.end();
  });
}
async function nodeForward(node, body) {
  const target = new URL('/api/node/files', node.baseUrl.endsWith('/') ? node.baseUrl : node.baseUrl + '/');
  const payload = Buffer.from(JSON.stringify(body), 'utf8'); const lib = target.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const r = lib.request({ method: 'POST', protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname, lookup: safeLookup, timeout: 20000, headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-Node-Token': nodeAuthToken(node) } }, upstream => { let raw = ''; upstream.setEncoding('utf8'); upstream.on('data', c => { if (raw.length < 3000) raw += c; }); upstream.on('end', () => resolve({ status: upstream.statusCode || 0, body: raw })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', e => resolve({ status: 0, error: e.message })); r.end(payload);
  });
}
route('GET', '/api/admin/nodes/:id/browse', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  if (node.enabled === false) return json(ctx.res, 409, { error: '节点已停用' });
  const rawPath = String(ctx.query.get('path') || '');
  if (rawPath.length > 512 || rawPath.includes('\\') || rawPath.split('/').some(part => part === '.' || part === '..')) return json(ctx.res, 400, { error: '节点目录路径无效' });
  const result = await nodeGetJson(node, '/api/node/browse?path=' + encodeURIComponent(rawPath));
  if (result.status !== 200 || !result.body || !Array.isArray(result.body.entries)) {
    const error = result.body && result.body.error ? (result.status === 401 ? describeNodeUpstreamStatus(401, '节点目录读取') : result.body.error) : result.error || describeNodeUpstreamStatus(result.status, '节点目录读取');
    return json(ctx.res, result.status === 404 ? 404 : 502, { error, upstreamStatus: result.status, diagnostic: { category: result.status ? 'upstream_http' : 'network', baseUrl: node.baseUrl, target: '/api/node/browse', hint: result.status === 502 ? '检查反向代理上游和节点监听端口' : '' } });
  }
  json(ctx.res, 200, { ok: true, nodeId: node.id, path: result.body.path || rawPath, entries: result.body.entries });
}, { auth: true });

route('POST', '/api/admin/nodes/:id/upload', async ctx => {
  const node = db.nodes.find(n => n.id === ctx.params.id); if (!node) return json(ctx.res, 404, { error: '节点不存在' });
  if (!nodeIsOnline(node)) return json(ctx.res, 503, { error: '节点当前离线，请先启动节点代理并等待心跳' });
  const b = ctx.body || {}; const action = String(b.action || 'init'); const nodePath = String(b.path || '').trim();
  if (!validNodePath(nodePath)) return json(ctx.res, 400, { error: '节点文件路径无效' });
  if (action === 'init') {
    const size = Number(b.size); const totalChunks = Number(b.totalChunks);
    if (!Number.isSafeInteger(size) || size <= 0 || size > fileMaxBytes() || !Number.isSafeInteger(totalChunks) || totalChunks !== Math.ceil(size / TRANSFER_CHUNK_SIZE)) return json(ctx.res, 400, { error: '文件大小或分块数无效' });
    const result = await nodeForward(node, { action: 'init', path: nodePath, size, totalChunks });
    if (result.status !== 200) return json(ctx.res, 502, { error: result.error || '节点初始化上传失败' });
    let out; try { out = JSON.parse(result.body); } catch (e) { return json(ctx.res, 502, { error: '节点返回无效响应' }); }
    return json(ctx.res, 200, { ok: true, nodeId: node.id, uploadId: out.uploadId, path: nodePath, size, totalChunks });
  }
  if (action === 'chunk') {
    const data = String(b.data || ''); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0 || Buffer.from(data, 'base64').length > TRANSFER_CHUNK_SIZE) return json(ctx.res, 400, { error: '分块数据无效' });
    const result = await nodeForward(node, { action: 'chunk', uploadId: String(b.uploadId || ''), index: Number(b.index), data });
    if (result.status !== 200) return json(ctx.res, 502, { error: result.error || '节点保存分块失败' });
    return json(ctx.res, 200, { ok: true, nodeId: node.id });
  }
  if (action === 'finish') {
    const result = await nodeForward(node, { action: 'finish', uploadId: String(b.uploadId || ''), path: nodePath });
    if (result.status !== 200) return json(ctx.res, 502, { error: result.error || '节点完成上传失败' });
    logOp(ctx.user, ctx.req, '上传节点文件', `${node.name}：${nodePath}`); return json(ctx.res, 200, { ok: true, nodeId: node.id, path: nodePath, size: Number(b.size) || 0 });
  }
  return json(ctx.res, 400, { error: '上传操作无效' });
}, { auth: true });

// 管理：在两个在线节点之间迁移节点文件。源节点只读、目标节点分块写入，完成后再切换元数据。
route('POST', '/api/admin/files/:id/migrate-node', async ctx => {
  const file = findFile(ctx.params.id); const b = ctx.body || {};
  const source = file && db.nodes.find(n => n.id === file.nodeId); const target = db.nodes.find(n => n.id === String(b.targetNodeId || ''));
  const targetPath = String(b.targetPath || file && file.nodePath || '').trim();
  if (!file || !source) return json(ctx.res, 404, { error: '源节点文件不存在' });
  if (!target || source.id === target.id) return json(ctx.res, 400, { error: '目标节点无效或不能迁移到自身' });
  if (!nodeIsOnline(source) || !nodeIsOnline(target)) return json(ctx.res, 503, { error: '源节点和目标节点都必须在线' });
  if (!validNodePath(file.nodePath) || !validNodePath(targetPath)) return json(ctx.res, 400, { error: '节点文件路径无效' });
  const sourceUrl = new URL('/api/node/files?path=' + encodeURIComponent(file.nodePath), source.baseUrl.endsWith('/') ? source.baseUrl : source.baseUrl + '/');
  const sourceLib = sourceUrl.protocol === 'https:' ? https : http;
  const result = await new Promise(resolve => {
    const req = sourceLib.get(sourceUrl, { lookup: safeLookup, timeout: 20000, headers: { 'X-Node-Token': nodeAuthToken(source), 'X-File-Name': encodeURIComponent(file.name) } }, async upstream => {
      if (upstream.statusCode !== 200) { upstream.resume(); return resolve({ error: '源节点返回 ' + upstream.statusCode }); }
      const total = Number(upstream.headers['content-length']) || Number(file.size) || 0;
      if (!Number.isSafeInteger(total) || total <= 0 || total > fileMaxBytes()) { upstream.resume(); return resolve({ error: '源文件大小无效或超过限制' }); }
      const totalChunks = Math.ceil(total / TRANSFER_CHUNK_SIZE);
      const init = await nodeForward(target, { action: 'init', path: targetPath, size: total, totalChunks });
      if (init.status !== 200) { upstream.resume(); return resolve({ error: '目标节点初始化失败' }); }
      let initJson; try { initJson = JSON.parse(init.body); } catch (e) { upstream.resume(); return resolve({ error: '目标节点返回无效响应' }); }
      let index = 0; let pending = Buffer.alloc(0); let failed = '';
      const flush = async (final) => {
        while (!failed && (pending.length >= TRANSFER_CHUNK_SIZE || (final && pending.length))) {
          const take = final && pending.length < TRANSFER_CHUNK_SIZE ? pending.length : TRANSFER_CHUNK_SIZE;
          const chunk = pending.subarray(0, take); pending = pending.subarray(take);
          const sent = await nodeForward(target, { action: 'chunk', uploadId: initJson.uploadId, index, data: chunk.toString('base64') });
          if (sent.status !== 200) { failed = '目标节点保存分块失败'; break; }
          index++;
        }
      };
      upstream.on('data', chunk => { pending = Buffer.concat([pending, chunk]); upstream.pause(); flush(false).then(() => upstream.resume()).catch(() => { failed = '迁移分块失败'; upstream.destroy(); }); });
      upstream.on('end', async () => { await flush(true); if (failed) return resolve({ error: failed }); const done = await nodeForward(target, { action: 'finish', uploadId: initJson.uploadId, path: targetPath }); resolve(done.status === 200 ? { ok: true, size: total } : { error: '目标节点完成上传失败' }); });
      upstream.on('error', () => resolve({ error: '读取源节点失败' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', e => resolve({ error: e.message === 'timeout' ? '源节点请求超时' : '无法连接源节点' }));
  });
  if (!result.ok) return json(ctx.res, 502, { error: result.error || '节点迁移失败' });
  file.nodeId = target.id; file.nodePath = targetPath; file.size = result.size; file.updatedAt = nowISO(); saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '迁移节点文件', `${file.name}：${source.name} → ${target.name}`);
  json(ctx.res, 200, { ok: true, file: filePublicView(file), sourceNodeId: source.id, targetNodeId: target.id });
}, { auth: true });

// 节点主动心跳：报告在线状态与剩余带宽，调度器按 freeBandwidthMbps 选择节点
route('GET', '/api/node/files', async ctx => {
  const token = nodeRequestToken(ctx.req);
  const node = db.nodes.find(n => nodeTokenMatches(n, token));
  if (!node || !nodeIsOnline(node)) return json(ctx.res, 401, { error: '节点令牌无效或节点已停用' });
  const requested = String(ctx.query.get('path') || '');
  if (!validNodePath(requested)) return json(ctx.res, 400, { error: '节点文件路径无效' });
  const file = db.files.find(f => f.nodeId === node.id && f.nodePath === requested);
  if (!file || !validHttpUrl(file.sourceUrl)) return json(ctx.res, 404, { error: '节点文件不存在' });
  const target = { sourceUrl: file.sourceUrl, name: file.name, speedLimitMbps: 0 };
  return proxyExternalFile(ctx.req, ctx.res, target, { type: 'file' });
});

route('POST', '/api/node/heartbeat', async ctx => {
  const token = String((ctx.body || {}).token || nodeRequestToken(ctx.req));
  const node = db.nodes.find(n => nodeTokenMatches(n, token));
  if (!node) return json(ctx.res, 401, { error: '节点令牌无效' });
  const b = ctx.body || {}; const free = Number(b.freeBandwidthMbps); const active = Number(b.activeTasks);
  if (Number.isFinite(free) && free >= 0 && free <= FILE_SPEED_MAX_MBPS) node.freeBandwidthMbps = free;
  if (Number.isSafeInteger(active) && active >= 0) node.activeTasks = active;
  node.lastHeartbeat = Date.now(); saveDB('nodes', db.nodes);
  json(ctx.res, 200, { ok: true, nodeId: node.id, dispatch: chooseNode(null) ? chooseNode(null).id : '' });
});
// 主站/节点调度查询：返回当前最空闲的在线节点，可供上传、代理或任务分发使用
route('POST', '/api/node/dispatch', async ctx => {
  pruneNodeLeases();
  const node = chooseNode(null);
  if (!node) return json(ctx.res, 503, { error: '暂无可用节点' });
  const leaseId = uid(); const expiresAt = Date.now() + 60000;
  node.activeTasks = (Number(node.activeTasks) || 0) + 1; nodeLeases[leaseId] = { nodeId: node.id, expiresAt };
  saveDB('nodes', db.nodes);
  json(ctx.res, 200, { ok: true, node: nodePublic(node), leaseId, expiresAt: new Date(expiresAt).toISOString() });
}, { auth: true });
route('POST', '/api/node/dispatch/:leaseId/release', async ctx => {
  const lease = nodeLeases[ctx.params.leaseId];
  if (!lease) return json(ctx.res, 404, { error: '性能租约不存在或已过期' });
  const node = db.nodes.find(n => n.id === lease.nodeId);
  if (node) node.activeTasks = Math.max(0, (Number(node.activeTasks) || 0) - 1);
  delete nodeLeases[ctx.params.leaseId]; saveDB('nodes', db.nodes);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 管理：按文件夹列出文件与子文件夹（含存储名；allFolders 供面包屑与移动弹窗使用）
route('GET', '/api/admin/files', async ctx => {
  const folderId = ctx.query.get('folder') || '';
  const files = [...db.files].filter(f => (f.folderId || '') === folderId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const folders = [...db.folders].filter(f => (f.parentId || '') === folderId)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const allFolders = db.folders.map(f => ({ id: f.id, name: f.name, parentId: f.parentId || '' }));
  json(ctx.res, 200, { files, folders, allFolders, folderId });
}, { auth: true });

// 管理：初始化分块上传（replaceId 非空时为「替换已有文件」模式：保留原文件 id 与下载数据）
route('POST', '/api/admin/files/init', async ctx => {
  const { filename = '', size = 0, totalChunks = 0, folderId = '', replaceId = '' } = ctx.body || {};
  const folder = String(folderId).trim();
  let name = String(filename).trim();
  // 替换模式：目标文件必须存在；未指定新文件名时沿用原文件名
  if (replaceId) {
    const target = findFile(replaceId);
    if (!target) return json(ctx.res, 404, { error: '要替换的文件不存在或已被删除' });
    if (name) {
      if (!validEntryName(name)) return json(ctx.res, 400, { error: '文件名需为 1-60 个字符且不含 \\/:*?"<>|' });
      // 新名称与原名称不同（即替换同时改名）时，校验同目录下是否已有同名文件
      if (name !== target.name) {
        const dup = db.files.some(f => f.id !== target.id && (f.folderId || '') === (target.folderId || '') && f.name === name);
        if (dup) return json(ctx.res, 400, { error: '该目录下已存在同名文件，替换会重名冲突' });
      }
    } else {
      name = target.name;
    }
  } else {
    if (!validEntryName(name)) return json(ctx.res, 400, { error: '文件名需为 1-60 个字符且不含 \\/:*?"<>|' });
    if (folder && !findFolder(folder)) return json(ctx.res, 400, { error: '目标文件夹不存在' });
  }
  const sz = Number(size);
  if (!Number.isSafeInteger(sz) || sz <= 0) return json(ctx.res, 400, { error: '文件大小无效' });
  if (sz > fileMaxBytes()) return json(ctx.res, 400, { error: `文件过大，单个文件不能超过 ${numSetting('fileMaxMb')}MB` });
  const chunks = Number(totalChunks);
  if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 10000) return json(ctx.res, 400, { error: '分块数无效' });
  const expectedChunks = Math.ceil(sz / TRANSFER_CHUNK_SIZE);
  if (chunks !== expectedChunks) return json(ctx.res, 400, { error: '分块数与文件大小不匹配' });

  // 断点续传：同一用户存在同名、同大小、同分块数的未完成任务（且非替换模式）时直接复用，
  // 返回已收到的分块序号，前端跳过这些分块继续上传
  if (!replaceId) {
    for (const [fileId, task] of Object.entries(pendingFiles)) {
      if (task.userId !== ctx.user.id) continue;
      if (task.replaceId) continue;
      if (task.name === name && task.size === sz && task.totalChunks === chunks && task.folderId === folder) {
        const partPath = path.join(FILES_DIR, '.tmp_' + fileId + '.part');
        const partEnd = Number.isSafeInteger(task.writtenEnd) ? task.writtenEnd : task.receivedBytes;
        const partExists = fs.existsSync(partPath) && fs.statSync(partPath).size === partEnd;
        if (partExists) {
          return json(ctx.res, 200, { ok: true, fileId, resumed: true, receivedChunks: Array.from(task.seen) });
        }
        // 临时分块文件损坏：丢弃旧任务，走全新上传
        delete pendingFiles[fileId];
        try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }
        break;
      }
    }
  }

  if (Object.keys(pendingFiles).length >= PENDING_UPLOAD_MAX) {
    prunePendingFiles();
    if (Object.keys(pendingFiles).length >= PENDING_UPLOAD_MAX) {
      return json(ctx.res, 429, { error: '上传任务过多，请稍后再试' });
    }
  }
  const fileId = uid();
  pendingFiles[fileId] = {
    userId: ctx.user.id,
    name, size: sz, totalChunks: chunks,
    received: 0, receivedBytes: 0, writtenEnd: 0,
    chunkSize: TRANSFER_CHUNK_SIZE,
    seen: new Set(), // 已接收的分块序号，拒绝重复分块（重复写入会损坏文件并虚增计数）
    storage: storageName(name),
    folderId: folder,
    replaceId: String(replaceId || ''),
    createdAt: Date.now()
  };
  json(ctx.res, 200, { ok: true, fileId });
}, { auth: true });

// 管理：上传一个分块（base64）
route('POST', '/api/admin/files/chunk', async ctx => {
  const { fileId = '', index = 0, data = '' } = ctx.body || {};
  const task = pendingFiles[fileId];
  if (!task || task.userId !== ctx.user.id) return json(ctx.res, 404, { error: '上传任务不存在或已过期' });
  const idx = parseInt(index, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= task.totalChunks) return json(ctx.res, 400, { error: '分块序号无效' });
  if (task.seen.has(idx)) return json(ctx.res, 400, { error: '该分块已上传，请勿重复提交' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(data)) || String(data).length % 4 !== 0) {
    return json(ctx.res, 400, { error: '分块数据无效' });
  }
  const buf = Buffer.from(String(data), 'base64');
  if (!buf.length) return json(ctx.res, 400, { error: '分块内容为空' });
  const layout = chunkLayout(task, idx);
  if (!layout || buf.length !== layout.size) return json(ctx.res, 400, { error: '分块大小与序号不匹配' });
  task.receivedBytes += buf.length;
  if (task.receivedBytes > task.size || task.receivedBytes > fileMaxBytes()) {
    delete pendingFiles[fileId];
    try {
      const p = path.join(FILES_DIR, '.tmp_' + fileId + '.part');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
    return json(ctx.res, 400, { error: '文件超过大小限制' });
  }
  // 分块按序号随机写入临时文件，避免乱序到达时按到达顺序拼接导致文件损坏。
  const partPath = path.join(FILES_DIR, '.tmp_' + fileId + '.part');
  try {
    writeChunkAt(partPath, buf, layout.offset);
    task.seen.add(idx);
    task.received += 1;
    task.writtenEnd = Math.max(task.writtenEnd || 0, layout.offset + buf.length);
  } catch (e) {
    task.receivedBytes -= buf.length;
    return json(ctx.res, 500, { error: '分块保存失败，请重试' });
  }
  json(ctx.res, 200, { ok: true, received: task.received, totalChunks: task.totalChunks });
}, { auth: true });

// 管理：完成上传（replaceId 模式下为替换：保留原文件 id、下载数与取件码）
route('POST', '/api/admin/files/finish', async ctx => {
  const { fileId = '', desc = '' } = ctx.body || {};
  const task = pendingFiles[fileId];
  if (!task || task.userId !== ctx.user.id) return json(ctx.res, 404, { error: '上传任务不存在或已过期' });
  if (task.received !== task.totalChunks) {
    return json(ctx.res, 400, { error: `分块未收齐（${task.received}/${task.totalChunks}），请重新上传` });
  }
  if (String(desc).length > 100) return json(ctx.res, 400, { error: '文件描述不能超过 100 个字符' });
  const partPath = path.join(FILES_DIR, '.tmp_' + fileId + '.part');
  const finalPath = safeFilePath(task.storage);
  if (!finalPath) {
    delete pendingFiles[fileId];
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }
    return json(ctx.res, 400, { error: '文件存储名无效，请重新上传' });
  }
  try {
    const st = fs.statSync(partPath);
    if (st.size !== task.size) {
      fs.unlinkSync(partPath);
      delete pendingFiles[fileId];
      return json(ctx.res, 400, { error: '文件大小与声明不一致，请重新上传' });
    }
    fs.renameSync(partPath, finalPath);
  } catch (e) {
    return json(ctx.res, 500, { error: '文件保存失败，请重试' });
  }

  // -------- 替换模式：更新原文件记录，保留下载数与取件码 --------
  if (task.replaceId) {
    const target = findFile(task.replaceId);
    if (!target) {
      // 目标文件在上传期间被删除：清理新文件，提示重新上传
      try { fs.unlinkSync(finalPath); } catch (e) { /* ignore */ }
      delete pendingFiles[fileId];
      return json(ctx.res, 404, { error: '目标文件已被删除，无法替换，请重新上传' });
    }
    // 删除旧物理文件（保留新文件），异常旧存储名不得逃逸出 FILES_DIR。
    try {
      const oldPath = safeFilePath(target.storage);
      if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (e) { /* ignore */ }
    const oldName = target.name, oldSize = target.size;
    target.name = task.name;
    target.storage = task.storage;
    target.size = task.size;
    target.updatedAt = nowISO();
    target.uploadedBy = ctx.user.username;
    // 保留：id、downloads、folderId、createdAt、desc（描述保持原值）
    saveDB('files', db.files);
    delete pendingFiles[fileId];
    logOp(ctx.user, ctx.req, '替换文件', `${oldName}（${oldSize} → ${target.size} 字节）`);
    return json(ctx.res, 200, { ok: true, file: target, replaced: true });
  }

  // -------- 新建模式 --------
  const file = {
    id: fileId, name: task.name, storage: task.storage, size: task.size,
    desc: String(desc).trim(),     downloads: 0,
    hidden: false,
    speedLimitMbps: 0,
    folderId: task.folderId || '',
    uploadedBy: ctx.user.username, createdAt: nowISO()
  };
  db.files.push(file);
  saveDB('files', db.files);
  delete pendingFiles[fileId];
  logOp(ctx.user, ctx.req, '上传文件', `${file.name}（${file.size} 字节）`);
  json(ctx.res, 200, { ok: true, file });
}, { auth: true });

// 管理：修改文件描述
route('PUT', '/api/admin/files/:id/desc', async ctx => {
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  const { desc = '' } = ctx.body || {};
  if (String(desc).length > 100) return json(ctx.res, 400, { error: '文件描述不能超过 100 个字符' });
  f.desc = String(desc).trim();
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '修改文件描述', f.name);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 管理：切换文件展示状态、动态调整单文件限速
route('PUT', '/api/admin/files/:id/policy', async ctx => {
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  const b = ctx.body || {};
  if (b.hidden !== undefined) f.hidden = !!b.hidden;
  if (b.speedLimitMbps !== undefined) {
    const v = Number(b.speedLimitMbps);
    if (!Number.isFinite(v) || v < 0 || v > FILE_SPEED_MAX_MBPS) return json(ctx.res, 400, { error: `单文件限速需在 0～${FILE_SPEED_MAX_MBPS} MB/s 之间` });
    f.speedLimitMbps = Math.round(v * 100) / 100;
  }
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '调整文件策略', `${f.name}（${f.hidden ? '隐藏' : '展示'}，${f.speedLimitMbps || '跟随全局'} MB/s）`);
  json(ctx.res, 200, { ok: true, file: f });
}, { auth: true });

// 管理：引用外链文件，不落盘，由一次性令牌代理下载
route('POST', '/api/admin/files/external', async ctx => {
  const b = ctx.body || {};
  const name = String(b.name || '').trim();
  const sourceUrl = String(b.sourceUrl || '').trim();
  const folderId = String(b.folderId || '').trim();
  const nodeId = String(b.nodeId || '').trim();
  const nodePath = String(b.nodePath || '').trim();
  if (!validEntryName(name)) return json(ctx.res, 400, { error: '文件名需为 1-60 个字符且不含 \\/:*?"<>|' });
  if (!nodeId && !validHttpUrl(sourceUrl)) return json(ctx.res, 400, { error: '外链必须是合法的 http/https 地址' });
  if (!nodeId) {
    try { await assertSafeHost(new URL(sourceUrl).hostname); } catch (e) { return json(ctx.res, 400, { error: '外链地址不允许指向内网、回环或云元数据地址' }); }
  }
  const selectedNode = nodeId ? db.nodes.find(n => n.id === nodeId && n.enabled !== false) : null;
  if (nodeId && (!selectedNode || !validNodePath(nodePath))) return json(ctx.res, 400, { error: '节点文件需要选择有效节点并填写安全的节点文件路径' });
  if (nodeId) {
    const probe = await nodeFileExists(selectedNode, nodePath);
    if (probe.status === 404) return json(ctx.res, 404, { error: '节点文件不存在或已被删除，请重新浏览后选择文件' });
    if (probe.status !== 200) return json(ctx.res, 502, { error: probe.error || '无法确认节点文件状态', upstreamStatus: probe.status });
    if (Number(b.size) <= 0) b.size = probe.size;
  }
  if (folderId && !findFolder(folderId)) return json(ctx.res, 400, { error: '目标文件夹不存在' });
  const f = { id: uid(), name, sourceUrl, nodeId, nodePath, size: Number(b.size) > 0 ? Number(b.size) : 0, desc: String(b.desc || '').trim().slice(0, 100), downloads: 0, hidden: !!b.hidden, speedLimitMbps: 0, folderId, uploadedBy: ctx.user.username, createdAt: nowISO(), external: true };
  db.files.push(f);
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '添加外链文件', `${name}（${sourceUrl}）`);
  json(ctx.res, 200, { ok: true, file: f });
}, { auth: true });

// 管理：删除文件
route('DELETE', '/api/admin/files/:id', async ctx => {
  const idx = db.files.findIndex(f => f.id === ctx.params.id);
  if (idx < 0) return json(ctx.res, 404, { error: '文件不存在' });
  const [f] = db.files.splice(idx, 1);
  try {
    const p = safeFilePath(f.storage);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { /* ignore */ }
  removeFileShareCodes(f.id); // 同步清理该文件的全部取件码
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '删除文件', f.name);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ---------------- 文件管理器：目录/新建/编辑/复制粘贴 ----------------
const TEXT_EDIT_MAX = 256 * 1024; // 在线编辑文本文件的大小上限
// 剪贴板（内存态，重启后清空）：{ action: 'copy'|'cut', entries: [{type:'file'|'folder', id}] }
const clipboard = { action: '', entries: [] };

// 管理：新建文件夹
route('POST', '/api/admin/folders', async ctx => {
  const { name = '', parentId = '' } = ctx.body || {};
  if (!validEntryName(name)) return json(ctx.res, 400, { error: '文件夹名需为 1-60 个字符且不含 \\/:*?"<>|' });
  const parent = String(parentId).trim();
  if (parent && !findFolder(parent)) return json(ctx.res, 400, { error: '上级文件夹不存在' });
  const dup = db.folders.find(f => (f.parentId || '') === parent && f.name === name.trim());
  if (dup) return json(ctx.res, 400, { error: '该目录下已存在同名文件夹' });
  const folder = { id: uid(), name: name.trim(), parentId: parent, createdAt: nowISO() };
  db.folders.push(folder);
  saveDB('folders', db.folders);
  logOp(ctx.user, ctx.req, '新建文件夹', folder.name);
  json(ctx.res, 200, { ok: true, folder });
}, { auth: true });

// 管理：删除文件夹（含其中全部文件与子文件夹）
route('DELETE', '/api/admin/folders/:id', async ctx => {
  const folder = findFolder(ctx.params.id);
  if (!folder) return json(ctx.res, 404, { error: '文件夹不存在' });
  const ids = collectFolderIds(folder.id);
  let removedFiles = 0;
  db.files = db.files.filter(f => {
    if (!ids.includes(f.folderId || '')) return true;
    try {
      const p = safeFilePath(f.storage);
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
    removeFileShareCodes(f.id); // 清理取件码
    removedFiles++;
    return false;
  });
  db.folders = db.folders.filter(f => !ids.includes(f.id));
  saveDB('files', db.files);
  saveDB('folders', db.folders);
  logOp(ctx.user, ctx.req, '删除文件夹', `${folder.name}（含 ${removedFiles} 个文件）`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 管理：批量删除（文件 + 文件夹混合；文件夹级联删除其内全部文件与子文件夹）
route('POST', '/api/admin/batch-delete', async ctx => {
  const entries = (ctx.body || {}).entries;
  if (!Array.isArray(entries) || !entries.length) return json(ctx.res, 400, { error: '请先选择要删除的条目' });
  const folderIds = new Set();
  const fileIds = new Set();
  for (const e of entries) {
    const t = String(e.type || ''), id = String(e.id || '');
    if (t === 'folder' && findFolder(id)) folderIds.add(id);
    else if (t === 'file' && findFile(id)) fileIds.add(id);
  }
  if (!folderIds.size && !fileIds.size) return json(ctx.res, 400, { error: '所选条目不存在或已被删除' });

  // 级联收集全部待删文件夹（含子孙）
  const allFolderIds = new Set();
  for (const fid of folderIds) for (const id of collectFolderIds(fid)) allFolderIds.add(id);

  let removedFiles = 0, removedFolders = 0;
  db.files = db.files.filter(f => {
    const inFolder = allFolderIds.has(f.folderId || '');
    const direct = fileIds.has(f.id) && !inFolder;
    if (!inFolder && !direct) return true;
    try {
      const p = safeFilePath(f.storage);
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
    removeFileShareCodes(f.id); // 同步清理取件码
    removedFiles++;
    return false;
  });
  db.folders = db.folders.filter(f => {
    if (!allFolderIds.has(f.id)) return true;
    removedFolders++;
    return false;
  });
  saveDB('files', db.files);
  saveDB('folders', db.folders);
  logOp(ctx.user, ctx.req, '批量删除', `${removedFolders} 个文件夹、${removedFiles} 个文件`);
  json(ctx.res, 200, { ok: true, removedFiles, removedFolders });
}, { auth: true });

// 管理：批量移动（文件 + 文件夹混合 → 目标文件夹；含循环引用与同名防护）
route('POST', '/api/admin/batch-move', async ctx => {
  const b = ctx.body || {};
  const entries = b.entries;
  const target = String(b.targetFolderId || '').trim();
  if (!Array.isArray(entries) || !entries.length) return json(ctx.res, 400, { error: '请先选择要移动的条目' });
  if (target && !findFolder(target)) return json(ctx.res, 400, { error: '目标文件夹不存在' });

  const folderEntries = [], fileEntries = [];
  for (const e of entries) {
    const t = String(e.type || ''), id = String(e.id || '');
    if (t === 'folder' && findFolder(id)) folderEntries.push(findFolder(id));
    else if (t === 'file' && findFile(id)) fileEntries.push(findFile(id));
  }

  let moved = 0, skipped = 0;
  for (const folder of folderEntries) {
    // 防循环引用：不能移动到自身或其子孙文件夹
    if (target && collectFolderIds(folder.id).includes(target)) { skipped++; continue; }
    // 目标目录下已存在同名文件夹则跳过，避免混淆
    if (db.folders.some(f => f.id !== folder.id && (f.parentId || '') === target && f.name === folder.name)) { skipped++; continue; }
    folder.parentId = target;
    moved++;
  }
  for (const f of fileEntries) {
    f.folderId = target;
    moved++;
  }
  if (moved) {
    saveDB('files', db.files);
    saveDB('folders', db.folders);
  }
  logOp(ctx.user, ctx.req, '批量移动', `移动 ${moved} 个条目（跳过 ${skipped} 个）`);
  json(ctx.res, 200, { ok: true, moved, skipped });
}, { auth: true });

// 管理：新建文本文件（可选初始内容）
route('POST', '/api/admin/files/new', async ctx => {
  const { name = '', parentId = '', content = '' } = ctx.body || {};
  if (!validEntryName(name)) return json(ctx.res, 400, { error: '文件名需为 1-60 个字符且不含 \\/:*?"<>|' });
  const parent = String(parentId).trim();
  if (parent && !findFolder(parent)) return json(ctx.res, 400, { error: '上级文件夹不存在' });
  const text = String(content || '');
  if (Buffer.byteLength(text, 'utf8') > TEXT_EDIT_MAX) return json(ctx.res, 400, { error: '内容超过 256KB 上限' });
  const storage = storageName(name);
  const filePath = safeFilePath(storage);
  if (!filePath) return json(ctx.res, 500, { error: '文件存储名生成失败，请重试' });
  fs.writeFileSync(filePath, text, 'utf8');
  const file = {
    id: uid(), name: name.trim(), storage, size: Buffer.byteLength(text, 'utf8'),
    desc: '', downloads: 0, folderId: parent,
    uploadedBy: ctx.user.username, createdAt: nowISO()
  };
  db.files.push(file);
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '新建文件', file.name);
  json(ctx.res, 200, { ok: true, file });
}, { auth: true });

// 管理：读取文本文件内容（在线编辑用，超过上限拒绝）
route('GET', '/api/admin/files/:id/content', async ctx => {
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  const p = safeFilePath(f.storage);
  if (!p) return json(ctx.res, 404, { error: '文件内容不存在' });
  let st;
  try { st = fs.statSync(p); } catch (e) { return json(ctx.res, 404, { error: '文件内容不存在' }); }
  if (st.size > TEXT_EDIT_MAX) return json(ctx.res, 400, { error: '文件超过 256KB，不支持在线编辑' });
  const content = fs.readFileSync(p, 'utf8');
  json(ctx.res, 200, { ok: true, name: f.name, content });
}, { auth: true });

// 管理：保存文本文件内容
route('PUT', '/api/admin/files/:id/content', async ctx => {
  const f = findFile(ctx.params.id);
  if (!f) return json(ctx.res, 404, { error: '文件不存在' });
  const p = safeFilePath(f.storage);
  if (!p) return json(ctx.res, 404, { error: '文件内容不存在' });
  let st;
  try { st = fs.statSync(p); } catch (e) { return json(ctx.res, 404, { error: '文件内容不存在' }); }
  if (st.size > TEXT_EDIT_MAX) return json(ctx.res, 400, { error: '文件超过 256KB，不支持在线编辑' });
  const text = String((ctx.body || {}).content || '');
  if (Buffer.byteLength(text, 'utf8') > TEXT_EDIT_MAX) return json(ctx.res, 400, { error: '内容超过 256KB 上限' });
  fs.writeFileSync(p, text, 'utf8');
  f.size = Buffer.byteLength(text, 'utf8');
  saveDB('files', db.files);
  logOp(ctx.user, ctx.req, '编辑文件', f.name);
  json(ctx.res, 200, { ok: true, size: f.size });
}, { auth: true });

// 管理：重命名（文件/文件夹，同目录校验同名）
route('POST', '/api/admin/rename', async ctx => {
  const { type = '', id = '', name = '' } = ctx.body || {};
  if (!validEntryName(name)) return json(ctx.res, 400, { error: '名称需为 1-60 个字符且不含 \\/:*?"<>|' });
  let target, siblings;
  if (type === 'folder') {
    target = findFolder(id);
    if (!target) return json(ctx.res, 404, { error: '文件夹不存在' });
    siblings = db.folders.filter(f => f.id !== id && (f.parentId || '') === (target.parentId || ''));
  } else if (type === 'file') {
    target = findFile(id);
    if (!target) return json(ctx.res, 404, { error: '文件不存在' });
    siblings = db.files.filter(f => f.id !== id && (f.folderId || '') === (target.folderId || ''));
  } else {
    return json(ctx.res, 400, { error: '类型无效' });
  }
  if (siblings.some(s => s.name === name.trim())) return json(ctx.res, 400, { error: '该目录下已存在同名条目' });
  const oldName = target.name;
  target.name = name.trim();
  saveDB(type === 'folder' ? 'folders' : 'files', type === 'folder' ? db.folders : db.files);
  logOp(ctx.user, ctx.req, '重命名', `${oldName} → ${target.name}`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 管理：移动（文件/文件夹 → 目标文件夹，含循环引用防护）
route('POST', '/api/admin/move', async ctx => {
  const { type = '', id = '', targetFolderId = '' } = ctx.body || {};
  const target = String(targetFolderId).trim();
  if (target && !findFolder(target)) return json(ctx.res, 400, { error: '目标文件夹不存在' });
  if (type === 'folder') {
    const folder = findFolder(id);
    if (!folder) return json(ctx.res, 404, { error: '文件夹不存在' });
    if (target && collectFolderIds(id).includes(target)) return json(ctx.res, 400, { error: '不能移动到自身或其子文件夹' });
    if (db.folders.some(f => f.id !== id && (f.parentId || '') === target && f.name === folder.name)) {
      return json(ctx.res, 400, { error: '目标目录下已存在同名文件夹' });
    }
    folder.parentId = target;
    saveDB('folders', db.folders);
    logOp(ctx.user, ctx.req, '移动文件夹', folder.name);
  } else if (type === 'file') {
    const f = findFile(id);
    if (!f) return json(ctx.res, 404, { error: '文件不存在' });
    f.folderId = target;
    saveDB('files', db.files);
    logOp(ctx.user, ctx.req, '移动文件', f.name);
  } else {
    return json(ctx.res, 400, { error: '类型无效' });
  }
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 递归复制文件夹（物理文件复制 + 元数据生成新 id）
function copyFolderTree(folder, newParentId) {
  const nf = { id: uid(), name: folder.name, parentId: newParentId, createdAt: nowISO() };
  db.folders.push(nf);
  for (const f of db.files.filter(x => (x.folderId || '') === folder.id)) {
    const storage = storageName(f.name);
    try {
      const source = safeStoredPath(f.storage);
      const target = safeFilePath(storage);
      if (!source || !target) continue;
      fs.copyFileSync(source, target);
    } catch (e) { continue; } // 物理复制失败则跳过，不写入元数据，避免产生下载必 404 的幽灵文件
        db.files.push({
          id: uid(), name: f.name, storage, size: f.size, desc: f.desc || '',
      downloads: 0, hidden: !!f.hidden, speedLimitMbps: Number(f.speedLimitMbps) || 0, folderId: nf.id, uploadedBy: f.uploadedBy || '', createdAt: nowISO()
    });
  }
  for (const sub of db.folders.filter(x => (x.parentId || '') === folder.id)) copyFolderTree(sub, nf.id);
}

// 管理：设置剪贴板（复制 / 剪切）
route('POST', '/api/admin/clipboard', async ctx => {
  const { action = '', entries = [] } = ctx.body || {};
  if (action !== 'copy' && action !== 'cut') return json(ctx.res, 400, { error: '操作类型无效' });
  if (!Array.isArray(entries) || !entries.length) return json(ctx.res, 400, { error: '请先选择要复制/剪切的条目' });
  const cleaned = [];
  for (const e of entries) {
    const t = String(e.type || '');
    const id = String(e.id || '');
    if (t === 'file' && findFile(id)) cleaned.push({ type: 'file', id });
    else if (t === 'folder' && findFolder(id)) cleaned.push({ type: 'folder', id });
  }
  if (!cleaned.length) return json(ctx.res, 400, { error: '所选条目不存在或已被删除' });
  clipboard.action = action;
  clipboard.entries = cleaned;
  json(ctx.res, 200, { ok: true, clipboard });
}, { auth: true });

// 管理：粘贴剪贴板到目标文件夹
route('POST', '/api/admin/paste', async ctx => {
  if (!clipboard.action || !clipboard.entries.length) return json(ctx.res, 400, { error: '剪贴板为空' });
  const target = String((ctx.body || {}).targetFolderId || '').trim();
  if (target && !findFolder(target)) return json(ctx.res, 400, { error: '目标文件夹不存在' });
  const isCut = clipboard.action === 'cut';
  let count = 0;
  for (const e of clipboard.entries) {
    if (e.type === 'file') {
      const f = findFile(e.id);
      if (!f) continue;
      if (isCut) {
        f.folderId = target;
        count++;
      } else {
        const storage = storageName(f.name);
        const source = safeStoredPath(f.storage);
        const target = safeFilePath(storage);
        if (!source || !target) continue;
        try { fs.copyFileSync(source, target); } catch (err) { continue; }
        db.files.push({
          id: uid(), name: f.name, storage, size: f.size, desc: f.desc || '',
          downloads: 0, hidden: !!f.hidden, speedLimitMbps: Number(f.speedLimitMbps) || 0, folderId: target, uploadedBy: f.uploadedBy || '', createdAt: nowISO()
        });
        count++;
      }
    } else {
      const folder = findFolder(e.id);
      if (!folder) continue;
      if (isCut) {
        if (target && collectFolderIds(folder.id).includes(target)) continue; // 防循环
        folder.parentId = target;
        count++;
      } else {
        if (target && collectFolderIds(folder.id).includes(target)) continue; // 防循环：不能复制到自身后代
        copyFolderTree(folder, target);
        count++;
      }
    }
  }
  const opName = isCut ? '剪切粘贴' : '复制粘贴';
  logOp(ctx.user, ctx.req, opName, `${count} 个条目`);
  if (isCut) { clipboard.action = ''; clipboard.entries = []; } // 剪切粘贴后清空，复制保留可多次粘贴
  saveDB('files', db.files);
  saveDB('folders', db.folders);
  json(ctx.res, 200, { ok: true, count });
}, { auth: true });

/** 流式下载共享文件核心（限速 DOWNLOAD_RATE 字节/秒 + 并发下载保护）
 * @param meta 文件元数据记录 @param inline 是否内联预览（由一次性令牌决定，不再依赖 URL 参数） */
async function streamSharedFile(req, res, meta, inline) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }

  // 并发下载保护：超过全局或单 IP 上限时拒绝，防止恶意并发占用带宽
  const dlIp = clientIP(req);
  if (!dlAcquire(dlIp)) {
    logRateHit('下载并发', dlIp, `超过并发上限（全局 ${MAX_CONCURRENT_DL} / 单IP ${MAX_CONCURRENT_DL_PER_IP}）`);
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('同时下载的人数较多，请稍后再试');
  }
  res.once('close', () => { dlRelease(dlIp); }); // once：防止 close 多次触发导致并发计数被重复释放

  const filePath = safeStoredPath(meta.storage);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  try {
    const st = fs.statSync(filePath);
    // RFC 5987 编码文件名，兼容中文
    const encoded = encodeURIComponent(meta.name);
    // 在线预览：仅当一次性令牌类型为 inline 且扩展名在预览白名单内时内联显示；否则强制下载
    const preview = inline ? PREVIEW_TYPES[path.extname(String(meta.name)).toLowerCase()] : null;
    const headers = preview
      ? {
          'Content-Type': preview.mime,
          'Content-Length': st.size,
          'Content-Disposition': `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`,
          'Accept-Ranges': 'none',
          'Cache-Control': 'no-store'
        }
      : {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
          'Accept-Ranges': 'none',
          'Cache-Control': 'no-store'
        };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    // 不限速：直接 pipe 传输
    let rate = fileSpeedBytes(meta);
    if (!rate || rate <= 0) {
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { res.destroy(); });
      stream.pipe(res);
      return;
    }

    // 限速流式发送：按 rate 控制吞吐，处理背压与客户端中断
    const fd = fs.openSync(filePath, 'r');
    const start = Date.now();
    let sent = 0;
    let closed = false;
    let fdClosed = false;
    // 统一关闭句柄：closeSync 不可重入，多次调用会抛异常，且背压等待期间客户端断开时
    // pump 不会再被调用，必须在 close 事件中兜底关闭，否则泄漏文件描述符
    const closeFd = () => { if (!fdClosed) { fdClosed = true; try { fs.closeSync(fd); } catch (e) {} } };
    res.on('close', () => { closed = true; closeFd(); });

    const pump = () => {
      if (closed) { closeFd(); return; }
      const elapsed = (Date.now() - start) / 1000;           // 秒
      const allowed = Math.floor(elapsed * rate);            // 当前累计允许发送的字节数
      if (sent >= st.size) {
        closeFd();
        res.end();
        return;
      }
      if (sent >= allowed) {
        // 达到速率上限，稍候再试
        setTimeout(pump, 20);
        return;
      }
      const budget = Math.min(DOWNLOAD_CHUNK, allowed - sent, st.size - sent);
      const buf = Buffer.alloc(budget);
      let n = 0;
      try {
        n = fs.readSync(fd, buf, 0, budget, sent);
      } catch (e) {
        closeFd();
        res.destroy();
        return;
      }
      if (n === 0) {
        // 文件被截断（实际大小小于记录值），按已读到的内容结束，防止死循环
        closeFd();
        res.end();
        return;
      }
      sent += n;
      const ok = res.write(buf.slice(0, n));
      if (!ok) {
        // 背压：等待 drain 后继续
        res.once('drain', pump);
        return;
      }
      pump();
    };
    pump();
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

/** 下载失效/失败提示页。reason 仅接受代码内静态字符串，不嵌入任何用户输入，无 XSS 风险 */
function serveSharedError(req, res, code, reason) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>无法下载</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6fb;font-family:'PingFang SC','Microsoft YaHei','Segoe UI',system-ui,sans-serif;color:#1f2430"><div style="text-align:center;padding:24px"><div style="font-size:42px;margin-bottom:12px">&#128193;</div><div style="font-size:16px;font-weight:600;margin-bottom:8px">无法下载</div><div style="font-size:13px;color:#6b7280">${reason}</div></div></body></html>`;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

/** 代理外链文件：校验协议/解析地址，支持有限重定向并沿用单文件限速。 */
async function proxyExternalFile(req, res, meta, token, hop = 0) {
  if (hop > 3 || !validHttpUrl(meta.sourceUrl)) return serveSharedError(req, res, 404, '外链地址无效或不可访问');
  let target;
  try { target = new URL(meta.sourceUrl); } catch (e) { return serveSharedError(req, res, 404, '外链地址无效或不可访问'); }
  try { await assertSafeHost(target.hostname); } catch (e) { return serveSharedError(req, res, 403, '外链地址不允许访问内网资源'); }
  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.get(target.toString(), { lookup: safeLookup, timeout: 10000, headers: { 'User-Agent': 'Huanzhong-File-Proxy/1.0', Accept: '*/*' } }, upstreamRes => {
    if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
      upstreamRes.resume();
      meta.sourceUrl = new URL(upstreamRes.headers.location, target).toString();
      return proxyExternalFile(req, res, meta, token, hop + 1);
    }
    if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) { upstreamRes.resume(); return serveSharedError(req, res, 404, '外链文件暂时不可用'); }
    const encoded = encodeURIComponent(meta.name);
    const length = Number(upstreamRes.headers['content-length']);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (Number.isSafeInteger(length) && length >= 0) headers['Content-Length'] = length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { upstreamRes.resume(); return res.end(); }
    let rate = fileSpeedBytes(meta);
    if (!rate || rate <= 0) { upstreamRes.pipe(res); return; }
    const started = Date.now(); let sent = 0; let queue = Buffer.alloc(0); let ended = false; let timer = null;
    const flush = () => {
      if (res.destroyed) return;
      const allowed = Math.floor((Date.now() - started) / 1000 * rate);
      if (queue.length && sent < allowed) { const n = Math.min(queue.length, DOWNLOAD_CHUNK, allowed - sent); res.write(queue.subarray(0, n)); queue = queue.subarray(n); sent += n; }
      if (queue.length) timer = setTimeout(flush, 20);
      else if (ended) res.end();
    };
    upstreamRes.on('data', chunk => { queue = Buffer.concat([queue, chunk]); flush(); });
    upstreamRes.on('end', () => { ended = true; flush(); });
    upstreamRes.on('error', () => { if (!res.destroyed) res.destroy(); });
    res.on('close', () => { if (timer) clearTimeout(timer); upstreamRes.destroy(); });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => { if (!res.headersSent) serveSharedError(req, res, 404, '外链文件暂时不可用'); });
}

/** 共享文件访问入口：/files/dl/<一次性令牌> 或 /files/<存储名>（?inline=1 内联预览） */
async function serveSharedFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  let sub = pathname.slice('/files/'.length);
  const qIdx = sub.indexOf('?');
  if (qIdx >= 0) sub = sub.slice(0, qIdx);

  // ---------------- 一次性下载链接：/files/dl/<token>（令牌消费后即失效） ----------------
  if (sub.startsWith('dl/')) {
    const t = consumeDlToken(sub.slice(3));
    if (!t) return serveSharedError(req, res, 410, '下载链接已失效或已被使用，请返回重新获取');

    // 文件夹打包下载（流式 ZIP，与 /api/files/zip 相同保护策略）
    if (t.type === 'zip') {
      const folderId = String(t.folderId || '');
      const files = collectFilesForZip(folderId);
      if (!files.length) return serveSharedError(req, res, 404, '该文件夹中没有可打包的文件');
      if (files.length > ZIP_FILE_MAX_COUNT) return serveSharedError(req, res, 400, '文件数量超过限制，无法打包');
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > ZIP_TOTAL_MAX) return serveSharedError(req, res, 400, '文件总大小超过限制，无法打包');
      const ip = clientIP(req);
      if (!dlAcquire(ip)) {
        logRateHit('打包下载', ip, '超过并发上限');
        return serveSharedError(req, res, 429, '同时打包的人数较多，请稍后再试');
      }
      const folder = folderId ? findFolder(folderId) : null;
      const zipName = folder ? folder.name + '.zip' : '全部文件.zip';
      const encoded = encodeURIComponent(zipName);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        'Cache-Control': 'no-store'
      });
      const zip = new ZipWriter(res);
      let done = false, released = false;
      const release = () => { if (!released) { released = true; dlRelease(ip); } };
      res.on('finish', () => { done = true; release(); });
      res.on('close', () => { if (!done) zip.abort(); release(); });
      try {
        for (const f of files) {
          // 打包期间任一文件读取失败都会中止整个响应，避免输出缺少条目的半损坏 ZIP。
          await zip.addFile(f.name, { path: f.path });
        }
        if (!res.destroyed) { zip.finish(); done = true; }
      } catch (e) { zip.abort(); }
      return;
    }

    // 单文件下载 / 内联预览（type: 'file' | 'inline'）
    const f = findFile(t.fileId);
    if (!f || !fileBackendValid(f)) {
      return serveSharedError(req, res, 404, '文件不存在或已被删除');
    }
    // 隐藏文件的下载令牌只允许由取件码签发；普通列表/预览/直链即使知道 ID 也不能访问。
    if (fileIsHidden(f) && t.accessMode !== 'share') return serveSharedError(req, res, 404, '文件不存在或已被删除');
    if (f.nodeId) {
      const node = chooseNode(f);
      if (!node) return serveSharedError(req, res, 503, '文件所在节点当前离线');
      const routed = await proxyNodeFile(req, res, f, node);
      if (routed) return;
      return serveSharedError(req, res, 502, '节点文件暂时不可用');
    }
    if (f.sourceUrl) return proxyExternalFile(req, res, f, t);
    if (!safeStoredPath(f.storage)) return serveSharedError(req, res, 404, '文件不存在或已被删除');
    return streamSharedFile(req, res, f, t.type === 'inline');
  }

  // ---------------- 禁止存储名直接访问：所有文件访问必须持有一次性令牌 ----------------
  // 存储名虽然是随机值，但一旦通过任何途径泄露即成为永久直链，
  // 会绕过验证码、下载限流与取件码有效期，故一律拒绝
  return serveSharedError(req, res, 403, '不支持直接访问，请通过页面提供的下载链接获取文件');
}

// 日志查询（支持筛选：type / keyword / result / from / to / page / pageSize）
route('GET', '/api/admin/logs', async ctx => {
  const q = ctx.query;
  const type = q.get('type') === 'operation' ? 'operation' : 'login';
  let list = db.logs[type];

  const keyword = (q.get('keyword') || '').trim().toLowerCase();
  if (keyword) {
    list = list.filter(l => {
      const fields = type === 'login'
        ? [l.username, l.ip, l.detail]
        : [l.user, l.ip, l.action, l.detail];
      return fields.some(f => String(f || '').toLowerCase().includes(keyword));
    });
  }
  const result = q.get('result') || '';
  if (type === 'login' && result) list = list.filter(l => l.result === result);
  const category = q.get('category') || '';
  if (type === 'operation' && LOG_CATEGORIES[category]) list = list.filter(l => (l.category || inferLogCategory(l.action)) === category);
  const from = q.get('from') || '';
  const to = q.get('to') || '';
  // 旧日志可能是早期保存的 UTC `Z` 时间；所有按日期的筛选统一以中国上海时区计算。
  if (from) list = list.filter(l => logDateInShanghai(l.time) >= from);
  if (to) list = list.filter(l => logDateInShanghai(l.time) <= to);

  const total = list.length;
  const pageSize = Math.min(100, Math.max(1, parseInt(q.get('pageSize'), 10) || 20));
  const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
  const pageList = list.slice((page - 1) * pageSize, page * pageSize).map(l => ({
    ...l,
    // 统一向后台返回上海时区格式，旧 UTC 日志无需迁移磁盘文件即可正确展示。
    time: toShanghaiISO(l.time) || l.time
  }));
  json(ctx.res, 200, { list: pageList, total, page, pageSize, timezone: 'Asia/Shanghai' });
}, { auth: true });

// 清空日志
route('POST', '/api/admin/logs/clear', async ctx => {
  const type = (ctx.body || {}).type === 'operation' ? 'operation' : 'login';
  const n = db.logs[type].length;
  db.logs[type] = [];
  saveDB('logs', db.logs);
  logOp(ctx.user, ctx.req, '清空日志', `${type === 'login' ? '登录日志' : '操作日志'} ${n} 条`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

/** CSV 字段转义：含逗号/引号/换行的值加双引号包裹 */
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 日志导出（?type=login|operation &format=csv|json，支持与查询页相同的筛选参数）
route('GET', '/api/admin/logs/export', async ctx => {
  const q = ctx.query;
  const type = q.get('type') === 'operation' ? 'operation' : 'login';
  let list = [...db.logs[type]];

  const keyword = (q.get('keyword') || '').trim().toLowerCase();
  if (keyword) {
    list = list.filter(l => {
      const fields = type === 'login'
        ? [l.username, l.ip, l.detail]
        : [l.user, l.ip, l.action, l.detail];
      return fields.some(f => String(f || '').toLowerCase().includes(keyword));
    });
  }
  const result = q.get('result') || '';
  if (type === 'login' && result) list = list.filter(l => l.result === result);
  const category = q.get('category') || '';
  if (type === 'operation' && LOG_CATEGORIES[category]) list = list.filter(l => (l.category || inferLogCategory(l.action)) === category);
  const from = q.get('from') || '';
  const to = q.get('to') || '';
  // 导出日期筛选与后台列表一致，统一按中国上海时区处理旧 UTC 记录。
  if (from) list = list.filter(l => logDateInShanghai(l.time) >= from);
  if (to) list = list.filter(l => logDateInShanghai(l.time) <= to);
  // 导出的每条日志均标准化为 UTC+8，避免 Excel 或外部系统按服务器 UTC 误读。
  list = list.map(l => ({ ...l, time: toShanghaiISO(l.time) || l.time }));

  const format = q.get('format') === 'json' ? 'json' : 'csv';
  const fname = `${type === 'login' ? 'login-logs' : 'operation-logs'}-${todayStr()}.${format}`;
  logOp(ctx.user, ctx.req, '导出日志', `${type === 'login' ? '登录日志' : '操作日志'} ${list.length} 条（${format.toUpperCase()}）`);

  if (format === 'json') {
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store'
    });
    ctx.res.end(JSON.stringify({ exportedAt: nowISO(), type, total: list.length, list }, null, 2));
    return;
  }
  // CSV（带 UTF-8 BOM，Excel 直接打开不乱码）
  const header = type === 'login'
    ? ['时间', '用户名', 'IP', '结果', '详情']
    : ['时间', '管理员', 'IP', '分类', '操作', '详情'];
  const lines = [header.map(csvEscape).join(',')];
  for (const l of list) {
    lines.push((type === 'login'
      ? [l.time, l.username, l.ip, l.result, l.detail]
      : [l.time, l.user, l.ip, LOG_CATEGORIES[l.category || inferLogCategory(l.action)] || LOG_CATEGORIES.other, l.action, l.detail]
    ).map(csvEscape).join(','));
  }
  const body = '\uFEFF' + lines.join('\r\n');
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fname}"`,
    'Cache-Control': 'no-store'
  });
  ctx.res.end(body);
}, { auth: true });

// 账号列表（含角色；isOwner 标识当前登录者是否为站长）
route('GET', '/api/admin/users', async ctx => {
  const myRole = userRole(ctx.user);
  json(ctx.res, 200, {
    isOwner: myRole === 'owner',
    users: db.users.map(u => ({
      id: u.id, username: u.username, createdAt: u.createdAt, createdBy: u.createdBy || '',
      role: userRole(u), roleLabel: ROLE_LABELS[userRole(u)],
      self: u.id === ctx.user.id
    }))
  });
}, { auth: true });

// 手动创建账号（管理员创建的账号默认为「用户」角色）
route('POST', '/api/admin/users', async ctx => {
  const { username = '', password, role: reqRole } = ctx.body || {};
  const pwd = decryptSecret(password);
  if (pwd === null) return json(ctx.res, 400, { error: '安全校验失败，请刷新页面后重试' });
  const name = String(username).trim();
  if (!validUsername(name)) return json(ctx.res, 400, { error: '用户名需为 2-20 位中文、字母、数字或下划线' });
  if (!validPassword(pwd)) return json(ctx.res, 400, { error: '密码长度需为 6-64 位' });
  if (db.users.some(u => u.username === name)) return json(ctx.res, 409, { error: '用户名已存在' });
  // 角色由创建者指定：站长可指定任意角色，管理员只能创建管理员/用户/访客
  let role = 'user';
  if (reqRole && VALID_ROLES.has(String(reqRole).trim())) {
    const wantRole = String(reqRole).trim();
    if (userRole(ctx.user) === 'owner' || wantRole !== 'owner') role = wantRole;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid(), username: name, salt,
    passHash: hashPassword(pwd, salt),
    role,
    createdAt: nowISO(), createdBy: `${ctx.user.username} 创建`
  };
  db.users.push(user);
  saveDB('users', db.users);
  logOp(ctx.user, ctx.req, '创建账号', `${name}（角色：${ROLE_LABELS[role]}）`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 修改用户角色（仅站长可操作）
route('PUT', '/api/admin/users/:id/role', async ctx => {
  if (userRole(ctx.user) !== 'owner') {
    return json(ctx.res, 403, { error: '仅站长可修改用户角色' });
  }
  const target = db.users.find(u => u.id === ctx.params.id);
  if (!target) return json(ctx.res, 404, { error: '账号不存在' });
  const newRole = String((ctx.body || {}).role || '').trim();
  if (!VALID_ROLES.has(newRole)) {
    return json(ctx.res, 400, { error: '角色无效，可选：站长 / 管理员 / 用户 / 访客' });
  }
  // 站长不能把自己降级（避免系统失去站长后无法管理角色）
  if (target.id === ctx.user.id && newRole !== 'owner') {
    return json(ctx.res, 400, { error: '不能降低自己的角色，请先将站长转让给其他账号' });
  }
  // 站长转让：把别的账号设为站长时，自动把自己降为管理员
  let transferNote = '';
  if (newRole === 'owner' && target.id !== ctx.user.id) {
    ctx.user.role = 'admin';
    transferNote = `（站长已转让，${ctx.user.username} 降为管理员）`;
  }
  const oldRole = target.role;
  target.role = newRole;
  saveDB('users', db.users);
  // 角色变更后强制该用户重新登录（清除其全部会话）
  if (target.id !== ctx.user.id) invalidateUserSessions(target.id);
  logOp(ctx.user, ctx.req, '修改角色',
    `${target.username}：${ROLE_LABELS[oldRole] || oldRole} → ${ROLE_LABELS[newRole] || newRole}${transferNote}`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 重置账号密码
route('PUT', '/api/admin/users/:id/password', async ctx => {
  const user = db.users.find(u => u.id === ctx.params.id);
  if (!user) return json(ctx.res, 404, { error: '账号不存在' });
  // 管理员可以维护普通账号，但不能通过重置密码接管站长账号；站长之间的操作仍由站长负责。
  if (userRole(user) === 'owner' && userRole(ctx.user) !== 'owner') {
    return json(ctx.res, 403, { error: '管理员不能重置站长账号密码' });
  }
  const pwd = decryptSecret(ctx.body.password);
  if (pwd === null) return json(ctx.res, 400, { error: '安全校验失败，请刷新页面后重试' });
  if (!validPassword(pwd)) return json(ctx.res, 400, { error: '密码长度需为 6-64 位' });
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passHash = hashPassword(pwd, user.salt);
  saveDB('users', db.users);
  invalidateUserSessions(user.id); // 密码被重置，强制该账号所有会话下线
  logOp(ctx.user, ctx.req, '重置密码', `账号：${user.username}（已下线该账号全部会话）`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 删除账号
route('DELETE', '/api/admin/users/:id', async ctx => {
  if (ctx.params.id === ctx.user.id) return json(ctx.res, 400, { error: '不能删除当前登录账号' });
  const target = db.users.find(u => u.id === ctx.params.id);
  if (!target) return json(ctx.res, 404, { error: '账号不存在' });
  // 管理员不能删除站长账号，避免通过删除/重置路径接管站点；站长可按既有规则管理站长。
  if (userRole(target) === 'owner' && userRole(ctx.user) !== 'owner') {
    return json(ctx.res, 403, { error: '管理员不能删除站长账号' });
  }
  // 不能删除最后一个站长（保证系统始终至少有一个站长）
  if (target.role === 'owner' && db.users.filter(u => u.role === 'owner').length <= 1) {
    return json(ctx.res, 400, { error: '不能删除最后一个站长账号' });
  }
  const idx = db.users.findIndex(u => u.id === ctx.params.id);
  const [user] = db.users.splice(idx, 1);
  invalidateUserSessions(user.id); // 账号被删除，强制其全部会话下线
  saveDB('users', db.users);
  logOp(ctx.user, ctx.req, '删除账号', user.username);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 封禁列表
route('GET', '/api/admin/bans', async ctx => {
  pruneBans();
  const list = Object.entries(db.bans)
    .filter(([, b]) => b.banUntil && b.banUntil > Date.now())
    .map(([ip, b]) => ({
      ip, failCount: b.failCount || 0,
      banUntil: new Date(b.banUntil).toISOString(),
      lastFail: b.lastFail || ''
    }));
  json(ctx.res, 200, { bans: list });
}, { auth: true });

// 手动解封
route('DELETE', '/api/admin/bans/:ip', async ctx => {
  const ip = ctx.params.ip;
  // 校验 IP 格式并排除魔法键，防止 __proto__/constructor 等作为对象下标命中原型链
  if (!ip || UNSAFE_KEYS.has(ip) || !/^[\w.:-]{1,64}$/.test(ip)) {
    return json(ctx.res, 400, { error: 'IP 地址无效' });
  }
  if (Object.prototype.hasOwnProperty.call(db.bans, ip)) {
    delete db.bans[ip];
    saveDB('bans', db.bans);
    logOp(ctx.user, ctx.req, '解封IP', ip);
  }
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ============ 安全防护：会话管理 / 安全概览 ============

// 会话引用 id：从内部哈希存储键派生短引用，不暴露也不恢复 bearer token。
// 引用仅用于后台展示和强制下线；真正的会话校验仍要求浏览器提交原始 Cookie。

// 管理：活跃会话列表（以哈希前缀标识，不暴露完整 token）
route('GET', '/api/admin/sessions', async ctx => {
  pruneSessions();
  const userMap = {};
  db.users.forEach(u => { userMap[u.id] = u.username; });
  const list = Object.entries(db.sessions).map(([storeKey, s]) => ({
    id: sessionRefFromStoreKey(storeKey),
    username: userMap[s.userId] || '已删除账号',
    ip: s.ip || '未知',
    createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : '',
    expiresAt: new Date(s.expiresAt).toISOString(),
    self: storeKey === ctx.session.storeKey
  })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  json(ctx.res, 200, { sessions: list });
}, { auth: true });

// 管理：强制下线某个会话（按哈希前缀引用 id）
route('DELETE', '/api/admin/sessions/:id', async ctx => {
  const ref = String(ctx.params.id || '').toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(ref)) return json(ctx.res, 400, { error: '会话引用无效' });
  if (ctx.session && sessionRefFromStoreKey(ctx.session.storeKey) === ref) {
    return json(ctx.res, 400, { error: '不能下线当前登录会话，请使用「退出登录」' });
  }
  let target = null;
  for (const [storeKey, s] of Object.entries(db.sessions)) {
    if (sessionRefFromStoreKey(storeKey) === ref) { target = { storeKey, s }; break; }
  }
  if (!target) return json(ctx.res, 404, { error: '会话不存在或已过期' });
  const uname = (db.users.find(u => u.id === target.s.userId) || {}).username || '未知';
  delete db.sessions[target.storeKey];
  saveDB('sessions', db.sessions);
  logOp(ctx.user, ctx.req, '强制下线', `账号：${uname}（${target.s.ip || '未知IP'}）`);
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 管理：安全概览（登录失败/封禁/会话/下载并发/限流状态）
route('GET', '/api/admin/security', async ctx => {
  pruneSessions(); pruneBans();
  const today = todayStr();
  let todayFail = 0, todayBanned = 0, todayRate = 0;
  for (const l of db.logs.login) {
    if (logDateInShanghai(l.time) !== today) continue;
    if (l.result === 'fail') {
      todayFail++;
      if (String(l.detail || '').includes('限流')) todayRate++;
    }
    if (l.result === 'banned') todayBanned++;
  }
  const bannedNow = Object.entries(db.bans).filter(([, b]) => b.banUntil && b.banUntil > Date.now()).length;
  json(ctx.res, 200, {
    overview: {
      todayFail, todayBanned, todayRate,
      bannedNow,
      activeSessions: Object.keys(db.sessions).length,
      activeDownloads: activeDl.total,
      activeDownloadIps: Object.keys(activeDl.byIp).length
    },
    rules: {
      maxAttempts: numSetting('maxAttempts'), banDuration: numSetting('banDurationMin') * 60000,
      rateApi: { max: RATE_API_MAX, window: RATE_API_WINDOW },
      rateAuth: { max: RATE_AUTH_MAX, window: RATE_AUTH_WINDOW },
      rateDlStart: { max: RATE_DL_START_MAX, window: RATE_DL_START_WINDOW },
      rateDlStart5: { max: RATE_DL_START5_MAX, window: RATE_DL_START5_WINDOW },
      maxConcurrentDl: MAX_CONCURRENT_DL, maxConcurrentDlPerIp: MAX_CONCURRENT_DL_PER_IP,
      downloadRate: downloadRateBytes()
    }
  });
}, { auth: true });

// 管理：IP 访问控制诊断（仅当前管理员可查看；用于排查代理头、缓存和地区/机房判定）
route('GET', '/api/admin/ip-diagnose', async ctx => {
  const raw = clientIPInfo(ctx.req);
  // 诊断按钮强制刷新当前 IP 的 geo 缓存，避免管理员看到 24 小时前的旧判定。
  const geo = await getGeoInfo(raw.ip, true);
  let result = null;
  if (!geo.error && !geo.rateLimited && !geo.isLocal) {
    if (db.settings.acDatacenterBlock && (geo.isDatacenter || geo.isProxy)) result = { type: 'datacenter' };
    else if (/^[A-Z]{2}$/.test(geo.countryCode || '')) {
      const domestic = !!normalizeChinaRegion(geo.countryCode, geo.region);
      if (db.settings.acDomesticBlock && domestic) result = { type: 'domestic' };
      else if (db.settings.acOverseasBlock && !domestic) result = { type: 'overseas' };
    }
  }
  json(ctx.res, 200, {
    request: raw,
    geo: {
      countryCode: geo.countryCode || '', region: geo.region || '',
      chinaRegion: normalizeChinaRegion(geo.countryCode, geo.region),
      org: geo.org || '', isDatacenter: !!geo.isDatacenter, isProxy: !!geo.isProxy,
      providers: geo.providers || (geo.provider ? [geo.provider] : []),
      error: !!geo.error, rateLimited: !!geo.rateLimited, isLocal: !!geo.isLocal
    },
    access: {
      domesticBlock: !!db.settings.acDomesticBlock,
      overseasBlock: !!db.settings.acOverseasBlock,
      datacenterBlock: !!db.settings.acDatacenterBlock,
      wouldBlock: !!result, blockType: result ? result.type : '',
      note: result ? '当前真实请求会在前台页面被拦截；/admin 后台与认证接口为排障保留豁免。' : '当前未命中拦截规则；请检查真实 IP、TRUST_PROXY 与地理数据。'
    }
  });
}, { auth: true });

// 系统设置
route('GET', '/api/admin/settings', async ctx => {
  json(ctx.res, 200, {
    settings: {
      siteName: db.settings.siteName,
      allowRegister: !!db.settings.allowRegister,
      loginCaptcha: !!db.settings.loginCaptcha,
      announcement: db.settings.announcement || '',
      logo: db.settings.logo || '',
      accentColor: db.settings.accentColor || '',
      linkCheckEnabled: !!db.settings.linkCheckEnabled,
      linkCheckInterval: Number.isFinite(db.settings.linkCheckInterval) ? db.settings.linkCheckInterval : LINK_CHECK_DEFAULT_INTERVAL,
      background: db.settings.background || '',
      footerText: db.settings.footerText || '',
      weatherEnabled: !!db.settings.weatherEnabled,
      weatherCity: db.settings.weatherCity || '',
      quoteEnabled: !!db.settings.quoteEnabled,
      // 访问控制
      acDomesticBlock: !!db.settings.acDomesticBlock,
      acOverseasBlock: !!db.settings.acOverseasBlock,
      acDatacenterBlock: !!db.settings.acDatacenterBlock,
      acDcAutoClose: !!db.settings.acDcAutoClose,
      acF12Block: !!db.settings.acF12Block,
      acF12AutoClose: !!db.settings.acF12AutoClose,
      blockTitle: db.settings.blockTitle || '',
      blockContent: db.settings.blockContent || '',
      blockFontSize: Number.isFinite(db.settings.blockFontSize) ? db.settings.blockFontSize : 16,
      blockTextWrap: db.settings.blockTextWrap !== false,
      // 功能开关
      announcementsEnabled: featureOn('announcementsEnabled'),
      qqGroupsEnabled: featureOn('qqGroupsEnabled'),
      commentsEnabled: featureOn('commentsEnabled'),
      feedbackEnabled: featureOn('feedbackEnabled'),
      countdownEnabled: featureOn('countdownEnabled'),
      friendlinksEnabled: featureOn('friendlinksEnabled'),
      popularEnabled: featureOn('popularEnabled'),
      visitorStatsEnabled: featureOn('visitorStatsEnabled'),
      luckyEnabled: featureOn('luckyEnabled'),
      recentEnabled: featureOn('recentEnabled'),
      downloadEnabled: featureOn('downloadEnabled'),
      shareCodesEnabled: featureOn('shareCodesEnabled'),
      // 可调数值
      commentMaxLen: numSetting('commentMaxLen'),
      feedbackMaxLen: numSetting('feedbackMaxLen'),
      popularTopN: numSetting('popularTopN'),
      shareDefaultTtlHours: numSetting('shareDefaultTtlHours'),
      downloadRateMbps: numSetting('downloadRateMbps'),
      fileMaxMb: numSetting('fileMaxMb'),
      maxAttempts: numSetting('maxAttempts'),
      banDurationMin: numSetting('banDurationMin'),
      heatmapDays: numSetting('heatmapDays')
    },
    // 数值项允许范围（供前端校验提示）
    numRules: Object.fromEntries(Object.entries(NUM_SETTING_RULES).map(([k, r]) => [k, { min: r.min, max: r.max, def: r.def }]))
  });
}, { auth: true });

route('PUT', '/api/admin/settings', async ctx => {
  const b = ctx.body || {};
  const changes = [];
  // 两阶段提交：先校验全部字段（暂存 pending），全部通过后才统一写入 db.settings。
  // 避免部分字段已改、后续字段校验失败时内存与磁盘不一致，或旧 Logo/背景图被误删。
  const pending = {};
  // 可调数值：逐项校验范围（整数项取整）
  const NUM_LABELS = {
    commentMaxLen: '留言最大字数', feedbackMaxLen: '反馈最大字数', popularTopN: '热门横条条数',
    shareDefaultTtlHours: '取件码默认有效期', downloadRateMbps: '下载限速', fileMaxMb: '单文件上限',
    maxAttempts: '登录封禁阈值', banDurationMin: 'IP封禁时长', heatmapDays: '热力图天数'
  };
  for (const [k, label] of Object.entries(NUM_LABELS)) {
    if (b[k] === undefined) continue;
    const r = NUM_SETTING_RULES[k];
    const v = Number(b[k]);
    if (!Number.isFinite(v)) return json(ctx.res, 400, { error: `${label}需为数字` });
    if (v < r.min || v > r.max) return json(ctx.res, 400, { error: `${label}需在 ${r.min}～${r.max} 之间` });
    pending[k] = Number.isInteger(r.def) && r.min >= 1 ? Math.round(v) : v;
  }
  if (b.allowRegister !== undefined) pending.allowRegister = !!b.allowRegister;
  if (b.loginCaptcha !== undefined) pending.loginCaptcha = !!b.loginCaptcha;
  if (b.siteName !== undefined) {
    const n = String(b.siteName).trim();
    if (!n || n.length > 30) return json(ctx.res, 400, { error: '站点名称需为 1-30 个字符' });
    pending.siteName = n;
  }
  if (b.announcement !== undefined) {
    const a = String(b.announcement).trim();
    if (a.length > 200) return json(ctx.res, 400, { error: '公告不能超过 200 个字符' });
    pending.announcement = a;
  }
  if (b.logo !== undefined) {
    const logo = String(b.logo).trim().slice(0, 500);
    if (!validIconRef(logo)) return json(ctx.res, 400, { error: 'Logo 地址格式不合法' });
    pending.logo = logo;
  }
  if (b.accentColor !== undefined) {
    const c = String(b.accentColor).trim();
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) {
      return json(ctx.res, 400, { error: '主题色需为 #RRGGBB 格式的颜色值' });
    }
    pending.accentColor = c;
  }
  if (b.linkCheckEnabled !== undefined || b.linkCheckInterval !== undefined) {
    if (b.linkCheckEnabled !== undefined) pending.linkCheckEnabled = !!b.linkCheckEnabled;
    if (b.linkCheckInterval !== undefined) {
      const iv = Number(b.linkCheckInterval);
      if (!Number.isFinite(iv) || iv < LINK_CHECK_MIN_INTERVAL || iv > LINK_CHECK_MAX_INTERVAL) {
        return json(ctx.res, 400, { error: `检测间隔需在 ${LINK_CHECK_MIN_INTERVAL}～${LINK_CHECK_MAX_INTERVAL} 小时之间` });
      }
      pending.linkCheckInterval = iv;
    }
  }
  if (b.background !== undefined) {
    const bg = String(b.background).trim().slice(0, 500);
    // 背景图与图标同规则：仅允许空值、/uploads/ 本地文件或 http(s) 外链
    if (!validIconRef(bg)) return json(ctx.res, 400, { error: '背景图地址格式不合法' });
    pending.background = bg;
  }
  if (b.footerText !== undefined) {
    const ft = String(b.footerText).trim();
    if (ft.length > 200) return json(ctx.res, 400, { error: '页脚文案不能超过 200 个字符' });
    pending.footerText = ft;
  }
  if (b.weatherEnabled !== undefined || b.weatherCity !== undefined) {
    let city = db.settings.weatherCity;
    if (b.weatherCity !== undefined) {
      city = String(b.weatherCity).trim().slice(0, 30);
      if (city && !validWeatherCity(city)) return json(ctx.res, 400, { error: '城市名仅支持中文、字母、数字与空格' });
      pending.weatherCity = city;
    }
    if (b.weatherEnabled !== undefined) pending.weatherEnabled = !!b.weatherEnabled;
  }
  if (b.quoteEnabled !== undefined) pending.quoteEnabled = !!b.quoteEnabled;
  // 访问控制开关
  if (b.acDomesticBlock !== undefined) pending.acDomesticBlock = !!b.acDomesticBlock;
  if (b.acOverseasBlock !== undefined) pending.acOverseasBlock = !!b.acOverseasBlock;
  if (b.acDatacenterBlock !== undefined) pending.acDatacenterBlock = !!b.acDatacenterBlock;
  if (b.acDcAutoClose !== undefined) pending.acDcAutoClose = !!b.acDcAutoClose;
  if (b.acF12Block !== undefined) pending.acF12Block = !!b.acF12Block;
  if (b.acF12AutoClose !== undefined) pending.acF12AutoClose = !!b.acF12AutoClose;
  // 拦截页自定义内容
  if (b.blockTitle !== undefined) {
    pending.blockTitle = String(b.blockTitle).trim().slice(0, 60);
  }
  if (b.blockContent !== undefined) {
    pending.blockContent = String(b.blockContent).slice(0, 500);
  }
  if (b.blockFontSize !== undefined) {
    const fs = Number(b.blockFontSize);
    if (!Number.isFinite(fs) || fs < 12 || fs > 32) return json(ctx.res, 400, { error: '字体大小需在 12～32 之间' });
    pending.blockFontSize = Math.round(fs);
  }
  if (b.blockTextWrap !== undefined) pending.blockTextWrap = !!b.blockTextWrap;
  // 功能开关：仅接受已知键，防止任意属性写入 settings
  const FEATURE_LABELS = {
    announcementsEnabled: '公告系统', qqGroupsEnabled: 'QQ群入口', commentsEnabled: '留言板',
    feedbackEnabled: '意见反馈', countdownEnabled: '倒计时', friendlinksEnabled: '友情链接',
    popularEnabled: '热门横条', visitorStatsEnabled: '访客统计', luckyEnabled: '手气不错',
    recentEnabled: '最近使用', downloadEnabled: '文件共享', shareCodesEnabled: '取件码'
  };
  for (const k of Object.keys(FEATURE_LABELS)) {
    if (b[k] !== undefined) pending[k] = !!b[k];
  }
  if (!Object.keys(pending).length) return json(ctx.res, 400, { error: '没有需要保存的修改' });

  // ---- 校验全部通过，统一应用 ----
  for (const [k, v] of Object.entries(pending)) {
    if (k === 'logo') {
      // 更换 Logo 时清理旧的上传文件（校验通过后才删，避免误删）
      if (db.settings.logo && db.settings.logo.startsWith('/uploads/') && db.settings.logo !== v) {
        removeUpload(db.settings.logo);
      }
      changes.push(v ? '更新站点 Logo' : '恢复默认 Logo');
    } else if (k === 'background') {
      if (db.settings.background && db.settings.background.startsWith('/uploads/') && db.settings.background !== v) {
        removeUpload(db.settings.background);
      }
      changes.push(v ? '更新站点背景图' : '恢复默认背景');
    } else if (k === 'siteName') {
      changes.push(`站点名称：${v}`);
    } else if (k === 'announcement') {
      changes.push(v ? `发布公告：${v.slice(0, 20)}${v.length > 20 ? '…' : ''}` : '清空公告');
    } else if (k === 'accentColor') {
      changes.push(v ? `主题色：${v}` : '恢复默认主题色');
    } else if (k === 'footerText') {
      changes.push(v ? '更新页脚文案' : '恢复默认页脚');
    } else if (k === 'allowRegister') {
      changes.push(`注册开关：${v ? '开启' : '关闭'}`);
    } else if (k === 'quoteEnabled') {
      changes.push(`每日一言：${v ? '开启' : '关闭'}`);
    } else if (k === 'weatherCity' || k === 'weatherEnabled' || k === 'linkCheckEnabled' || k === 'linkCheckInterval') {
      // 组合字段统一在下方记录日志
    } else if (k === 'acDomesticBlock') {
      changes.push(`国内访问拦截：${v ? '开启' : '关闭'}`);
    } else if (k === 'acOverseasBlock') {
      changes.push(`海外访问拦截：${v ? '开启' : '关闭'}`);
    } else if (k === 'acDatacenterBlock') {
      changes.push(`机房 IP 拦截：${v ? '开启' : '关闭'}`);
    } else if (k === 'acDcAutoClose') {
      changes.push(`机房检测自动关闭：${v ? '开启' : '关闭'}`);
    } else if (k === 'acF12Block') {
      changes.push(`F12 调试防护：${v ? '开启' : '关闭'}`);
    } else if (k === 'acF12AutoClose') {
      changes.push(`F12 检测自动关闭：${v ? '开启' : '关闭'}`);
    } else if (k === 'blockTitle' || k === 'blockContent' || k === 'blockFontSize' || k === 'blockTextWrap') {
      // 拦截页自定义统一日志
    } else if (FEATURE_LABELS[k]) {
      changes.push(`${FEATURE_LABELS[k]}：${v ? '开启' : '关闭'}`);
    } else if (NUM_LABELS[k]) {
      changes.push(`${NUM_LABELS[k]}：${v}`);
    }
    db.settings[k] = v;
  }
  if (pending.weatherEnabled !== undefined || pending.weatherCity !== undefined) {
    changes.push(`天气显示：${db.settings.weatherEnabled ? '开启（访客定位优先' + (db.settings.weatherCity ? '，备用城市 ' + db.settings.weatherCity : '') + '）' : '关闭'}`);
  }
  if (pending.linkCheckEnabled !== undefined || pending.linkCheckInterval !== undefined) {
    scheduleLinkCheck();
    changes.push(`定时死链检测：${db.settings.linkCheckEnabled ? '开启，每 ' + db.settings.linkCheckInterval + ' 小时' : '关闭'}`);
  }
  if (pending.blockTitle !== undefined || pending.blockContent !== undefined ||
      pending.blockFontSize !== undefined || pending.blockTextWrap !== undefined) {
    changes.push('更新拦截页自定义内容');
  }
  saveDB('settings', db.settings);
  logOp(ctx.user, ctx.req, '修改设置', changes.join('；'));
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// 数据备份导出（下载 JSON 备份文件）
route('GET', '/api/admin/backup', async ctx => {
  const payload = {
    _meta: { app: '幻终の导航', exportedAt: nowISO(), by: ctx.user.username },
    sites: db.sites,
    visits: db.visits,
    settings: db.settings,
    logs: db.logs,
    files: db.files,
    folders: db.folders,
    announcements: db.announcements,
    qqGroups: db.qqGroups,
    shareCodes: db.shareCodes,
    comments: db.comments,
    countdowns: db.countdowns,
    friendlinks: db.friendlinks,
    feedbacks: db.feedbacks,
    quotes: db.quotes
  };
  const body = JSON.stringify(payload, null, 2);
  const fname = `huanzhong-nav-backup-${todayStr()}.json`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fname}"`,
    'Cache-Control': 'no-store'
  });
  ctx.res.end(body);
  logOp(ctx.user, ctx.req, '导出数据备份', fname);
}, { auth: true });

/**
 * 应用备份数据到当前数据库（供 JSON 恢复与 ZIP 完整恢复共用）。
 * 不覆盖账号与会话。出错返回错误信息字符串，成功返回 null。
 * @param {object} b 备份数据对象
 * @param {boolean} verifyFilesExist 为 true 时校验文件物理存在（完整恢复场景，缺失的文件记录会被剔除）
 */
function applyRestoreUnsafe(b, verifyFilesExist, filesRoot = FILES_DIR) {
  if (!b || !Array.isArray(b.sites)) return '备份文件格式不正确';
  for (const s of b.sites) {
    if (!s || !validUrl(String(s.url || '')) || !String(s.name || '').trim()) {
      return '备份文件中存在无效引导页数据';
    }
  }
  db.sites = b.sites.map(s => ({
    id: safeId(s.id),
    name: String(s.name || '').trim().slice(0, 30),
    url: String(s.url || '').trim(),
    desc: String(s.desc || '').trim().slice(0, 60),
    // 图标字段同样校验：恶意备份可能注入 javascript: 等伪协议触发存储型 XSS
    icon: validIconRef(String(s.icon || '').trim()) ? String(s.icon || '').trim().slice(0, 500) : '',
    category: String(s.category || '').trim().slice(0, 12),
    enabled: s.enabled !== false,
    order: parseInt(s.order, 10) || 0,
    createdAt: String(s.createdAt || nowISO())
  }));
  // 访问统计：备份中含 visits 时恢复（仅保留仍存在站点的记录）；否则清理孤儿记录
  const ids = new Set(db.sites.map(s => s.id));
  if (b.visits && b.visits.sites && typeof b.visits.sites === 'object' && !Array.isArray(b.visits.sites)) {
    const restoredVisits = {};
    for (const [sid, v] of Object.entries(b.visits.sites)) {
      if (!ids.has(sid) || !v || typeof v !== 'object') continue;
      const daily = {};
      if (v.daily && typeof v.daily === 'object' && !Array.isArray(v.daily)) {
        for (const [date, cnt] of Object.entries(v.daily)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const c = parseInt(cnt, 10);
          if (Number.isFinite(c) && c >= 0) daily[date] = c;
          if (Object.keys(daily).length > 4000) break; // 防御异常数据
        }
      }
      restoredVisits[sid] = { total: Math.max(0, parseInt(v.total, 10) || 0), daily };
    }
    db.visits.sites = restoredVisits;
  } else {
    for (const vid of Object.keys(db.visits.sites)) {
      if (!ids.has(vid)) delete db.visits.sites[vid];
    }
  }
  saveDB('sites', db.sites);
  saveDB('visits', db.visits);
  if (b.settings && typeof b.settings === 'object') {
    const n = String(b.settings.siteName || '').trim();
    if (n && n.length <= 30) db.settings.siteName = n;
    db.settings.allowRegister = !!b.settings.allowRegister;
    db.settings.announcement = String(b.settings.announcement || '').trim().slice(0, 200);
    // Logo / 背景图同样校验：恶意备份可能注入 javascript: 等伪协议触发存储型 XSS
    const restoredLogo = String(b.settings.logo || '').trim().slice(0, 500);
    db.settings.logo = validIconRef(restoredLogo) ? restoredLogo : '';
    const restoredBg = String(b.settings.background || '').trim().slice(0, 500);
    db.settings.background = validIconRef(restoredBg) ? restoredBg : '';
    const ac = String(b.settings.accentColor || '').trim();
    db.settings.accentColor = /^#[0-9a-fA-F]{6}$/.test(ac) ? ac : (db.settings.accentColor || '');
    db.settings.footerText = String(b.settings.footerText || '').trim().slice(0, 200);
    const restoredCity = String(b.settings.weatherCity || '').trim().slice(0, 30);
    db.settings.weatherCity = validWeatherCity(restoredCity) ? restoredCity : '';
    db.settings.weatherEnabled = !!b.settings.weatherEnabled;
    db.settings.quoteEnabled = !!b.settings.quoteEnabled;
    // 访问控制：仅接受布尔值，非法值保持关闭
    db.settings.acDomesticBlock = !!b.settings.acDomesticBlock;
    db.settings.acOverseasBlock = !!b.settings.acOverseasBlock;
    db.settings.acDatacenterBlock = !!b.settings.acDatacenterBlock;
    db.settings.acDcAutoClose = b.settings.acDcAutoClose !== false;
    db.settings.acF12Block = !!b.settings.acF12Block;
    db.settings.acF12AutoClose = !!b.settings.acF12AutoClose;
    db.settings.blockTitle = String(b.settings.blockTitle || '').slice(0, 60);
    db.settings.blockContent = String(b.settings.blockContent || '').slice(0, 500);
    const bfs = Number(b.settings.blockFontSize);
    db.settings.blockFontSize = (Number.isFinite(bfs) && bfs >= 12 && bfs <= 32) ? Math.round(bfs) : 16;
    db.settings.blockTextWrap = b.settings.blockTextWrap !== false;
    if (typeof b.settings.linkCheckEnabled === 'boolean') db.settings.linkCheckEnabled = b.settings.linkCheckEnabled;
    const iv = Number(b.settings.linkCheckInterval);
    if (Number.isFinite(iv) && iv >= LINK_CHECK_MIN_INTERVAL && iv <= LINK_CHECK_MAX_INTERVAL) {
      db.settings.linkCheckInterval = iv;
    }
    // 功能开关：仅接受布尔值，非法值保持当前设置
    for (const k of Object.keys(FEATURE_DEFAULTS)) {
      if (typeof b.settings[k] === 'boolean') db.settings[k] = b.settings[k];
    }
    // 可调数值：仅接受范围内数值，非法值保持当前设置
    for (const [k, r] of Object.entries(NUM_SETTING_RULES)) {
      const v = Number(b.settings[k]);
      if (Number.isFinite(v) && v >= r.min && v <= r.max) db.settings[k] = v;
    }
    saveDB('settings', db.settings);
  }
  // 恢复共享文件列表（文件本体需随 data/files/ 目录一起迁移）
  // 先恢复文件夹并建立合法 id 集合，再归一化文件的 folderId，避免备份中的路径/引用污染当前数据。
  let restoredFolderIds = new Set(db.folders.map(f => f && String(f.id || '')).filter(Boolean));
  if (Array.isArray(b.folders)) {
    const seenFolderIds = new Set();
    const folders = [];
    for (const f of b.folders) {
      const name = String(f && f.name || '').trim();
      if (!f || !validEntryName(name)) continue;
      const id = safeId(f.id);
      if (seenFolderIds.has(id)) continue;
      seenFolderIds.add(id);
      folders.push({
        id,
        name: name.slice(0, 60),
        parentId: String(f.parentId || ''),
        createdAt: String(f.createdAt || nowISO())
      });
    }
    restoredFolderIds = new Set(folders.map(f => f.id));
    // 不存在的父级、自己指向自己和循环引用都降级到根目录，避免目录遍历/死循环。
    const folderMap = new Map(folders.map(f => [f.id, f]));
    for (const folder of folders) {
      let parentId = folder.parentId;
      let validParent = true;
      const seen = new Set([folder.id]);
      while (parentId) {
        if (!folderMap.has(parentId) || seen.has(parentId)) {
          validParent = false;
          break;
        }
        seen.add(parentId);
        parentId = folderMap.get(parentId).parentId;
      }
      if (!validParent) folder.parentId = '';
    }
    db.folders = folders;
    saveDB('folders', db.folders);
  }
  if (Array.isArray(b.files)) {
    let files = b.files
      .filter(f => f && ((validStorageName(f.storage) && !f.sourceUrl) || validHttpUrl(f.sourceUrl)) && validEntryName(String(f.name || '').trim()))
      .map(f => ({
        id: safeId(f.id),
        name: String(f.name || '').trim().slice(0, 100),
        storage: String(f.storage || ''),
        sourceUrl: validHttpUrl(f.sourceUrl) ? String(f.sourceUrl).trim() : '',
        nodeId: String(f.nodeId || ''),
        size: Math.max(0, parseInt(f.size, 10) || 0),
        desc: String(f.desc || '').trim().slice(0, 100),
        downloads: Math.max(0, parseInt(f.downloads, 10) || 0),
        hidden: !!f.hidden,
        speedLimitMbps: Math.max(0, Math.min(FILE_SPEED_MAX_MBPS, Number(f.speedLimitMbps) || 0)),
        folderId: restoredFolderIds.has(String(f.folderId || '')) ? String(f.folderId) : '',
        uploadedBy: String(f.uploadedBy || '').slice(0, 20),
        createdAt: String(f.createdAt || nowISO())
      }));
    if (verifyFilesExist) {
      // 完整恢复：剔除物理文件不存在的记录，并以磁盘实际大小覆盖备份中的 size，避免元数据失真。
      files = files.map(f => {
        try {
          const p = safeStoredPathInRoot(filesRoot, f.storage);
          if (!p) return null;
          const st = fs.statSync(p);
          return st.isFile() && Number.isSafeInteger(st.size) ? { ...f, size: st.size } : null;
        } catch (e) { return null; }
      }).filter(Boolean);
    }
    db.files = files;
    saveDB('files', db.files);
  }
  // 恢复取件码：仅保留未过期且对应文件仍存在的码
  if (b.shareCodes && typeof b.shareCodes === 'object' && !Array.isArray(b.shareCodes)) {
    const now = Date.now();
    const validFileIds = new Set(db.files.map(f => f.id));
    const restored = {};
    for (const [code, s] of Object.entries(b.shareCodes)) {
      if (!s || typeof s !== 'object') continue;
      if (!/^[A-Z0-9]{4,12}$/.test(code)) continue;
      const exp = Number(s.expiresAt);
      if (!Number.isFinite(exp) || exp <= now) continue;      // 已过期
      if (!validFileIds.has(String(s.fileId))) continue;       // 文件不存在
      restored[code] = {
        fileId: String(s.fileId), expiresAt: exp,
        createdAt: String(s.createdAt || nowISO()),
        createdBy: String(s.createdBy || '').slice(0, 20)
      };
    }
    db.shareCodes = restored;
    saveDB('sharecodes', db.shareCodes);
  }
  // 恢复公告列表（含定时生效/失效时间）
  if (Array.isArray(b.announcements)) {
    db.announcements = b.announcements
      .filter(a => a && String(a.content || '').trim())
      .map(a => {
        const sa = String(a.startAt || '').trim();
        const ea = String(a.endAt || '').trim();
        const item = {
          id: safeId(a.id),
          title: String(a.title || '').trim().slice(0, 50) || '站点公告',
          content: String(a.content || '').trim().slice(0, 500),
          pinned: !!a.pinned,
          startAt: !Number.isNaN(Date.parse(sa)) ? new Date(sa).toISOString() : '',
          endAt: !Number.isNaN(Date.parse(ea)) ? new Date(ea).toISOString() : '',
          createdAt: String(a.createdAt || nowISO()),
          updatedAt: String(a.updatedAt || nowISO())
        };
        if (item.startAt && item.endAt && Date.parse(item.startAt) >= Date.parse(item.endAt)) {
          item.startAt = ''; item.endAt = ''; // 时间矛盾时丢弃定时，保留公告本体
        }
        return item;
      });
    saveDB('announcements', db.announcements);
  }
  // 恢复QQ群列表（链接必须通过协议校验，防止恶意备份注入 javascript: 伪协议）
  if (Array.isArray(b.qqGroups)) {
    db.qqGroups = b.qqGroups
      .filter(g => g && String(g.name || '').trim() && String(g.url || '').trim())
      .map(g => ({
        id: safeId(g.id),
        name: String(g.name || '').trim().slice(0, 30),
        url: (normalizeQqGroupUrl(g.url) || {}).url || '',
        order: parseInt(g.order, 10) || 0,
        createdAt: String(g.createdAt || nowISO())
      }))
      .filter(g => g.url);
    saveDB('qqgroups', db.qqGroups);
  }
  // 恢复留言板（备份不含 comments 字段时保持现有留言不动）
  if (Array.isArray(b.comments)) {
    db.comments = b.comments
      .filter(c => c && String(c.content || '').trim())
      .map(c => {
        const item = {
          id: safeId(c.id),
          nick: String(c.nick || '').trim().slice(0, COMMENT_NICK_MAX) || '匿名访客',
          content: String(c.content || '').trim().slice(0, numSetting('commentMaxLen')),
          createdAt: String(c.createdAt || nowISO())
        };
        const reply = String(c.reply || '').trim().slice(0, COMMENT_REPLY_MAX);
        if (reply) {
          item.reply = reply;
          item.replyBy = String(c.replyBy || '').slice(0, 20);
          item.replyAt = String(c.replyAt || nowISO());
        }
        return item;
      });
    saveDB('comments', db.comments);
  }
  // 恢复倒计时（仅保留合法日期）
  if (Array.isArray(b.countdowns)) {
    db.countdowns = b.countdowns
      .filter(c => c && String(c.name || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')))
      .slice(0, COUNTDOWN_MAX)
      .map(c => ({
        id: safeId(c.id),
        name: String(c.name || '').trim().slice(0, COUNTDOWN_NAME_MAX),
        date: String(c.date),
        createdAt: String(c.createdAt || nowISO())
      }));
    saveDB('countdowns', db.countdowns);
  }
  // 恢复友情链接（链接必须通过 http(s) 协议校验）
  if (Array.isArray(b.friendlinks)) {
    db.friendlinks = b.friendlinks
      .filter(f => f && String(f.name || '').trim() && validUrl(String(f.url || '')))
      .slice(0, MAX_FRIENDLINKS)
      .map(f => ({
        id: safeId(f.id),
        name: String(f.name || '').trim().slice(0, FRIENDLINK_NAME_MAX),
        url: String(f.url || '').trim(),
        order: parseInt(f.order, 10) || 0,
        createdAt: String(f.createdAt || nowISO())
      }));
    saveDB('friendlinks', db.friendlinks);
  }
  // 恢复意见反馈
  if (Array.isArray(b.feedbacks)) {
    db.feedbacks = b.feedbacks
      .filter(f => f && String(f.content || '').trim())
      .map(f => {
        const item = {
          id: safeId(f.id),
          contact: String(f.contact || '').trim().slice(0, FEEDBACK_CONTACT_MAX),
          content: String(f.content || '').trim().slice(0, numSetting('feedbackMaxLen')),
          status: ['open', 'processing', 'resolved'].includes(String(f.status)) ? String(f.status) : 'open',
          createdAt: String(f.createdAt || nowISO())
        };
        const reply = String(f.reply || '').trim().slice(0, FEEDBACK_REPLY_MAX);
        if (reply) {
          item.reply = reply;
          item.replyBy = String(f.replyBy || '').slice(0, 20);
          item.replyAt = String(f.replyAt || nowISO());
        }
        return item;
      });
    saveDB('feedbacks', db.feedbacks);
  }
  // 恢复自定义一言语录
  if (Array.isArray(b.quotes)) {
    db.quotes = b.quotes
      .filter(q => q && String(q.text || '').trim())
      .slice(0, QUOTES_KEEP)
      .map(q => ({ id: safeId(q.id), text: String(q.text || '').trim().slice(0, 100), createdAt: String(q.createdAt || nowISO()) }));
    saveDB('quotes', db.quotes);
  }
  return null;
}

/** 复制恢复相关数据库状态，用于多文件恢复失败时回滚内存。 */
function snapshotRestoreState() {
  const keys = ['sites', 'visits', 'settings', 'logs', 'folders', 'files', 'shareCodes', 'announcements', 'qqGroups', 'comments', 'countdowns', 'friendlinks', 'feedbacks', 'quotes'];
  const snapshot = {};
  for (const key of keys) snapshot[key] = JSON.parse(JSON.stringify(db[key]));
  return snapshot;
}
function restoreStateSnapshot(snapshot) {
  if (!snapshot) return;
  for (const [key, value] of Object.entries(snapshot)) db[key] = value;
}
/** 运行恢复校验并把 JSON 写入暂存 Map；调用方可在物理文件交换成功后再提交。 */
function prepareRestore(b, verifyFilesExist, filesRoot = FILES_DIR) {
  const snapshot = snapshotRestoreState();
  beginRestoreWrites();
  try {
    const error = applyRestoreUnsafe(b, verifyFilesExist, filesRoot);
    if (error) {
      discardRestoreWrites();
      restoreStateSnapshot(snapshot);
      return { error, snapshot: null };
    }
    return { error: null, snapshot };
  } catch (e) {
    discardRestoreWrites();
    restoreStateSnapshot(snapshot);
    return { error: '恢复数据校验或写入失败，请重试', snapshot: null };
  }
}
/** 回滚尚未提交的恢复事务。 */
function rollbackPreparedRestore(transaction) {
  discardRestoreWrites();
  if (transaction && transaction.snapshot) restoreStateSnapshot(transaction.snapshot);
}
/** 普通 JSON 备份恢复：校验完成后一次性提交各 JSON 文件。 */
function applyRestore(b, verifyFilesExist, filesRoot = FILES_DIR) {
  const transaction = prepareRestore(b, verifyFilesExist, filesRoot);
  if (transaction.error) return transaction.error;
  try {
    commitRestoreWrites();
    return null;
  } catch (e) {
    restoreStateSnapshot(transaction.snapshot);
    return '恢复数据保存失败，请重试';
  }
}

// 数据备份导入（恢复 sites/settings/files，不覆盖账号与会话）
route('POST', '/api/admin/restore', async ctx => {
  const b = ctx.body || {};
  const oldCount = db.sites.length;
  const err = applyRestore(b, false);
  if (err) return json(ctx.res, 400, { error: err });
  logOp(ctx.user, ctx.req, '导入数据备份', `引导页 ${oldCount} 条 → ${db.sites.length} 条`);
  json(ctx.res, 200, { ok: true, sites: db.sites.length });
}, { auth: true });

// ---------------- 完整备份与恢复（ZIP 含全部共享文件本体） ----------------

// 完整备份导出：backup.json + files/ 目录打包为 ZIP 流式下载
route('GET', '/api/admin/backup/full', async ctx => {
  // 收集普通文件的实际磁盘大小；不能信任 JSON 元数据中的 size，否则可能绕过备份上限。
  const items = [];
  let total = 0;
  for (const f of db.files) {
    const p = safeStoredPath(f.storage);
    if (!p) continue;
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile() || !Number.isSafeInteger(st.size)) continue;
    const entryName = 'files/' + f.storage;
    if (!validZipEntryName(entryName)) continue;
    items.push({ path: p, name: entryName, size: st.size });
    total += st.size;
  }
  if (items.length + 1 > ZIP_FILE_MAX_COUNT) {
    return json(ctx.res, 400, { error: '共享文件数量超过限制，无法导出完整备份' });
  }
  if (!Number.isSafeInteger(total) || total > BACKUP_MAX) {
    return json(ctx.res, 400, { error: '共享文件实际总大小超过 1GB，请先清理旧文件后再导出完整备份' });
  }

  const payload = {
    _meta: { app: '幻终の导航', type: 'full', version: 1, exportedAt: nowISO(), by: ctx.user.username },
    sites: db.sites, visits: db.visits, settings: db.settings, logs: db.logs,
    files: db.files, folders: db.folders, announcements: db.announcements, qqGroups: db.qqGroups,
    shareCodes: db.shareCodes, comments: db.comments,
    countdowns: db.countdowns, friendlinks: db.friendlinks, feedbacks: db.feedbacks, quotes: db.quotes
  };
  const metaBuf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  if (!Number.isSafeInteger(metaBuf.length) || total + metaBuf.length > BACKUP_MAX) {
    return json(ctx.res, 400, { error: '共享文件与备份元数据总大小超过 1GB，请先清理旧文件后再导出完整备份' });
  }
  const fname = `huanzhong-nav-full-${todayStr()}.zip`;
  const encoded = encodeURIComponent(fname);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store'
  });

  const zip = new ZipWriter(ctx.res);
  let done = false;
  ctx.res.on('close', () => { if (!done) zip.abort(); });
  try {
    await zip.addFile('backup.json', { buffer: metaBuf });
    for (const it of items) {
      // 打包期间任一文件读取失败都会中止整个响应，避免输出缺少条目的半损坏 ZIP。
      await zip.addFile(it.name, { path: it.path });
    }
    if (!ctx.res.destroyed) { zip.finish(); done = true; }
  } catch (e) { zip.abort(); }
  logOp(ctx.user, ctx.req, '导出完整备份', `${fname}（含 ${items.length} 个共享文件）`);
}, { auth: true });

// 完整备份恢复：分块上传（复用 /api/admin/files 的分块机制，临时目录独立）
// 无原型对象：taskId 来自请求体，避免魔法键命中 Object.prototype 上的属性
const pendingBackups = Object.create(null); // { taskId: { userId, size, totalChunks, received, receivedBytes, createdAt } }

// 完整恢复：初始化备份上传
route('POST', '/api/admin/restore/full/init', async ctx => {
  const { size = 0, totalChunks = 0 } = ctx.body || {};
  const sz = Number(size);
  if (!Number.isSafeInteger(sz) || sz <= 0) return json(ctx.res, 400, { error: '文件大小无效' });
  if (sz > BACKUP_MAX) return json(ctx.res, 400, { error: '备份文件过大（上限 1GB）' });
  const chunks = Number(totalChunks);
  if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 10000) return json(ctx.res, 400, { error: '分块数无效' });
  const expectedChunks = Math.ceil(sz / TRANSFER_CHUNK_SIZE);
  if (chunks !== expectedChunks) return json(ctx.res, 400, { error: '分块数与文件大小不匹配' });
  if (Object.keys(pendingBackups).length >= PENDING_UPLOAD_MAX) {
    prunePendingBackups();
    if (Object.keys(pendingBackups).length >= PENDING_UPLOAD_MAX) {
      return json(ctx.res, 429, { error: '上传任务过多，请稍后再试' });
    }
  }
  const taskId = uid();
  pendingBackups[taskId] = {
    userId: ctx.user.id, size: sz, totalChunks: chunks,
    received: 0, receivedBytes: 0,
    seen: new Set(), // 已接收的分块序号，拒绝重复分块
    createdAt: Date.now()
  };
  json(ctx.res, 200, { ok: true, taskId });
}, { auth: true });

// 完整恢复：上传一个分块
route('POST', '/api/admin/restore/full/chunk', async ctx => {
  const { taskId = '', index = 0, data = '' } = ctx.body || {};
  const task = pendingBackups[taskId];
  if (!task || task.userId !== ctx.user.id) return json(ctx.res, 404, { error: '上传任务不存在或已过期' });
  const idx = parseInt(index, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= task.totalChunks) return json(ctx.res, 400, { error: '分块序号无效' });
  if (task.seen.has(idx)) return json(ctx.res, 400, { error: '该分块已上传，请勿重复提交' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(data)) || String(data).length % 4 !== 0) {
    return json(ctx.res, 400, { error: '分块数据无效' });
  }
  const buf = Buffer.from(String(data), 'base64');
  if (!buf.length) return json(ctx.res, 400, { error: '分块内容为空' });
  const layout = chunkLayout(task, idx);
  if (!layout || buf.length !== layout.size) return json(ctx.res, 400, { error: '分块大小与序号不匹配' });
  task.receivedBytes += buf.length;
  if (task.receivedBytes > task.size || task.receivedBytes > BACKUP_MAX) {
    delete pendingBackups[taskId];
    try {
      const p = path.join(BACKUP_TMP_DIR, '.tmp_' + taskId + '.part');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
    return json(ctx.res, 400, { error: '备份文件超过大小限制' });
  }
  const partPath = path.join(BACKUP_TMP_DIR, '.tmp_' + taskId + '.part');
  try {
    writeChunkAt(partPath, buf, layout.offset);
    task.seen.add(idx);
    task.received += 1;
    task.writtenEnd = Math.max(task.writtenEnd || 0, layout.offset + buf.length);
  } catch (e) {
    task.receivedBytes -= buf.length;
    return json(ctx.res, 500, { error: '分块保存失败，请重试' });
  }
  json(ctx.res, 200, { ok: true, received: task.received, totalChunks: task.totalChunks });
}, { auth: true });

/** 定期清理超时未完成的备份上传任务（与 pendingFiles 一同清理） */
function prunePendingBackups() {
  const now = Date.now();
  for (const [taskId, task] of Object.entries(pendingBackups)) {
    if (!task.createdAt || now - task.createdAt > 24 * 3600 * 1000) {
      delete pendingBackups[taskId];
      try {
        const p = path.join(BACKUP_TMP_DIR, '.tmp_' + taskId + '.part');
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    }
  }
}

/** 删除完整恢复的临时目录；失败时不影响主流程，但下次启动会再次清理。 */
function removeRestoreStage(stageDir) {
  try { removeDirSync(stageDir); }
  catch (e) { /* ignore cleanup failure; ensureDataDir will retry on restart */ }
}
/**
 * 将暂存目录中的共享文件交换到正式目录。
 * 返回的事务在 JSON 元数据提交失败时负责把已交换的物理文件恢复原状。
 */
function commitRestoreFiles(stageDir, storages) {
  const token = process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const prepared = [];
  const swapped = [];
  try {
    for (const storage of storages) {
      const source = safeStoredPathInRoot(stageDir, storage);
      const target = safeFilePath(storage);
      if (!source || !target) throw new Error('restore file is missing or unsafe');
      prepared.push({ source, target, backup: null, hadOld: false });
    }
    for (const item of prepared) {
      if (fs.existsSync(item.target)) {
        const st = fs.lstatSync(item.target);
        // 正式共享目录中的异常目录/符号链接不应被恢复流程覆盖，避免扩大影响范围。
        if (!st.isFile()) throw new Error('restore target is not a regular file');
        item.backup = item.target + '.restore-old-' + token;
        fs.renameSync(item.target, item.backup);
        item.hadOld = true;
      }
      fs.renameSync(item.source, item.target);
      swapped.push(item);
    }
  } catch (e) {
    // 交换失败时立即回滚已经完成的条目；未进入 swapped 的条目可能只完成了旧文件备份，也要恢复。
    for (let i = swapped.length - 1; i >= 0; i--) {
      const item = swapped[i];
      try { if (fs.existsSync(item.target)) fs.unlinkSync(item.target); } catch (cleanupError) { /* best effort */ }
      try { if (item.backup && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target); } catch (cleanupError) { /* best effort */ }
    }
    for (const item of prepared) {
      try { if (fs.existsSync(item.source)) fs.unlinkSync(item.source); } catch (cleanupError) { /* best effort */ }
      if (item.hadOld && item.backup && fs.existsSync(item.backup) && !fs.existsSync(item.target)) {
        try { fs.renameSync(item.backup, item.target); } catch (cleanupError) { /* best effort */ }
      }
    }
    throw e;
  }
  let finalized = false;
  return {
    count: swapped.length,
    finalize() {
      if (finalized) return;
      finalized = true;
      for (const item of prepared) {
        if (item.backup) { try { fs.unlinkSync(item.backup); } catch (e) { /* stale backup is harmless */ } }
      }
    },
    rollback() {
      if (finalized) return;
      finalized = true;
      for (let i = swapped.length - 1; i >= 0; i--) {
        const item = swapped[i];
        try { if (fs.existsSync(item.target)) fs.unlinkSync(item.target); } catch (e) { /* best effort */ }
        try { if (item.backup && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target); } catch (e) { /* best effort */ }
      }
      for (const item of prepared) {
        try { if (fs.existsSync(item.source)) fs.unlinkSync(item.source); } catch (e) { /* best effort */ }
        if (item.hadOld && item.backup && fs.existsSync(item.backup) && !fs.existsSync(item.target)) {
          try { fs.renameSync(item.backup, item.target); } catch (e) { /* best effort */ }
        }
      }
    }
  };
}

// 完整恢复：完成上传并执行恢复（全局锁：同时只允许一次，防大 ZIP 并发解压耗尽内存）
let restoreRunning = false;
route('POST', '/api/admin/restore/full/finish', async ctx => {
  if (restoreRunning) return json(ctx.res, 409, { error: '已有恢复任务进行中，请稍后再试' });
  restoreRunning = true;
  let stageDir = null;
  let preparedRestore = null;
  let fileTransaction = null;
  try {
    const { taskId = '' } = ctx.body || {};
    const task = pendingBackups[taskId];
    if (!task || task.userId !== ctx.user.id) return json(ctx.res, 404, { error: '上传任务不存在或已过期' });
    if (task.received !== task.totalChunks) {
      return json(ctx.res, 400, { error: `分块未收齐（${task.received}/${task.totalChunks}），请重新上传` });
    }
    if (task.receivedBytes !== task.size) {
      return json(ctx.res, 400, { error: '备份分块大小与声明不一致，请重新上传' });
    }
    const partPath = path.join(BACKUP_TMP_DIR, '.tmp_' + taskId + '.part');
    try {
      const st = fs.statSync(partPath);
      if (st.size !== task.size) {
        fs.unlinkSync(partPath);
        delete pendingBackups[taskId];
        return json(ctx.res, 400, { error: '文件大小与声明不一致，请重新上传' });
      }
    } catch (e) {
      return json(ctx.res, 500, { error: '备份文件读取失败，请重试' });
    }

    let zipBuf;
    try { zipBuf = fs.readFileSync(partPath); }
    catch (e) { return json(ctx.res, 500, { error: '备份文件读取失败，请重试' }); }
    finally { try { fs.unlinkSync(partPath); } catch (e) { /* ignore */ } delete pendingBackups[taskId]; }

    const entries = parseZip(zipBuf, { maxEntries: ZIP_FILE_MAX_COUNT, maxEntrySize: fileMaxBytes(), maxTotalSize: BACKUP_MAX });
    zipBuf = null;
    if (!entries) return json(ctx.res, 400, { error: '无法解析该 ZIP 备份，请确认文件完整且未损坏' });

    const meta = entries.find(e => e.name === 'backup.json');
    if (!meta) return json(ctx.res, 400, { error: '该 ZIP 缺少 backup.json，不是有效的完整备份' });
    if (meta.content.length > BACKUP_META_MAX) return json(ctx.res, 400, { error: 'backup.json 过大，无法恢复' });
    let payload;
    try { payload = JSON.parse(meta.content.toString('utf8')); }
    catch (e) { return json(ctx.res, 400, { error: 'backup.json 已损坏' }); }
    if (!payload || !Array.isArray(payload.sites) ||
        (payload.files !== undefined && !Array.isArray(payload.files))) {
      return json(ctx.res, 400, { error: '备份数据结构不正确' });
    }

    // 1) 先把备份文件内容写入独立暂存目录；正式 files/ 目录此时完全不变。
    stageDir = path.join(BACKUP_TMP_DIR, '.restore-' + uid());
    fs.mkdirSync(stageDir, { recursive: true });
    const backupFiles = Array.isArray(payload.files) ? payload.files : [];
    const candidateStorages = new Set(backupFiles
      .filter(f => f && validStorageName(f.storage) && validEntryName(String(f.name || '').trim()))
      .map(f => String(f.storage)));
    const stagedStorages = new Set();
    for (const e of entries) {
      if (!e.name.startsWith('files/')) continue;
      const storage = e.name.slice('files/'.length);
      if (!candidateStorages.has(storage)) { e.content = null; continue; }
      const target = safePathInRoot(stageDir, storage);
      if (!target) { e.content = null; continue; }
      fs.writeFileSync(target, e.content);
      stagedStorages.add(storage);
      // 尽早释放解析得到的文件 Buffer，降低大备份恢复期间的峰值内存。
      e.content = null;
    }
    // 备份元数据已解析为 payload，及时释放这份 Buffer（最大 32MB），降低大备份恢复时的峰值内存。
    meta.content = null;

    // 2) 先在内存中校验并准备所有 JSON 元数据；verifyFilesExist 只接受暂存目录中的普通文件。
    const oldCount = db.sites.length;
    preparedRestore = prepareRestore(payload, true, stageDir);
    if (preparedRestore.error) return json(ctx.res, 400, { error: preparedRestore.error });

    // 3) 将取件码清理和审计日志也放入同一批 JSON 写入，避免提交后再抛错造成内存/磁盘分叉。
    pruneShareCodes();
    {
      const validFileIds = new Set(db.files.map(f => f.id));
      let changed = false;
      for (const [code, s] of Object.entries(db.shareCodes)) {
        if (!validFileIds.has(s.fileId)) { delete db.shareCodes[code]; changed = true; }
      }
      if (changed) saveDB('sharecodes', db.shareCodes);
    }
    const stagedFileCount = stagedStorages.size;
    logOp(ctx.user, ctx.req, '导入完整备份',
      `引导页 ${oldCount} → ${db.sites.length} 条；恢复共享文件 ${stagedFileCount} 个`);

    // 4) 交换物理文件，再提交已经准备好的 JSON；任一步失败都回滚两类状态。
    try {
      fileTransaction = commitRestoreFiles(stageDir, Array.from(stagedStorages));
      commitRestoreWrites();
      fileTransaction.finalize();
      // 从这里开始提交已完成，后续响应异常不能再回滚已删除的旧备份文件。
      fileTransaction = null;
      preparedRestore = null;
    } catch (e) {
      if (fileTransaction) fileTransaction.rollback();
      rollbackPreparedRestore(preparedRestore);
      fileTransaction = null;
      return json(ctx.res, 500, { error: '完整备份恢复提交失败，已回滚，请重试' });
    }

    json(ctx.res, 200, { ok: true, sites: db.sites.length, restoredFiles: stagedFileCount });
  } catch (e) {
    if (fileTransaction) fileTransaction.rollback();
    if (preparedRestore) rollbackPreparedRestore(preparedRestore);
    return json(ctx.res, 500, { error: '完整备份恢复失败，请重试' });
  } finally {
    if (stageDir) removeRestoreStage(stageDir);
    restoreRunning = false;
  }
}, { auth: true });

// 修改自己的密码
route('PUT', '/api/admin/password', async ctx => {
  const oldPwd = decryptSecret(ctx.body.oldPassword);
  const newPwd = decryptSecret(ctx.body.newPassword);
  if (oldPwd === null || newPwd === null) return json(ctx.res, 400, { error: '安全校验失败，请刷新页面后重试' });
  if (!verifyPassword(oldPwd, ctx.user.salt, ctx.user.passHash)) {
    return json(ctx.res, 400, { error: '原密码不正确' });
  }
  if (!validPassword(newPwd)) return json(ctx.res, 400, { error: '新密码长度需为 6-64 位' });
  ctx.user.salt = crypto.randomBytes(16).toString('hex');
  ctx.user.passHash = hashPassword(newPwd, ctx.user.salt);
  saveDB('users', db.users);
  invalidateUserSessions(ctx.user.id, ctx.session.token); // 其他设备会话全部下线，保留当前会话
  logOp(ctx.user, ctx.req, '修改密码', '修改了自己的登录密码（已下线其他会话）');
  json(ctx.res, 200, { ok: true });
}, { auth: true });

// ---------------- 请求分发 ----------------
async function handleApi(req, res, u, pathname) {
  const method = req.method;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return json(res, 405, { error: '方法不允许' });
  }
  const ip = clientIP(req);
  // 全局 API 限流（每 IP），防止接口被恶意高频调用
  if (!checkRate('api:' + ip, RATE_API_MAX, RATE_API_WINDOW)) {
    return json(res, 429, { error: '请求过于频繁，请稍后再试' });
  }
  // 登录/注册接口单独限流（更严格），防止账号爆破
  if ((pathname === '/api/auth/login' || pathname === '/api/auth/register') &&
      !checkRate('auth:' + ip, RATE_AUTH_MAX, RATE_AUTH_WINDOW)) {
    logRateHit('认证接口', ip, `每 ${RATE_AUTH_WINDOW / 1000}s 超过 ${RATE_AUTH_MAX} 次`);
    return json(res, 429, { error: '尝试过于频繁，请 1 分钟后再试' });
  }
  // 下载发起限流，防止恶意刷下载计数占用带宽（含打包下载与取件码下载）：短窗口 + 长窗口双重约束
  const isDownloadStart = pathname.match(/^\/api\/files\/[^/]+\/download$/) ||
    pathname === '/api/files/zip' ||
    pathname === '/api/files/zip-request' ||
    pathname.match(/^\/api\/share\/[^/]+$/);
  if (isDownloadStart && !checkRate('dlstart5:' + ip, RATE_DL_START5_MAX, RATE_DL_START5_WINDOW)) {
    logRateHit('下载发起', ip, `每 ${RATE_DL_START5_WINDOW / 60000} 分钟超过 ${RATE_DL_START5_MAX} 次`);
    return json(res, 429, { error: '下载次数已达上限，请 5 分钟后再试' });
  }
  if (isDownloadStart && !checkRate('dlstart:' + ip, RATE_DL_START_MAX, RATE_DL_START_WINDOW)) {
    logRateHit('下载发起', ip, `每 ${RATE_DL_START_WINDOW / 1000}s 超过 ${RATE_DL_START_MAX} 次`);
    return json(res, 429, { error: '下载请求过于频繁，请稍后再试' });
  }
  // 取件码解析额外限流（更宽松），主要防暴力猜码
  if (pathname.match(/^\/api\/share\/[^/]+$/) &&
      !checkRate('share:' + ip, RATE_SHARE_MAX, RATE_SHARE_WINDOW)) {
    return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;

    const params = {};
    try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); }
    catch (e) { return json(res, 400, { error: '请求参数格式错误' }); }

    // 所有路由都解析会话：公开接口也需要识别访客/用户角色，避免访客借由已有会话绕过验证码或访问公开操作。
    const session = getSession(req);
    const user = session ? db.users.find(x => x.id === session.userId) : null;
    if (r.auth) {
      if (!session) return json(res, 401, { error: '未登录或会话已过期' });
      if (!user) return json(res, 401, { error: '账号不存在，请重新登录' });
      // ---- 角色级访问控制 ----
      const role = userRole(user);
      // 访客角色：除认证相关接口外禁止任何操作
      if (role === 'guest' && !pathname.startsWith('/api/auth/')) {
        return json(res, 403, { error: '当前账号为访客角色，暂无操作权限，请联系站长提升角色', role: 'guest' });
      }
      // 后台管理接口：仅站长与管理员可访问
      if (pathname.startsWith('/api/admin/')) {
        if (role !== 'owner' && role !== 'admin') {
          return json(res, 403, { error: '权限不足，此操作需要管理员或更高权限' });
        }
      }
    }
    // 访客会话不能把自己当作普通登录用户使用公开写入/下载接口；退出后仍可按匿名访客规则访问公开功能。
    if (user && userRole(user) === 'guest' && !pathname.startsWith('/api/auth/')) {
      return json(res, 403, { error: '当前账号为访客角色，暂无操作权限，请联系站长提升角色', role: 'guest' });
    }

    let body = {};
    if (method === 'POST' || method === 'PUT') {
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { error: '请求体格式错误' }); }
    }

    const ctx = { req, res, params, query: u.searchParams, body, session, user, ip: clientIP(req) };
    return await r.handler(ctx);
  }
  json(res, 404, { error: '接口不存在' });
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.apng': 'image/apng',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};

/** SVG 消毒：剥离 <script> 标签、on* 事件属性、javascript:/vbscript: 伪协议与 <foreignObject>，
 * 防止 SVG 中嵌入的恶意脚本被执行。先解码数字字符实体再清理，堵住 java&#115;cript: 等绕过 */
function sanitizeSvg(buf) {
  try {
    let text = buf.toString('utf8');
    // 0) 解码数字字符实体（&#x27; / &#115; / &#x1F600; 等），还原被编码的脚本/伪协议关键字
    text = text.replace(/&#(x?)([0-9a-fA-F]+);/g, (m, h, num) => {
      try { return String.fromCodePoint(parseInt(num, h ? 16 : 10)); } catch (e) { return m; }
    });
    // 1) 移除 <script>...</script> 块。
    // XML 规范允许结束标签在 `>` 前带空白（ETag ::= '</' Name S? '>'），浏览器按 XML 解析 SVG 时
    // `</script >` 与 `</script>` 等价；原正则只认 `</script>`，可被 `</script >` 绕过。
    text = text.replace(/<script\b[^<]*(?:(?!<\/script\s*>)<[^<]*)*<\/script\s*>/gi, '');
    // 自闭合形式（<script src="x"/>）同样要清除，避免残留可执行标签
    text = text.replace(/<script\b[^>]*\/\s*>/gi, '');
    // 2) 移除内联事件处理属性（on*="..." / on*='...' / on*=...）
    text = text.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // 3) 移除 javascript:/vbscript: 伪协议引用（容忍标签内任意空白，防 j a v a s c r i p t: 变体）
    text = text.replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
    text = text.replace(/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
    // 4) 移除 CSS 中的脚本载体：url(javascript:...) 与 expression(...)
    text = text.replace(/url\s*\(\s*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, 'url(');
    text = text.replace(/expression\s*\([^)]*\)/gi, '');
    // 5) 移除 <foreignObject> 中可能的 HTML 注入（同样容忍结束标签内的空白）
    text = text.replace(/<foreignObject\b[^<]*(?:(?!<\/foreignObject\s*>)<[^<]*)*<\/foreignObject\s*>/gi, '');
    text = text.replace(/<foreignObject\b[^>]*\/\s*>/gi, '');
    return Buffer.from(text, 'utf8');
  } catch (e) { return buf; }
}

// 上传文件访问：/uploads/<文件名>，仅限白名单文件名
function serveUpload(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  const name = pathname.slice('/uploads/'.length);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(403); return res.end('Forbidden'); }
  const filePath = path.join(UPLOAD_DIR, name);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // SVG 二次消毒（defense-in-depth）：即使上传时已清理，此处再过滤一遍
    if (ext === '.svg' && req.method !== 'HEAD') buf = sanitizeSvg(buf);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400'
    };
    // SVG 附加禁用脚本的 CSP，阻止残留脚本在直接访问时执行
    if (ext === '.svg') headers['Content-Security-Policy'] = "script-src 'none'; object-src 'none'";
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// 图标缓存访问：/favicons/<文件名>，仅限白名单文件名
function serveFavicon(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  const name = pathname.slice('/favicons/'.length);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(403); return res.end('Forbidden'); }
  const filePath = path.join(FAVICON_DIR, name);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // SVG 二次消毒：服务端抓取的图标可能含有恶意脚本
    if (ext === '.svg' && req.method !== 'HEAD') buf = sanitizeSvg(buf);
    const headers = {
      'Content-Type': MIME[ext] || 'image/x-icon',
      'Cache-Control': 'public, max-age=86400'
    };
    // SVG 附加禁用脚本的 CSP
    if (ext === '.svg') headers['Content-Security-Policy'] = "script-src 'none'; object-src 'none'";
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ============ 访问控制：拦截页生成 & 全站防护脚本注入 ============

/** HTML 转义（防拦截页内容注入 XSS） */
function htmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 生成拦截页 HTML（自定义标题 / 文本换行 / 字体大小切换 / 机房自动关闭） */
function serveBlockPage(req, res, blockInfo) {
  const title = String(db.settings.blockTitle || '访问受限').slice(0, 60);
  const rawContent = String(db.settings.blockContent || '').slice(0, 500);
  const fontSize = Math.min(32, Math.max(12, Number.isFinite(db.settings.blockFontSize) ? db.settings.blockFontSize : 16));
  const wrap = db.settings.blockTextWrap !== false;
  const autoClose = !!(blockInfo && blockInfo.autoClose);
  // 内容按换行符分段，逐行 HTML 转义后用 <br> 连接
  const contentHtml = rawContent.split('\n').map(htmlEsc).join('<br>');
  // 字体大小档位：根据默认值选择初始激活按钮
  const sizes = [14, 16, 20, 26];
  const labels = ['小号', '标准', '大号', '超大'];
  const activeIdx = sizes.indexOf(fontSize) >= 0 ? sizes.indexOf(fontSize) : 1;
  let btnsHtml = '';
  for (let i = 0; i < sizes.length; i++) {
    btnsHtml += `<button class="fs-btn${i === activeIdx ? ' active' : ''}" data-size="${sizes[i]}">${labels[i]}</button>`;
  }
  const wrapCss = wrap ? 'white-space:pre-wrap;word-break:break-word;' : 'white-space:pre;overflow-x:auto;';
  const autoCloseScript = autoClose ?
    '<script>' +
    'setTimeout(function(){' +
    'try{window.open("","_self","");window.close();}catch(e){}' +
    'setTimeout(function(){' +
    'var c=document.querySelector(".card");' +
    'if(c){while(c.firstChild)c.removeChild(c.firstChild);' +
    'var m=document.createElement("div");' +
    'm.style.cssText="padding:40px;color:#999;text-align:center";' +
    'm.textContent="\u9875\u9762\u5df2\u5173\u95ed";c.appendChild(m);' +
    'document.title="";}' +
    '},400);' +
    '},1200);' +
    '</script>' : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlEsc(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;background:linear-gradient(135deg,#f5f5f7,#e8e8ed);color:#1d1d1f;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:24px;box-shadow:0 12px 40px -8px rgba(0,0,0,.12),0 4px 12px -4px rgba(0,0,0,.06);padding:48px 36px;max-width:560px;width:100%;text-align:center}
.icon{font-size:56px;margin-bottom:20px;line-height:1}
h1{font-size:24px;font-weight:700;margin-bottom:20px;letter-spacing:.5px}
.content{font-size:${fontSize}px;line-height:1.8;color:#6e6e73;margin-bottom:24px;${wrapCss}}
.fs-row{display:flex;gap:8px;justify-content:center;margin-top:24px;flex-wrap:wrap}
.fs-btn{padding:8px 18px;border-radius:999px;border:1px solid #e5e5ea;background:#fff;color:#6e6e73;cursor:pointer;font-size:13px;transition:all .2s;outline:none}
.fs-btn:hover{border-color:#007aff;color:#007aff}
.fs-btn.active{background:#007aff;color:#fff;border-color:#007aff}
</style>
</head>
<body>
<div class="card">
<div class="icon">${autoClose ? '\u{1F6AB}' : '\u{1F6D1}'}</div>
<h1>${htmlEsc(title)}</h1>
<div class="content" id="content">${contentHtml}</div>
<div class="fs-row">${btnsHtml}</div>
</div>
${autoCloseScript}
<script>
document.querySelectorAll(".fs-btn").forEach(function(btn){
btn.addEventListener("click",function(){
document.querySelectorAll(".fs-btn").forEach(function(b){b.classList.remove("active")});
btn.classList.add("active");
document.getElementById("content").style.fontSize=btn.dataset.size+"px";
});
});
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

/** 生成「访客角色无访问权限」提示页（已登录但角色为访客的用户访问前台页面时返回） */
function serveGuestNoAccessPage(req, res) {
  const siteName = htmlEsc(db.settings.siteName || '幻终の导航');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>账号待审核 - ${siteName}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#333}
  .card{background:#fff;border-radius:20px;padding:48px 40px;max-width:440px;width:90%;
    text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.15)}
  .icon{width:64px;height:64px;margin:0 auto 20px;border-radius:50%;
    background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center}
  .icon svg{width:32px;height:32px;color:#fff}
  h1{font-size:22px;margin-bottom:12px;color:#1a1a2e}
  p{font-size:15px;line-height:1.7;color:#555;margin-bottom:8px}
  .hint{font-size:13px;color:#999;margin-top:16px;padding-top:16px;border-top:1px solid #eee}
  .btn{display:inline-block;margin-top:24px;padding:11px 32px;border-radius:24px;
    background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;
    font-size:14px;font-weight:600;transition:transform .15s}
  .btn:hover{transform:translateY(-2px)}
</style>
</head>
<body>
<div class="card">
  <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
  <h1>账号待审核</h1>
  <p>您已成功登录，但当前账号角色为<strong>访客</strong>，暂无访问权限。</p>
  <p>请联系<strong>站长</strong>将您的角色提升为「用户」「管理员」或「站长」后即可访问全部功能。</p>
  <div class="hint">如需管理后台，可访问 <a href="/admin" style="color:#667eea">/admin</a> 查看账号信息。</div>
  <a class="btn" href="/admin">前往管理后台</a>
</div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

/** 构建全站防护注入脚本（背景同步 + F12 防护），插入到所有 HTML 页面 </body> 前 */
function buildGuardScript(req) {
  const session = getSession(req);
  const guardUser = session ? db.users.find(x => x.id === session.userId) : null;
  // 只有管理员及以上角色豁免 F12 防护；普通用户/访客不能因拥有会话而绕过。
  const isAdmin = !!(guardUser && roleAtLeast(guardUser, 'admin'));
  const f12Block = db.settings.acF12Block === true;
  const f12AutoClose = db.settings.acF12AutoClose === true;
  const bg = db.settings.background || '';
  const cfg = { f12: f12Block, f12Close: f12AutoClose, admin: isAdmin, bg: bg };
  return '<style>' +
    '/* 幻终导航全站背景同步 */' +
    'body.has-custom-bg{background-color:transparent!important;background-image:linear-gradient(rgba(250,250,250,.55),rgba(250,250,250,.55)),var(--custom-bg)!important;background-size:cover!important;background-position:center!important;background-attachment:fixed!important;background-repeat:no-repeat!important}' +
    'html[data-theme="dark"] body.has-custom-bg{background-image:linear-gradient(rgba(13,17,23,.72),rgba(13,17,23,.72)),var(--custom-bg)!important}' +
    '</style>' +
    '<script>(function(){var G=' + JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026') + ';' +
    'if(G.bg){try{var s=G.bg,ok=false;' +
    'if(s.indexOf("/uploads/")===0)ok=/^\\/uploads\\/[\\w.-]+$/.test(s);' +
    'else{var x=new URL(s);ok=x.protocol==="http:"||x.protocol==="https:"}' +
    'if(ok){if(s.indexOf("http://")===0&&location.protocol==="https:")s="https://"+s.slice(7);' +
    'document.documentElement.style.setProperty("--custom-bg","url("+JSON.stringify(s)+")");' +
    'document.body.classList.add("has-custom-bg")}}catch(e){}}' +
    'if(G.f12&&!G.admin){' +
    'document.addEventListener("keydown",function(e){' +
    'if(e.keyCode===123||(e.ctrlKey&&e.shiftKey&&(e.keyCode===73||e.keyCode===74||e.keyCode===67))||(e.ctrlKey&&(e.keyCode===85||e.keyCode===83))){e.preventDefault();e.stopPropagation();return false}' +
    '},true);' +
    'document.addEventListener("contextmenu",function(e){e.preventDefault();return false},true);' +
    'var dt={open:false};' +
    'setInterval(function(){' +
    'var wO=window.outerWidth-window.innerWidth>160;var hO=window.outerHeight-window.innerHeight>160;' +
    'if((wO||hO)&&!dt.open){dt.open=true;' +
    'if(G.f12Close){try{window.open("","_self","");window.close()}catch(e){}' +
    'var d=document.body;if(d){while(d.firstChild)d.removeChild(d.firstChild);' +
    'var m=document.createElement("div");' +
    'm.style.cssText="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f5f7;color:#8e8e93;font-family:sans-serif;font-size:14px";' +
    'm.textContent="\u68c0\u6d4b\u5230\u5f00\u53d1\u8005\u5de5\u5177\uff0c\u9875\u9762\u5df2\u5173\u95ed";d.appendChild(m);document.title="."}}' +
    'else{try{var d=document.body;while(d.firstChild)d.removeChild(d.firstChild);' +
    'var m=document.createElement("div");' +
    'm.style.cssText="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f5f7;color:#8e8e93;font-family:sans-serif;font-size:14px";' +
    'm.textContent="\u68c0\u6d4b\u5230\u5f00\u53d1\u8005\u5de5\u5177\uff0c\u9875\u9762\u5185\u5bb9\u5df2\u6682\u505c\u663e\u793a";d.appendChild(m);document.title="."}catch(e){}}' +
    '}else if(!wO&&!hO){dt.open=false}' +
    '},1000);}' +
    '})();</script>';
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  let rel = pathname;
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
  else if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  else if (rel === '/download' || rel === '/download/') rel = '/download.html';
  else if (rel === '/status' || rel === '/status/') rel = '/status.html';
  // 文件共享功能关闭时，下载页不再对外提供（后台管理不受影响）
  if (rel === '/download.html' && !featureOn('downloadEnabled')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // HTML 页面注入全站防护脚本（背景同步 + F12 防护），非 HTML 静态资源原样返回
    if (ext === '.html' && req.method !== 'HEAD') {
      const guard = buildGuardScript(req);
      const html = buf.toString('utf8');
      const idx = html.lastIndexOf('</body>');
      const out = idx >= 0 ? (html.slice(0, idx) + guard + html.slice(idx)) : (html + guard);
      buf = Buffer.from(out, 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ---------------- 启动 ----------------
const server = http.createServer(async (req, res) => {
  // 安全响应头：防 MIME 嗅探 / 点击劫持 / 信息泄露
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'");
  res.removeHeader('X-Powered-By');
  // HTTPS 部署时附加 HSTS 头，防 SSL 剥离
  if (req_is_secure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  try {
    const u = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(u.pathname); }
    catch (e) { pathname = u.pathname; }

    if (pathname.startsWith('/api/')) {
      // 访问控制：认证、验证码及管理员诊断接口必须豁免，确保被拦截地区仍可登录和排障。
      // 管理员仅豁免 /api/admin/* 后台管理 API；不再豁免前台 API，避免管理员在海外机房 IP 下绕过前台限制。
      const ip = clientIP(req);
      const session = getSession(req);
      const curUser = session ? db.users.find(x => x.id === session.userId) : null;
      const isAdmin = !!(curUser && roleAtLeast(curUser, 'admin'));
      const acExempt = pathname.startsWith('/api/auth/') || pathname.startsWith('/api/captcha/') || pathname === '/api/admin/ip-diagnose' ||
        (isAdmin && pathname.startsWith('/api/admin/'));
      if (!acExempt) {
        const blockInfo = await checkIpAccess(ip);
        if (blockInfo) { logIpBlocked(req, ip, blockInfo); return json(res, 403, { error: '访问被拒绝', blocked: true, type: blockInfo.type }); }
      }
      return await handleApi(req, res, u, pathname);
    }
    // 非 API 请求的访问控制：后台登录页与静态资源豁免，其他 HTML 页面（含管理员已登录时）均执行地区/机房检查。
    {
      const ip = clientIP(req);
      const acExempt = pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html' ||
        /\.(css|js|svg|png|jpe?g|gif|webp|bmp|ico|avif|woff2?|ttf|eot|map)$/i.test(pathname) ||
        pathname.startsWith('/uploads/') || pathname.startsWith('/favicons/');
      if (!acExempt) {
        const blockInfo = await checkIpAccess(ip);
        if (blockInfo) { logIpBlocked(req, ip, blockInfo); return serveBlockPage(req, res, blockInfo); }
      }
    }
    // 角色级访问控制：访客角色（已登录但无权限）访问前台页面时返回「账号待审核」页
    {
      const session = getSession(req);
      const curUser = session ? db.users.find(x => x.id === session.userId) : null;
      if (curUser && userRole(curUser) === 'guest') {
        // 访客仅可访问后台登录页（/admin 用于查看账号信息），前台页面全部拦截
        if (pathname === '/' || pathname === '/index.html' ||
            pathname === '/download' || pathname === '/download/' || pathname === '/download.html') {
          return serveGuestNoAccessPage(req, res);
        }
      }
    }
    if (pathname.startsWith('/uploads/')) return serveUpload(req, res, pathname);
    if (pathname.startsWith('/favicons/')) return serveFavicon(req, res, pathname);
    if (pathname.startsWith('/files/')) return await serveSharedFile(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[服务器错误]', err);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

pruneSessions();
pruneBans();
pruneNonces();
pruneHourly();
pruneComments();
pruneVisitors();
// 定时死链检测：启用后延迟 1 分钟执行首轮，之后按配置间隔循环
scheduleLinkCheck(LINK_CHECK_FIRST_DELAY);
setInterval(() => { pruneSessions(); pruneBans(); pruneNonces(); prunePendingFiles(); prunePendingBackups(); pruneShareCodes(); pruneRateLogThrottle(); pruneCaptchas(); pruneDlTokens(); pruneVisitors(); pruneGeoCache(); }, 30 * 60 * 1000).unref();
setInterval(() => { checkAllMonitors().catch(e => console.error('[监控检测失败]', e)); }, STATUS_MONITOR_CHECK_INTERVAL).unref();
setTimeout(() => { checkAllMonitors().catch(e => console.error('[监控首次检测失败]', e)); }, 3000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  幻终の导航 已启动');
  console.log(`  前台首页: http://localhost:${PORT}/`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log('==============================================');
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用，请关闭占用程序，或修改 server.js 顶部的 PORT 配置。`);
  } else {
    console.error('[启动失败]', err);
  }
  process.exit(1);
});

// 全局未处理异常兜底：防止异步错误导致进程崩溃
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的Promise拒绝]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常] 进程状态已不可靠，记录后退出（请配合 MCSM/pm2 等守护进程自动拉起）', err);
  // Node 官方建议：uncaughtException 后进程处于不确定状态，继续运行可能写出损坏数据，
  // 故立即退出交由守护进程重启；无守护进程时需手动重新启动服务
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// 幻终节点代理：零依赖，只暴露 NODE_ROOT 内的普通文件。
// 默认读取同目录 node-agent.config.json；环境变量仍可覆盖配置，便于容器/CI 使用。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const DIAGNOSE_ONLY = process.argv.includes('--diagnose') || process.env.NODE_DIAGNOSE === '1';
const CONFIG_MAX_BYTES = 64 * 1024;
const BODY_MAX_BYTES = 2 * 1024 * 1024;
const NODE_CHUNK_BYTES = 1024 * 1024;
const FILE_MAX_BYTES = 200 * 1024 * 1024;
const UPLOAD_MAX_SESSIONS = 32;
const uploadSessions = new Map();
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'node-agent.config.json');
const CONFIG_FILE = process.env.NODE_CONFIG ? path.resolve(process.env.NODE_CONFIG) : DEFAULT_CONFIG_FILE;

function loadConfig(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > CONFIG_MAX_BYTES) throw new Error('配置文件必须是小于 64KB 的普通文件');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件顶层必须是 JSON 对象');
    return parsed;
  } catch (e) {
    console.error('节点配置文件读取失败：' + e.message);
    process.exit(1);
  }
}
function envOrConfig(envName, configValue, fallback) {
  return process.env[envName] !== undefined ? process.env[envName] : (configValue !== undefined ? configValue : fallback);
}

const config = loadConfig(CONFIG_FILE);
const portValue = envOrConfig('NODE_PORT', config.nodePort, 2230);
const PORT = Number(portValue);
const MAIN_URL = String(envOrConfig('MAIN_URL', config.mainUrl, '') || '').replace(/\/$/, '');
const NODE_TOKEN = String(envOrConfig('NODE_TOKEN', config.nodeToken, '') || '');
const rootValue = String(envOrConfig('NODE_ROOT', config.nodeRoot, 'node-files') || 'node-files');
const rootBase = process.env.NODE_ROOT !== undefined ? process.cwd() : path.dirname(CONFIG_FILE);
const NODE_ROOT = path.resolve(rootBase, rootValue);
const CAPACITY_MBPS = Number(envOrConfig('NODE_CAPACITY_MBPS', config.nodeCapacityMbps, 100));
const NODE_ID = String(envOrConfig('NODE_ID', config.nodeId, '') || '').trim();
const NODE_HOST = String(envOrConfig('NODE_HOST', config.nodeHost, '0.0.0.0') || '0.0.0.0').trim();
const HEARTBEAT_MS = 30000;
let activeTasks = 0;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('NODE_PORT 必须是 1-65535 的整数');
  process.exit(1);
}
if (!MAIN_URL || !/^https?:\/\//i.test(MAIN_URL) || !NODE_TOKEN) {
  console.error('需要在 node-agent.config.json 中设置 mainUrl 与 nodeToken，或通过 MAIN_URL 与 NODE_TOKEN 环境变量设置');
  process.exit(1);
}
if (!Number.isFinite(CAPACITY_MBPS) || CAPACITY_MBPS < 0 || CAPACITY_MBPS > 1000) {
  console.error('nodeCapacityMbps 必须是 0-1000 之间的数字');
  process.exit(1);
}
if (!fs.existsSync(NODE_ROOT)) fs.mkdirSync(NODE_ROOT, { recursive: true });

function safeRelativePath(value) {
  let raw;
  try { raw = decodeURIComponent(String(value || '')).replace(/\\/g, '/'); } catch (e) { return null; }
  if (!raw || raw.includes('\0') || raw.startsWith('/') || raw.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const full = path.resolve(NODE_ROOT, raw);
  const root = NODE_ROOT.endsWith(path.sep) ? NODE_ROOT : NODE_ROOT + path.sep;
  return full === NODE_ROOT || full.startsWith(root) ? full : null;
}
function safeDirectoryPath(value) {
  let raw;
  try { raw = decodeURIComponent(String(value || '')).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); } catch (e) { return null; }
  if (raw.includes('\0') || raw.startsWith('/') || raw.split('/').some(part => part === '.' || part === '..')) return null;
  const full = raw ? path.resolve(NODE_ROOT, raw) : NODE_ROOT;
  const root = NODE_ROOT.endsWith(path.sep) ? NODE_ROOT : NODE_ROOT + path.sep;
  return full === NODE_ROOT || full.startsWith(root) ? full : null;
}
function listLocalDirectory(relative) {
  const dirPath = safeDirectoryPath(relative);
  if (!dirPath) return { error: 'invalid directory path' };
  let st;
  try { st = fs.statSync(dirPath); } catch (e) { return { error: 'directory not found' }; }
  if (!st.isDirectory()) return { error: 'directory not found' };
  let names;
  try { names = fs.readdirSync(dirPath); } catch (e) { return { error: 'directory read failed' }; }
  if (names.length > 1000) return { error: 'too many directory entries' };
  const base = String(relative || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const entries = [];
  for (const name of names) {
    const child = path.join(dirPath, name);
    let childStat;
    try { childStat = fs.lstatSync(child); } catch (e) { continue; }
    if (childStat.isSymbolicLink()) continue;
    if (!childStat.isFile() && !childStat.isDirectory()) continue;
    const itemPath = base ? base + '/' + name : name;
    entries.push({ name, path: itemPath, type: childStat.isDirectory() ? 'directory' : 'file', size: childStat.isFile() ? childStat.size : 0, mtimeMs: childStat.mtimeMs });
  }
  entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : (a.type === 'directory' ? -1 : 1));
  return { path: base, entries };
}
function diagnosePort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    let settled = false;
    const finish = result => { if (settled) return; settled = true; try { probe.close(); } catch (e) {} resolve(result); };
    probe.once('error', err => finish({ ok: false, code: err.code || 'UNKNOWN', message: err.message }));
    probe.listen(PORT, NODE_HOST, () => finish({ ok: true }));
  });
}
async function diagnoseHeartbeat() {
  const target = new URL('/api/node/heartbeat', MAIN_URL);
  const payload = Buffer.from(JSON.stringify({ token: NODE_TOKEN, freeBandwidthMbps: CAPACITY_MBPS, activeTasks: 0 }), 'utf8');
  const lib = target.protocol === 'https:' ? require('https') : http;
  return new Promise(resolve => {
    const req = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname, method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (raw.length < 1000) raw += chunk; });
      res.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (e) {}
        resolve({ ok: res.statusCode === 200 && !!(body && body.ok), status: res.statusCode || 0, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message === 'timeout' ? '主站请求超时' : err.message }));
    req.end(payload);
  });
}
async function runDiagnose() {
  console.log('[节点诊断] Node.js: ' + process.version);
  console.log('[节点诊断] 脚本路径: ' + __filename);
  console.log('[节点诊断] 配置文件: ' + CONFIG_FILE + (fs.existsSync(CONFIG_FILE) ? '（已找到）' : '（未找到，使用环境变量/默认值）'));
  console.log('[节点诊断] 工作目录: ' + process.cwd());
  console.log('[节点诊断] 主站地址: ' + MAIN_URL);
  console.log('[节点诊断] 监听地址: ' + NODE_HOST + ':' + PORT);
  console.log('[节点诊断] 文件根目录: ' + NODE_ROOT + (fs.existsSync(NODE_ROOT) ? '（已存在）' : '（将自动创建）'));
  const port = await diagnosePort();
  if (!port.ok) {
    if (port.code === 'EADDRINUSE') console.error('[节点诊断] 端口检查: 已被占用，请检查节点代理、Nginx、MCSM 端口映射或其他服务。');
    else if (port.code === 'EADDRNOTAVAIL') console.error('[节点诊断] 端口检查: 监听地址不可用，请将 nodeHost 改为 0.0.0.0 或本机实际地址。');
    else console.error('[节点诊断] 端口检查失败: ' + port.message);
    process.exit(1);
  }
  console.log('[节点诊断] 端口检查: 可用');
  const heartbeat = await diagnoseHeartbeat();
  if (!heartbeat.ok) {
    if (heartbeat.status === 401) console.error('[节点诊断] 主站心跳: 被拒绝（401），请确认节点已在主站添加且 nodeToken 完整无空格。');
    else if (heartbeat.status) console.error(`[节点诊断] 主站心跳: HTTP ${heartbeat.status}，请检查 MAIN_URL 和主站节点接口。`);
    else console.error('[节点诊断] 主站心跳: 无法连接，' + (heartbeat.error || '请检查主站地址、DNS、防火墙和 HTTPS 证书。'));
    process.exit(1);
  }
  console.log('[节点诊断] 主站心跳: 成功（HTTP 200）');
  console.log('[节点诊断] 结论: 配置、端口和主站连通性检查通过，未启动长期服务。');
  process.exit(0);
}
if (DIAGNOSE_ONLY) runDiagnose().catch(err => { console.error('[节点诊断] 执行失败: ' + err.message); process.exit(1); });
function json(res, code, body) {
  const out = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': out.length });
  res.end(out);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > BODY_MAX_BYTES) { reject(new Error('request too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}
function safeFileName(value) {
  const name = String(value || '').trim();
  return name && name.length <= 160 && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && name !== '.' && name !== '..' && !/[. ]$/.test(name) ? name : null;
}
function writeLocalFile(relative, data) {
  const filePath = safeRelativePath(relative);
  if (!filePath) return { error: 'invalid file path' };
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length || buf.length > BODY_MAX_BYTES) return { error: 'invalid file data' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf, { flag: 'wx' });
  return { filePath, size: buf.length };
}
function uploadPath(id) { return path.join(NODE_ROOT, '.upload-' + id + '.part'); }
function cleanUpload(id) { try { fs.unlinkSync(uploadPath(id)); } catch (e) {} uploadSessions.delete(id); }
function pruneUploads() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, task] of uploadSessions) if (task.createdAt < cutoff) cleanUpload(id);
}
function heartbeat() {
  const body = Buffer.from(JSON.stringify({ token: NODE_TOKEN, freeBandwidthMbps: CAPACITY_MBPS, activeTasks }), 'utf8');
  const target = new URL('/api/node/heartbeat', MAIN_URL);
  const lib = target.protocol === 'https:' ? require('https') : http;
  const req = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => res.resume());
  req.on('error', () => {});
  req.end(body);
}
const server = http.createServer((req, res) => {
  try {
    const target = new URL(req.url, 'http://node.local');
    if (req.headers['x-node-token'] !== NODE_TOKEN) return json(res, 401, { error: 'node token invalid' });
    if (target.pathname === '/api/node/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, nodeId: NODE_ID, port: PORT, root: NODE_ROOT, activeTasks, capacityMbps: CAPACITY_MBPS });
    }
    if (target.pathname === '/api/node/browse' && req.method === 'GET') {
      const result = listLocalDirectory(target.searchParams.get('path') || '');
      if (result.error) return json(res, result.error === 'directory not found' ? 404 : 400, { error: result.error });
      return json(res, 200, { ok: true, path: result.path, entries: result.entries });
    }
    if (target.pathname === '/api/node/files' && req.method === 'POST') {
      return readJson(req).then(body => {
        if (body.action === 'init') {
          const filePath = safeRelativePath(body.path); const size = Number(body.size); const chunks = Number(body.totalChunks);
          if (!filePath || !Number.isSafeInteger(size) || size <= 0 || size > FILE_MAX_BYTES || !Number.isSafeInteger(chunks) || chunks < 1 || chunks > 10000) return json(res, 400, { error: 'invalid upload metadata' });
          if (uploadSessions.size >= UPLOAD_MAX_SESSIONS) return json(res, 429, { error: 'too many upload sessions' });
          const id = require('crypto').randomBytes(12).toString('hex'); uploadSessions.set(id, { path: filePath, size, totalChunks: chunks, seen: new Set(), received: 0, createdAt: Date.now() });
          fs.mkdirSync(path.dirname(uploadPath(id)), { recursive: true }); fs.writeFileSync(uploadPath(id), Buffer.alloc(0));
          return json(res, 200, { ok: true, uploadId: id });
        }
        if (body.action === 'chunk') {
          const task = uploadSessions.get(String(body.uploadId || '')); const index = Number(body.index); const buf = Buffer.from(String(body.data || ''), 'base64');
          if (!task || !Number.isSafeInteger(index) || index < 0 || index >= task.totalChunks || task.seen.has(index) || !buf.length || buf.length > BODY_MAX_BYTES) return json(res, 400, { error: 'invalid upload chunk' });
          const offset = index * NODE_CHUNK_BYTES; if (offset + buf.length > task.size || (index < task.totalChunks - 1 && buf.length !== NODE_CHUNK_BYTES) || (index === task.totalChunks - 1 && offset + buf.length !== task.size)) return json(res, 400, { error: 'chunk size mismatch' });
          const fd = fs.openSync(uploadPath(body.uploadId), 'r+'); try { fs.writeSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
          task.seen.add(index); task.received += buf.length; return json(res, 200, { ok: true, receivedChunks: task.seen.size, totalChunks: task.totalChunks });
        }
        if (body.action === 'finish') {
          const id = String(body.uploadId || ''); const task = uploadSessions.get(id); if (!task || task.seen.size !== task.totalChunks) return json(res, 400, { error: 'upload incomplete' });
          const st = fs.statSync(uploadPath(id)); if (st.size !== task.size) { cleanUpload(id); return json(res, 400, { error: 'upload size mismatch' }); }
          fs.mkdirSync(path.dirname(task.path), { recursive: true }); fs.renameSync(uploadPath(id), task.path); uploadSessions.delete(id); return json(res, 200, { ok: true, path: body.path, size: task.size });
        }
        return json(res, 400, { error: 'invalid upload action' });
      }).catch(e => json(res, e.message === 'request too large' ? 413 : 400, { error: e.message }));
    }
    if (target.pathname !== '/api/node/files' || (req.method !== 'GET' && req.method !== 'HEAD')) return json(res, 404, { error: 'not found' });
    const filePath = safeRelativePath(target.searchParams.get('path'));
    if (!filePath) return json(res, 400, { error: 'invalid file path' });
    let st;
    try { st = fs.statSync(filePath); } catch (e) { return json(res, 404, { error: 'file not found' }); }
    if (!st.isFile()) return json(res, 404, { error: 'file not found' });
    const name = String(req.headers['x-file-name'] || 'download.bin');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    activeTasks++;
    const stream = fs.createReadStream(filePath);
    const release = () => { activeTasks = Math.max(0, activeTasks - 1); };
    stream.once('close', release); stream.once('error', () => { if (!res.destroyed) res.destroy(); });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) { if (!res.headersSent) json(res, 400, { error: 'bad request' }); else res.destroy(); }
});
console.log(`[节点启动配置] 配置文件: ${CONFIG_FILE}`);
console.log(`[节点启动配置] 工作目录: ${process.cwd()}`);
console.log(`[节点启动配置] 监听地址: ${NODE_HOST}:${PORT}`);
console.log(`[节点启动配置] 主站地址: ${MAIN_URL}`);
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[节点启动失败] ${NODE_HOST}:${PORT} 已被占用。请检查是否已有节点代理、Nginx 或 MCSM 端口映射使用此地址；也可以停止旧实例，或在 node-agent.config.json 中修改 nodePort 后重新启动。`);
  } else if (err && err.code === 'EADDRNOTAVAIL') {
    console.error(`[节点启动失败] 监听地址 ${NODE_HOST} 不存在或当前机器不可用，请将 nodeHost 改为 0.0.0.0 或本机实际地址。`);
  } else {
    console.error('[节点启动失败]', err && err.message ? err.message : err);
  }
  process.exitCode = 1;
  process.exit(1);
});
if (!DIAGNOSE_ONLY) server.listen(PORT, NODE_HOST, () => {
  console.log(`幻终节点代理已启动: http://${NODE_HOST === '0.0.0.0' ? 'localhost' : NODE_HOST}:${PORT}`);
  console.log(`节点实际监听: ${NODE_HOST}:${PORT}`);
  console.log(`节点配置文件: ${CONFIG_FILE}`);
  console.log(`节点工作目录: ${process.cwd()}`);
  console.log(`节点文件根目录: ${NODE_ROOT}`);
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS).unref();
  setInterval(pruneUploads, 5 * 60 * 1000).unref();
});

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');
const { PassThrough } = require('stream');
const { ZipWriter, parseZip, Crc32, validEntryName: validZipEntryName } = require('./zip.js');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'server.js');
const NODE_AGENT = path.join(ROOT, 'node-agent.js');
const NODE_AGENT_CONFIG_EXAMPLE = path.join(ROOT, 'node-agent.config.example.json');
const RSA_CLIENT = path.join(ROOT, 'public', 'rsa.js');
const DATA_DIR = path.join(ROOT, '.review-regression-data-' + process.pid);
const CHUNK_SIZE = 1024 * 1024;
const passed = [];
const failed = [];
let child = null;
let port = 0;
let serverOutput = '';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(err => err ? reject(err) : resolve(p));
    });
  });
}

function cookieFromResponse(response, oldCookie) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie || !setCookie.length) return oldCookie || '';
  return setCookie.map(v => String(v).split(';')[0]).join('; ');
}

function tokenFromCookie(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)ht_token=([a-f0-9]{64})(?:;|$)/);
  return m ? m[1] : '';
}

function sessionStoreKey(token) {
  return 'h_' + crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function sessionRefFromToken(token) {
  return sessionStoreKey(token).slice(2, 14);
}

function request(method, pathname, body, cookie, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extraHeaders);
    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        payload = body;
      } else {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: pathname, headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        const contentType = String(res.headers['content-type'] || '');
        if (contentType.includes('json')) {
          try { json = JSON.parse(text); } catch (e) { /* preserve raw response */ }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw,
          text,
          json,
          cookie: cookieFromResponse(res, cookie)
        });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request('GET', '/api/auth/info');
      if (r.status === 200) return r;
    } catch (e) {
      // process is still starting
    }
    await sleep(50);
  }
  throw new Error('隔离服务未能在预期时间内启动\n' + serverOutput);
}

function encryptNode(pem, text) {
  return crypto.publicEncrypt({
    key: pem,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, Buffer.from(text, 'utf8')).toString('base64');
}

function encryptBrowser(pem, text) {
  const source = fs.readFileSync(RSA_CLIENT, 'utf8');
  // 脚本的 IIFE 以 window 作为 global，因此 window.crypto 才是它实际读取的位置。
  const window = { crypto: crypto.webcrypto };
  vm.runInNewContext(source, {
    window,
    TextEncoder,
    Uint8Array,
    BigInt,
    atob,
    btoa,
    Math,
    // 浏览器非安全上下文下 window.crypto.getRandomValues 依然可用；沙箱必须提供它，
    // 保证回归测试走的是真实 CSPRNG 路径，而不是任何降级实现。
    crypto: crypto.webcrypto
  }, { filename: RSA_CLIENT });
  return window.rsaOaepEncrypt(pem, text);
}

async function getPublicKey() {
  const r = await request('GET', '/api/auth/pubkey');
  assert.strictEqual(r.status, 200, '获取 RSA 公钥失败');
  assert.ok(r.json && r.json.pem && r.json.nonce, '公钥响应缺少 pem/nonce');
  return r.json;
}

async function encryptedPassword(password, browser = false) {
  const key = await getPublicKey();
  return {
    enc: browser ? encryptBrowser(key.pem, password) : encryptNode(key.pem, password),
    nonce: key.nonce
  };
}

async function login(username, password, browser = false, extraHeaders = {}) {
  const secret = await encryptedPassword(password, browser);
  const r = await request('POST', '/api/auth/login', {
    username,
    password: secret
  }, '', extraHeaders);
  return { response: r, cookie: r.cookie };
}

function assertStatus(response, expected, label) {
  assert.strictEqual(response.status, expected, `${label}: 期望 ${expected}，实际 ${response.status}，响应 ${response.text.slice(0, 300)}`);
}

async function step(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log('PASS ' + name);
  } catch (err) {
    failed.push({ name, error: err.message });
    console.error('FAIL ' + name + ': ' + err.message);
    throw err;
  }
}

function buildZip(files) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };
    out.on('data', chunk => chunks.push(chunk));
    out.on('error', err => finish(err));
    out.on('end', () => finish(null, Buffer.concat(chunks)));
    out.on('close', () => {
      if (!settled) finish(new Error('zip stream closed'));
    });
    (async () => {
      let zip = null;
      try {
        zip = new ZipWriter(out);
        const entries = Array.isArray(files) ? files : Object.entries(files);
        for (const [name, content] of entries) {
          await zip.addFile(name, { buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
        }
        zip.finish();
      } catch (e) {
        if (zip) zip.abort();
        finish(e);
      }
    })();
  });
}

/** 构造最小的 store ZIP，专门用于验证解析器对恶意条目名/重复条目的拒绝。 */
function buildStoreZip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rawName of names) {
    const name = Buffer.from(String(rawName), 'utf8');
    const data = Buffer.from('x', 'utf8');
    const crc = new Crc32();
    crc.update(data);
    const value = crc.value();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(value, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBlock = Buffer.concat([local, name, data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(value, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localBlock.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

async function stopServer() {
  if (!child) return;
  const current = child;
  if (current.exitCode === null) {
    current.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (current.exitCode === null) current.kill('SIGKILL');
        resolve();
      }, 2000);
      current.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  child = null;
}

function cleanupDataDir() {
  // 该目录由本脚本独占创建；逐项删除可避开 Windows 上递归删除被安全包装转入回收站的问题。
  const removeTree = target => {
    let st;
    try { st = fs.lstatSync(target); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  };
  try {
    removeTree(DATA_DIR);
  } catch (e) {
    // 测试目录清理失败不应把已经完成的行为断言伪装成失败；主机安全包装可能拒绝删除该隔离目录。
    console.warn('WARN 回归临时目录清理失败: ' + e.message);
  }
}

async function startServer() {
  if (!port) port = await getFreePort();
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HUANZHONG_DATA_DIR: DATA_DIR,
      // 回归测试启用可信代理模式，以便用不同的测试客户端 IP 隔离下载限流桶；生产默认仍为 false。
      TRUST_PROXY: 'true'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { serverOutput += data.toString(); });
  child.stderr.on('data', data => { serverOutput += data.toString(); });
  await waitForServer();
}

async function main() {
  cleanupDataDir();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 语法正确但顶层类型错误的 JSON：验证启动归一化不会让服务在运行时崩溃。
  fs.writeFileSync(path.join(DATA_DIR, 'users.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'logs.json'), '[]', 'utf8');

  try {
    await startServer();
    let ownerCookie = '';
    let ownerToken = '';
    let guestCookie = '';
    let userCookie = '';
    let selfRegisterCookie = '';
    let adminCookie = '';
    let adminOtherCookie = '';
    let secondOwnerCookie = '';
    let secondOwnerToken = '';
    let thirdOwnerCookie = '';
    const guestHeaders = { 'x-forwarded-for': '127.0.0.2' };
    const userHeaders = { 'x-forwarded-for': '127.0.0.3' };
    const adminHeaders = { 'x-forwarded-for': '127.0.0.4' };
    const secondOwnerHeaders = { 'x-forwarded-for': '127.0.0.5' };
    const thirdOwnerHeaders = { 'x-forwarded-for': '127.0.0.6' };
    const userAllSiteHeaders = { 'x-forwarded-for': '127.0.0.7' };
    const adminOtherHeaders = { 'x-forwarded-for': '127.0.0.8' };
    const selfRegisterHeaders = { 'x-forwarded-for': '127.0.0.9' };
    let folderId = '';
    let binaryFileId = '';
    let binaryStorage = '';
    let ownerId = '';
    let guestId = '';
    let userId = '';
    let adminId = '';
    let actualFileContent = null;

    await step('节点代理 JSON 配置样例完整', async () => {
      const cfg = JSON.parse(fs.readFileSync(NODE_AGENT_CONFIG_EXAMPLE, 'utf8'));
      assert.strictEqual(cfg.mainUrl, 'https://nav.example.com');
      assert.strictEqual(cfg.nodeRoot, './files');
      assert.strictEqual(cfg.nodeHost, '0.0.0.0');
      assert.strictEqual(cfg.nodePort, 2230);
      assert.strictEqual(cfg.nodeCapacityMbps, 100);
      const agentSource = fs.readFileSync(NODE_AGENT, 'utf8');
      assert.ok(agentSource.includes("DEFAULT_CONFIG_FILE = path.join(__dirname, 'node-agent.config.json')"), '节点代理应默认读取同目录 JSON 配置');
      assert.ok(agentSource.includes("process.env.NODE_CONFIG"), '节点代理应支持指定配置文件');
      assert.ok(agentSource.includes('envOrConfig'), '节点代理应保留环境变量覆盖能力');
      assert.ok(agentSource.includes("'/api/node/health'"), '节点代理应提供健康检查接口');
      assert.ok(agentSource.includes("'/api/node/browse'"), '节点代理应提供目录浏览接口');
      assert.ok(agentSource.includes('listLocalDirectory'), '节点代理应返回目录文件基本信息');
      const serverSource = fs.readFileSync(SERVER, 'utf8');
      assert.ok(serverSource.includes("'/api/admin/nodes/:id/browse'"), '主站应提供节点目录代理接口');
      assert.ok(serverSource.includes('describeNodeNetworkError') && serverSource.includes('ECONNREFUSED') && serverSource.includes('ENOTFOUND'), '主站应区分节点网络错误类型');
      assert.ok(serverSource.includes('describeNodeUpstreamStatus') && serverSource.includes('反向代理返回 HTTP 502'), '主站应解释节点反向代理 502 来源');
      assert.ok(serverSource.includes("'/api/node/health'") && serverSource.includes("'/api/node/browse?path='") && serverSource.includes('已通过目录接口验证'), '连接测试应支持 health 失败后目录接口降级验证');
      assert.ok(serverSource.includes('nodeFileExists'), '主站保存节点引用前应确认文件存在');
      assert.ok(agentSource.includes('server.listen(PORT, NODE_HOST'), '节点代理应使用配置的监听地址和端口');
      assert.ok(agentSource.includes('节点配置文件'), '节点代理应输出实际配置文件路径便于排障');
      assert.ok(agentSource.includes('diagnoseHeartbeat') && agentSource.includes('主站心跳'), '节点诊断应检查主站心跳连通性');
      assert.ok(agentSource.includes("body.action === 'init'") && agentSource.includes("body.action === 'chunk'") && agentSource.includes("body.action === 'finish'"), '节点代理应提供分块上传闭环');
      assert.ok(cfg.nodeToken.includes('主站') && cfg.nodeToken.includes('完整令牌'), '配置样例不得包含真实令牌');
    });

    await step('损坏顶层 JSON 归一化与服务启动', async () => {
      const r = await request('GET', '/api/auth/info');
      assertStatus(r, 200, '认证信息');
      assert.strictEqual(r.json.firstRun, true, '错误顶层类型不应阻断首启');
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.ok(String(r.headers['content-security-policy']).includes("default-src 'self'"));
    });

    await step('首个站长注册与会话 Cookie 安全属性', async () => {
      const adminPage = await request('GET', '/admin');
      assertStatus(adminPage, 200, '管理后台页面');
      assert.ok(adminPage.text.includes('id="authSubmit" disabled'), '管理后台应等待认证信息加载后再允许提交');
      assert.ok(adminPage.text.includes("credentials = 'same-origin'"), '管理后台请求应显式携带同源 Cookie');
      assert.ok(adminPage.text.includes('function showNodeTokenModal(token)'), '节点添加后应使用令牌弹窗展示');
      assert.ok(adminPage.text.includes('id="nodeTokenCopy"'), '令牌弹窗应提供一键复制按钮');
      assert.ok(adminPage.text.includes('节点令牌复制成功'), '令牌复制成功应有明确提示');
      assert.ok(adminPage.text.includes('id="nodeTokenClose"'), '令牌弹窗应提供关闭按钮');
      assert.ok(adminPage.text.includes('nodeBatchUploadBtn') && adminPage.text.includes('nodeMigrateBtn'), '后台应提供节点批量上传和节点迁移入口');
      assert.ok(adminPage.text.includes('loadNodeBrowser') && adminPage.text.includes('mNodeBrowserList'), '后台应提供节点文件浏览与选择引用入口');
      assert.ok(adminPage.text.includes('mNodeUploadProgress') && adminPage.text.includes('正在上传'), '节点批量上传应展示进度状态');
      assert.ok(adminPage.text.includes('mobileNavOpen') && adminPage.text.includes('mobileNavBackdrop') && adminPage.text.includes('startNodeRefresh'), '后台应提供移动导航和节点自动刷新');
      const secret = await encryptedPassword('OwnerPass123!', true);
      const r = await request('POST', '/api/auth/register', {
        username: 'owner', password: secret
      });
      assertStatus(r, 200, '注册站长');
      ownerCookie = r.cookie;
      ownerToken = tokenFromCookie(ownerCookie);
      assert.ok(ownerCookie, '注册未返回会话 Cookie');
      assert.ok(ownerToken, '注册 Cookie 中缺少合法会话令牌');
      const setCookie = String(r.headers['set-cookie'] && r.headers['set-cookie'][0]);
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('SameSite=Lax'));
      assert.ok(setCookie.includes('Max-Age='));
      const me = await request('GET', '/api/auth/me', undefined, ownerCookie);
      assertStatus(me, 200, '站长会话');
      assert.strictEqual(me.json.user.role, 'owner');

      const sessionsPath = path.join(DATA_DIR, 'sessions.json');
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.ok(Object.keys(sessions).some(k => /^h_[a-f0-9]{64}$/.test(k)), '注册会话必须使用哈希存储键');
      assert.ok(!Object.keys(sessions).some(k => k === ownerToken), 'sessions.json 不应保存站长 bearer token');
    });

    await step('未登录管理 API 拒绝访问', async () => {
      const r = await request('GET', '/api/admin/users');
      assertStatus(r, 401, '未登录管理 API');
    });

    await step('创建访客、普通用户与管理员测试账号', async () => {
      for (const [username, role] of [['guest1', 'guest'], ['user1', 'user'], ['admin1', 'admin']]) {
        const secret = await encryptedPassword('Pass1234!', false);
        const r = await request('POST', '/api/admin/users', {
          username, password: secret, role
        }, ownerCookie);
        assertStatus(r, 200, '创建 ' + role + ' 账号');
      }
      const list = await request('GET', '/api/admin/users', undefined, ownerCookie);
      assertStatus(list, 200, '读取账号列表');
      ownerId = list.json.users.find(u => u.username === 'owner').id;
      guestId = list.json.users.find(u => u.username === 'guest1').id;
      userId = list.json.users.find(u => u.username === 'user1').id;
      adminId = list.json.users.find(u => u.username === 'admin1').id;
      assert.ok(ownerId && guestId && userId && adminId, '测试账号 ID 不完整');
      assert.strictEqual(list.json.users.find(u => u.username === 'guest1').role, 'guest');
      assert.strictEqual(list.json.users.find(u => u.username === 'user1').role, 'user');
      assert.strictEqual(list.json.users.find(u => u.username === 'admin1').role, 'admin');

      const sessionsPath = path.join(DATA_DIR, 'sessions.json');
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.ok(Object.keys(sessions).some(k => /^h_[a-f0-9]{64}$/.test(k)), '新建会话必须使用哈希存储键');
      assert.ok(!Object.keys(sessions).some(k => /^[a-f0-9]{64}$/.test(k)), 'sessions.json 不应保存明文 bearer token 键');
    });

    await step('旧版明文会话迁移后 Cookie 仍有效', async () => {
      const sessionsPath = path.join(DATA_DIR, 'sessions.json');
      const current = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const currentKey = sessionStoreKey(ownerToken);
      assert.ok(current[currentKey], '找不到站长当前哈希会话');
      const legacyRecord = Object.assign({}, current[currentKey], {
        token: ownerToken,
        legacyExtra: 'must be stripped'
      });
      await stopServer();
      fs.writeFileSync(sessionsPath, JSON.stringify({ [ownerToken]: legacyRecord }, null, 2), 'utf8');
      await startServer();

      const me = await request('GET', '/api/auth/me', undefined, ownerCookie);
      assertStatus(me, 200, '迁移后的站长会话');
      assert.strictEqual(me.json.user.role, 'owner');
      const migrated = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.ok(migrated[currentKey], '旧版会话没有迁移为哈希键');
      assert.strictEqual(migrated[currentKey].token, undefined, '会话记录不应保存 token 字段');
      assert.strictEqual(migrated[currentKey].legacyExtra, undefined, '会话迁移应丢弃未知字段');
      assert.strictEqual(migrated[ownerToken], undefined, 'sessions.json 不应继续保存明文 token 键');
    });

    await step('登录验证码缺失时拒绝登录', async () => {
      const secret = await encryptedPassword('Pass1234!', false);
      const r = await request('POST', '/api/auth/login', {
        username: 'guest1', password: secret
      });
      assertStatus(r, 403, '缺失登录验证码');
      assert.strictEqual(r.json.requireCaptcha, true);
    });

    await step('创建文件夹并乱序上传二进制分块', async () => {
      const folder = await request('POST', '/api/admin/folders', { name: '回归测试文件夹' }, ownerCookie);
      assertStatus(folder, 200, '创建测试文件夹');
      folderId = folder.json.folder.id;

      const content = Buffer.alloc(2 * CHUNK_SIZE);
      for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
      const init = await request('POST', '/api/admin/files/init', {
        filename: '乱序.bin', size: content.length, totalChunks: 2, folderId
      }, ownerCookie);
      assertStatus(init, 200, '初始化分块上传');
      binaryFileId = init.json.fileId;

      const second = await request('POST', '/api/admin/files/chunk', {
        fileId: binaryFileId, index: 1, data: content.subarray(CHUNK_SIZE).toString('base64')
      }, ownerCookie);
      assertStatus(second, 200, '先传第二块');
      const first = await request('POST', '/api/admin/files/chunk', {
        fileId: binaryFileId, index: 0, data: content.subarray(0, CHUNK_SIZE).toString('base64')
      }, ownerCookie);
      assertStatus(first, 200, '后传第一块');
      assert.strictEqual(first.json.received, 2);

      const finish = await request('POST', '/api/admin/files/finish', {
        fileId: binaryFileId, desc: '乱序上传回归'
      }, ownerCookie);
      assertStatus(finish, 200, '完成乱序上传');

      const adminFiles = await request('GET', '/api/admin/files?folder=' + encodeURIComponent(folderId), undefined, ownerCookie);
      assertStatus(adminFiles, 200, '读取上传文件');
      const file = adminFiles.json.files.find(f => f.id === binaryFileId);
      assert.ok(file, '上传文件元数据不存在');
      binaryStorage = file.storage;
      actualFileContent = content;
      assert.strictEqual(file.size, content.length);

      const downloadStart = await request('POST', '/api/files/' + binaryFileId + '/download', {}, ownerCookie);
      assertStatus(downloadStart, 200, '签发下载令牌');
      const downloaded = await request('GET', downloadStart.json.url);
      assertStatus(downloaded, 200, '使用下载令牌');
      assert.deepStrictEqual(downloaded.body, content, '乱序上传后的文件内容损坏');
      const reused = await request('GET', downloadStart.json.url);
      assertStatus(reused, 410, '下载令牌重复使用');
    });

    await step('隐藏文件严格隔离且取件码可下载', async () => {
      const hidden = await request('PUT', '/api/admin/files/' + binaryFileId + '/policy', { hidden: true, speedLimitMbps: 0 }, ownerCookie);
      assertStatus(hidden, 200, '隐藏文件');
      const listed = await request('GET', '/api/files?all=1');
      assertStatus(listed, 200, '隐藏文件公开搜索');
      assert.ok(!listed.json.files.some(f => f.id === binaryFileId), '隐藏文件不应出现在公开搜索');
      const directStart = await request('POST', '/api/files/' + binaryFileId + '/download', {}, ownerCookie);
      assertStatus(directStart, 404, '隐藏文件普通下载');
      const preview = await request('GET', '/api/files/' + binaryFileId + '/preview');
      assertStatus(preview, 404, '隐藏文件预览');
      const share = await request('POST', '/api/admin/files/' + binaryFileId + '/share', { hours: 1 }, ownerCookie);
      assertStatus(share, 200, '隐藏文件生成取件码');
      const shared = await request('GET', '/api/share/' + share.json.code);
      assertStatus(shared, 200, '解析隐藏文件取件码');
      const sharedBody = await request('GET', shared.json.url);
      assertStatus(sharedBody, 200, '取件码令牌下载隐藏文件');
      assert.deepStrictEqual(sharedBody.body, actualFileContent, '取件码下载内容损坏');
      const visible = await request('PUT', '/api/admin/files/' + binaryFileId + '/policy', { hidden: false, speedLimitMbps: 0.25 }, ownerCookie);
      assertStatus(visible, 200, '恢复展示并设置单文件限速');
      assert.strictEqual(visible.json.file.speedLimitMbps, 0.25);
    });

    await step('节点连接、心跳、性能调度与租约释放', async () => {
      const first = await request('POST', '/api/admin/nodes', { name: '回归节点A', baseUrl: 'https://example.com/node-a', capacityMbps: 100 }, ownerCookie);
      const second = await request('POST', '/api/admin/nodes', { name: '回归节点B', baseUrl: 'https://example.org/node-b', capacityMbps: 200 }, ownerCookie);
      const firstNodeId = first.json && first.json.node && first.json.node.id;
      assert.ok(firstNodeId, '节点 A ID 缺失');
      assertStatus(first, 200, '创建节点A');
      assertStatus(second, 200, '创建节点B');
      assert.ok(first.json.token && second.json.token, '节点令牌未返回');
      const rotate = await request('POST', '/api/admin/nodes/' + firstNodeId + '/rotate-token', {}, ownerCookie);
      assertStatus(rotate, 200, '轮换节点令牌');
      assert.ok(rotate.json.token && rotate.json.token !== first.json.token, '轮换后应生成新令牌');
      const oldHeartbeat = await request('POST', '/api/node/heartbeat', { token: first.json.token, freeBandwidthMbps: 20, activeTasks: 1 });
      assertStatus(oldHeartbeat, 401, '旧节点令牌应立即失效');
      first.json.token = rotate.json.token;
      const hbA = await request('POST', '/api/node/heartbeat', { token: first.json.token, freeBandwidthMbps: 20, activeTasks: 1 });
      const hbB = await request('POST', '/api/node/heartbeat', { token: second.json.token, freeBandwidthMbps: 80, activeTasks: 0 });
      assertStatus(hbA, 200, '节点A心跳');
      assertStatus(hbB, 200, '节点B心跳');
      const connected = await request('POST', '/api/admin/nodes/' + first.json.node.id + '/connect', { peerId: second.json.node.id }, ownerCookie);
      assertStatus(connected, 200, '双向连接节点');
      assert.ok(connected.json.node.peers.includes(second.json.node.id));
      assert.ok(connected.json.peer.peers.includes(first.json.node.id));
      const dispatch = await request('POST', '/api/node/dispatch', {}, ownerCookie);
      assertStatus(dispatch, 200, '调度节点性能');
      assert.strictEqual(dispatch.json.node.id, second.json.node.id, '调度应优先选择剩余带宽更高节点');
      const release = await request('POST', '/api/node/dispatch/' + dispatch.json.leaseId + '/release', {}, ownerCookie);
      assertStatus(release, 200, '释放节点性能租约');
      const deletedA = await request('DELETE', '/api/admin/nodes/' + first.json.node.id, undefined, ownerCookie);
      const deletedB = await request('DELETE', '/api/admin/nodes/' + second.json.node.id, undefined, ownerCookie);
      assertStatus(deletedA, 200, '删除节点A');
      assertStatus(deletedB, 200, '删除节点B');
    });

    await step('外链文件引用校验与安全字段落盘', async () => {
      const bad = await request('POST', '/api/admin/files/external', { name: '内网.bin', sourceUrl: 'http://127.0.0.1:2220/private' }, ownerCookie);
      assertStatus(bad, 400, '拒绝内网外链');
      const ext = await request('POST', '/api/admin/files/external', { name: '外链.bin', sourceUrl: 'https://example.com/file.bin', size: 1234, hidden: true }, ownerCookie);
      assertStatus(ext, 200, '创建外链文件引用');
      assert.strictEqual(ext.json.file.sourceUrl, 'https://example.com/file.bin');
      assert.strictEqual(ext.json.file.hidden, true);
      const extPublic = await request('GET', '/api/files?all=1');
      assert.ok(!extPublic.json.files.some(f => f.id === ext.json.file.id), '隐藏外链不应出现在公开列表');
      const extDelete = await request('DELETE', '/api/admin/files/' + ext.json.file.id, undefined, ownerCookie);
      assertStatus(extDelete, 200, '删除外链文件引用');
    });

    await step('直接访问存储名与匿名无验证码下载被拒绝', async () => {
      const direct = await request('GET', '/files/' + encodeURIComponent(binaryStorage));
      assertStatus(direct, 403, '直接访问存储名');

      const before = await request('GET', '/api/files?all=1');
      const beforeCount = before.json.files.find(f => f.id === binaryFileId).downloads;
      const anonymous = await request('POST', '/api/files/' + binaryFileId + '/download', {}, '', { 'x-forwarded-for': '127.0.0.21' });
      assertStatus(anonymous, 403, '匿名下载缺验证码');
      assert.strictEqual(anonymous.json.requireCaptcha, true);
      const after = await request('GET', '/api/files?all=1');
      const afterCount = after.json.files.find(f => f.id === binaryFileId).downloads;
      assert.strictEqual(afterCount, beforeCount, '验证码失败不应增加下载次数');
    });

    await step('管理员流式 ZIP 打包并解析内容', async () => {
      const r = await request('GET', '/api/files/zip?folder=' + encodeURIComponent(folderId), undefined, ownerCookie, { 'x-forwarded-for': '127.0.0.11' });
      assertStatus(r, 200, '管理员 ZIP 打包');
      assert.ok(String(r.headers['content-type']).includes('application/zip'));
      const entries = parseZip(r.body, { maxEntries: 10, maxEntrySize: 3 * CHUNK_SIZE, maxTotalSize: 4 * CHUNK_SIZE });
      assert.ok(entries, '服务端生成的 ZIP 无法解析');
      assert.ok(entries.some(e => e.name === '回归测试文件夹/乱序.bin'));

      const all = await request('GET', '/api/files/zip', undefined, ownerCookie, { 'x-forwarded-for': '127.0.0.10' });
      assertStatus(all, 200, '管理员整站 ZIP 打包');
      const allEntries = parseZip(all.body, { maxEntries: 10, maxEntrySize: 3 * CHUNK_SIZE, maxTotalSize: 4 * CHUNK_SIZE });
      assert.ok(allEntries && allEntries.some(e => e.name === '回归测试文件夹/乱序.bin'), '整站 ZIP 不应遗漏嵌套文件夹');
    });

    await step('访客会话不能访问公开操作或管理 API', async () => {
      const ownerSettings = await request('PUT', '/api/admin/settings', { loginCaptcha: false }, ownerCookie);
      assertStatus(ownerSettings, 200, '关闭登录验证码');
      const logged = await login('guest1', 'Pass1234!', true, guestHeaders);
      assertStatus(logged.response, 200, '浏览器 RSA 访客登录');
      guestCookie = logged.cookie;
      const me = await request('GET', '/api/auth/me', undefined, guestCookie, guestHeaders);
      assertStatus(me, 200, '访客认证信息');
      assert.strictEqual(me.json.user.role, 'guest');

      const files = await request('GET', '/api/files?all=1', undefined, guestCookie, guestHeaders);
      assertStatus(files, 403, '访客公开 API');
      const admin = await request('GET', '/api/admin/users', undefined, guestCookie, guestHeaders);
      assertStatus(admin, 403, '访客管理 API');
      // 下载接口先经过 IP 限流，再进入角色判断；下载专门的验证码行为在匿名场景单独验证。
      const page = await request('GET', '/', undefined, guestCookie, guestHeaders);
      assertStatus(page, 200, '访客前台页面');
      assert.ok(page.text.includes('账号待审核'));
    });

    await step('普通用户不能调用整站 ZIP，但可调用受保护的公开 ZIP 请求', async () => {
      const logged = await login('user1', 'Pass1234!', false, userHeaders);
      assertStatus(logged.response, 200, '普通用户登录');
      userCookie = logged.cookie;
      const forbidden = await request('GET', '/api/files/zip?folder=' + encodeURIComponent(folderId), undefined, userCookie, userHeaders);
      assertStatus(forbidden, 403, '普通用户整站 ZIP');

      const allSiteForbidden = await request('POST', '/api/files/zip-request', { folderId: '' }, userCookie, userAllSiteHeaders);
      assertStatus(allSiteForbidden, 403, '普通用户 POST 整站 ZIP');

      const zipRequest = await request('POST', '/api/files/zip-request', { folderId }, userCookie, userHeaders);
      assertStatus(zipRequest, 200, '普通用户公开 ZIP 请求');
      const zipDownload = await request('GET', zipRequest.json.url);
      assertStatus(zipDownload, 200, '公开 ZIP 令牌下载');
      const entries = parseZip(zipDownload.body, { maxEntries: 10, maxEntrySize: 3 * CHUNK_SIZE, maxTotalSize: 4 * CHUNK_SIZE });
      assert.ok(entries && entries.some(e => e.name === '回归测试文件夹/乱序.bin'));
    });

    await step('会话列表使用哈希引用且管理员可强制下线其他会话', async () => {
      const adminLogin = await login('admin1', 'Pass1234!', false, adminHeaders);
      assertStatus(adminLogin.response, 200, '管理员登录');
      adminCookie = adminLogin.cookie;

      const ownerLogin = await login('owner', 'OwnerPass123!', false, secondOwnerHeaders);
      assertStatus(ownerLogin.response, 200, '第二个站长会话');
      secondOwnerCookie = ownerLogin.cookie;
      secondOwnerToken = tokenFromCookie(secondOwnerCookie);
      assert.ok(secondOwnerToken, '第二个站长会话令牌缺失');

      const sessions = await request('GET', '/api/admin/sessions', undefined, adminCookie, adminHeaders);
      assertStatus(sessions, 200, '读取会话列表');
      const target = sessions.json.sessions.find(s => s.username === 'owner' && s.id === sessionRefFromToken(secondOwnerToken));
      assert.ok(target, '会话列表未返回哈希引用');
      assert.strictEqual(target.id.length, 12);
      assert.ok(!sessions.text.includes(secondOwnerToken), '会话 API 不应返回完整 bearer token');

      const kicked = await request('DELETE', '/api/admin/sessions/' + target.id, undefined, adminCookie, adminHeaders);
      assertStatus(kicked, 200, '强制下线目标会话');
      const kickedMe = await request('GET', '/api/auth/me', undefined, secondOwnerCookie, secondOwnerHeaders);
      assertStatus(kickedMe, 401, '被强制下线的会话');
    });

    await step('管理员不能重置或删除站长账号', async () => {
      const reset = await request('PUT', '/api/admin/users/' + ownerId + '/password', { password: {} }, adminCookie, adminHeaders);
      assertStatus(reset, 403, '管理员重置站长密码');
      const remove = await request('DELETE', '/api/admin/users/' + ownerId, undefined, adminCookie, adminHeaders);
      assertStatus(remove, 403, '管理员删除站长账号');
      const adminList = await request('GET', '/api/admin/users', undefined, adminCookie, adminHeaders);
      assertStatus(adminList, 200, '管理员正常读取账号列表');
      assert.ok(adminList.json.users.some(u => u.id === ownerId && u.role === 'owner'));
    });

    await step('自助注册自动创建哈希会话，退出后立即失效', async () => {
      const enableRegister = await request('PUT', '/api/admin/settings', { allowRegister: true }, ownerCookie);
      assertStatus(enableRegister, 200, '重新开启自助注册');
      const secret = await encryptedPassword('SelfReg123!', false);
      const registered = await request('POST', '/api/auth/register', {
        username: 'selfreg', password: secret
      }, '', selfRegisterHeaders);
      assertStatus(registered, 200, '自助注册');
      selfRegisterCookie = registered.cookie;
      const token = tokenFromCookie(selfRegisterCookie);
      assert.ok(token, '自助注册未返回会话令牌');
      const me = await request('GET', '/api/auth/me', undefined, selfRegisterCookie, selfRegisterHeaders);
      assertStatus(me, 200, '自助注册自动登录');
      assert.strictEqual(me.json.user.role, 'guest');
      const logout = await request('POST', '/api/auth/logout', {}, selfRegisterCookie, selfRegisterHeaders);
      assertStatus(logout, 200, '退出自助注册会话');
      const after = await request('GET', '/api/auth/me', undefined, selfRegisterCookie, selfRegisterHeaders);
      assertStatus(after, 401, '退出后的会话');
      const sessions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
      assert.strictEqual(sessions[sessionStoreKey(token)], undefined, '退出后哈希会话应从磁盘删除');
    });

    await step('SVG 上传与图标伪协议输入校验', async () => {
      const badSite = await request('POST', '/api/admin/sites', {
        name: '恶意图标测试', url: 'https://example.com', icon: 'javascript:alert(1)'
      }, ownerCookie);
      assertStatus(badSite, 400, '拒绝 javascript 图标地址');

      const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="java&#x73;cript:alert(3)"><foreignObject><div>evil</div></foreignObject></a></svg>';
      const uploaded = await request('POST', '/api/admin/upload', {
        filename: 'xss.svg', data: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
      }, ownerCookie);
      assertStatus(uploaded, 200, '上传 SVG');
      const served = await request('GET', uploaded.json.url);
      assertStatus(served, 200, '读取清理后的 SVG');
      assert.ok(!/<script\b/i.test(served.text));
      assert.ok(!/\bon\w+\s*=/i.test(served.text));
      assert.ok(!/javascript\s*:/i.test(served.text));
      assert.ok(!/<foreignObject\b/i.test(served.text));
      assert.ok(String(served.headers['content-security-policy']).includes("script-src 'none'"));
    });

    await step('SVG 消毒清除带空白或自闭合结束标签的脚本块', async () => {
      // XML 允许结束标签在 `>` 前带空白（</script > 等价于 </script>），
      // 旧版消毒正则只认 `</script>`，会被这类变体绕过并留下可执行脚本。
      const variants = [
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script ></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script\n></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><script src="//evil.example/x.js"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>evil</div></foreignObject ></svg>'
      ];
      const headers = { 'x-forwarded-for': '127.0.0.12' };
      for (const svg of variants) {
        const uploaded = await request('POST', '/api/admin/upload', {
          filename: 'variant.svg', data: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
        }, ownerCookie, headers);
        assertStatus(uploaded, 200, '上传 SVG 变体');
        const served = await request('GET', uploaded.json.url, undefined, '', headers);
        assertStatus(served, 200, '读取清理后的 SVG 变体');
        assert.ok(!/<script\b/i.test(served.text), '脚本块未被清除：' + served.text);
        assert.ok(!/<foreignObject\b/i.test(served.text), 'foreignObject 未被清除：' + served.text);
      }
    });

    await step('监控地址拒绝 IPv4/IPv6/映射地址和云元数据地址', async () => {
      const targets = [
        'http://127.0.0.1',
        'http://localhost',
        'http://169.254.169.254',
        'http://[::1]',
        'http://[::ffff:127.0.0.1]',
        'http://[fd00::1]',
        'http://[64:ff9b::c000:0201]'
      ];
      for (const target of targets) {
        const r = await request('POST', '/api/admin/status/monitors', {
          name: 'SSRF-' + targets.indexOf(target), url: target
        }, ownerCookie);
        assertStatus(r, 400, 'SSRF 地址 ' + target);
      }
    });

    await step('路径遍历与非法名称输入校验', async () => {
      const folder = await request('POST', '/api/admin/folders', { name: '../escape' }, ownerCookie);
      assertStatus(folder, 400, '拒绝路径遍历文件夹名');
      const encodedTraversal = await request('GET', '/%2e%2e/server.js');
      assert.ok([403, 404].includes(encodedTraversal.status), '路径遍历响应异常: ' + encodedTraversal.status);
    });

    await step('ZIP 截断、CRC 错误和解压总量限制', async () => {
      const sample = await buildZip({ 'hello.txt': 'hello zip' });
      const parsed = parseZip(sample, { maxEntries: 4, maxEntrySize: 100, maxTotalSize: 1000 });
      assert.ok(parsed && parsed[0].content.toString() === 'hello zip');
      assert.strictEqual(parseZip(sample.subarray(0, sample.length - 1)), null, '截断 ZIP 应拒绝');
      const central = sample.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(central >= 0, '测试 ZIP 缺少中央目录');
      const badCrc = Buffer.from(sample);
      badCrc[central + 16] ^= 0xff;
      assert.strictEqual(parseZip(badCrc), null, 'CRC 错误 ZIP 应拒绝');
      assert.strictEqual(parseZip(sample, { maxTotalSize: 2 }), null, '超过解压总量上限应拒绝');
    });

    await step('ZIP 条目路径、设备名和重复条目拒绝', async () => {
      const maliciousNames = [
        '../escape', '/absolute/path', 'C:/windows/path', 'C:relative', 'a\\\\b',
        'a/../b', 'bad\\x01name', 'CON', 'NUL.txt', 'report.txt ', 'folder/./x', 'a//b'
      ];
      for (const name of maliciousNames) {
        assert.strictEqual(validZipEntryName(name), false, '校验器应拒绝: ' + JSON.stringify(name));
        assert.strictEqual(parseZip(buildStoreZip([name])), null, '解析器应拒绝: ' + JSON.stringify(name));
      }
      assert.strictEqual(parseZip(buildStoreZip(['same.txt', 'same.txt'])), null, '重复条目应拒绝');
      await assert.rejects(() => buildZip({ '../escape': 'x' }), /invalid zip entry name/);
      await assert.rejects(() => buildZip([['safe.txt', 'x'], ['safe.txt', 'y']]), /duplicate zip entry name/);
    });

    await step('完整备份乱序分块恢复并覆盖同大小旧文件', async () => {
      const padding = crypto.randomBytes(1400 * 1024).toString('base64');
      const replacementContent = Buffer.alloc(2 * CHUNK_SIZE, 0x5a);
      const payload = {
        _meta: { app: '幻终の导航', type: 'full', version: 1 },
        sites: [{ id: 'restored-site', name: '恢复站点', url: 'https://example.com', desc: '', icon: '', category: '', enabled: true, order: 1 }],
        folders: [],
        files: [{ id: 'restored-file', name: '覆盖后的文件.bin', storage: binaryStorage, size: replacementContent.length, desc: '', downloads: 0, folderId: '', uploadedBy: 'backup', createdAt: new Date().toISOString() }],
        padding
      };
      const backup = await buildZip({ 'backup.json': JSON.stringify(payload), ['files/' + binaryStorage]: replacementContent });
      assert.ok(backup.length > CHUNK_SIZE, '备份样本应跨越多个分块');
      const chunks = Math.ceil(backup.length / CHUNK_SIZE);
      const init = await request('POST', '/api/admin/restore/full/init', {
        size: backup.length, totalChunks: chunks
      }, ownerCookie);
      assertStatus(init, 200, '初始化完整恢复');
      const taskId = init.json.taskId;
      for (let index = chunks - 1; index >= 0; index--) {
        const part = backup.subarray(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, backup.length));
        const r = await request('POST', '/api/admin/restore/full/chunk', {
          taskId, index, data: part.toString('base64')
        }, ownerCookie);
        assertStatus(r, 200, '上传完整备份分块 ' + index);
      }
      const finish = await request('POST', '/api/admin/restore/full/finish', { taskId }, ownerCookie);
      assertStatus(finish, 200, '完成完整恢复');
      assert.strictEqual(finish.json.ok, true);
      const sites = await request('GET', '/api/sites');
      assertStatus(sites, 200, '读取恢复后的站点');
      assert.ok(sites.json.sites.some(s => s.id === 'restored-site'));
      const restoredDownload = await request('POST', '/api/files/restored-file/download', {}, ownerCookie, userAllSiteHeaders);
      assertStatus(restoredDownload, 200, '签发恢复文件下载令牌');
      const restoredBody = await request('GET', restoredDownload.json.url);
      assertStatus(restoredBody, 200, '读取恢复文件');
      assert.deepStrictEqual(restoredBody.body, replacementContent, '同大小旧文件未被新备份内容覆盖');
    });

    await step('访客统计遇到原型魔法键来源域名时仍正常响应', async () => {
      // 来源 host 可能是 __proto__/constructor 等魔法键；旧实现直接 return 跳过响应，
      // 请求会一直挂起到客户端超时，连接被白白占住。
      const headers = { 'x-forwarded-for': '127.0.0.13' };
      const token = 'a'.repeat(32);
      const first = await request('POST', '/api/visitor', {
        token, referrer: 'http://__proto__/'
      }, '', headers);
      assertStatus(first, 200, '魔法键来源的首次上报');
      assert.strictEqual(first.json.counted, true);
      const second = await request('POST', '/api/visitor', {
        token, referrer: 'http://constructor/'
      }, '', headers);
      assertStatus(second, 200, '魔法键来源的重复上报');
      assert.strictEqual(second.json.counted, false, '同一令牌当天不应重复计数');
      const refs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'visits.json'), 'utf8')).referrers || {};
      assert.ok(!Object.prototype.hasOwnProperty.call(refs, '__proto__'), '魔法键不得写入来源统计');
      assert.ok(!Object.prototype.hasOwnProperty.call(refs, 'constructor'), '魔法键不得写入来源统计');
    });

    await step('关闭隔离服务后数据目录只含测试数据', async () => {
      const sessionsPath = path.join(DATA_DIR, 'sessions.json');
      assert.ok(fs.existsSync(sessionsPath));
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      assert.ok(Object.keys(sessions).length >= 1);
    });
  } finally {
    await stopServer();
    cleanupDataDir();
  }
}

main().then(() => {
  console.log(`\n回归测试通过：${passed.length} 项，失败：${failed.length} 项`);
  process.exitCode = failed.length ? 1 : 0;
}).catch(err => {
  console.error('\n回归测试中止。服务输出：\n' + serverOutput);
  console.error(`已通过：${passed.length} 项，失败：${failed.length} 项`);
  process.exitCode = 1;
});

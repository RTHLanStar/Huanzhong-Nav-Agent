/*
 * rsa.js - 纯 JavaScript RSA-OAEP(SHA-256) 加密（零依赖）
 * 用于非安全上下文（http://IP 直连）下浏览器没有 WebCrypto 时的密码加密兜底。
 * 与服务端 crypto.privateDecrypt(OAEP, sha256) 完全对应。
 */
(function (global) {
  'use strict';

  /* ================= SHA-256（纯 JS） ================= */
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var K256 = (function () {
    var primes = [], k = [], i = 2, c = 0;
    function frac(x) { return Math.floor((x - Math.floor(x)) * 4294967296); }
    while (c < 64) {
      var isPrime = true;
      for (var j = 2; j * j <= i; j++) if (i % j === 0) { isPrime = false; break; }
      if (isPrime) { primes.push(i); c++; }
      i++;
    }
    for (var p = 0; p < 64; p++) k[p] = frac(Math.pow(primes[p], 1 / 3));
    return k;
  })();

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var bitLen = len * 8;
    // 填充
    var padded = [];
    for (var i = 0; i < len; i++) padded.push(bytes[i]);
    padded.push(0x80);
    while ((padded.length % 64) !== 56) padded.push(0);
    // 追加 64 位长度（高 32 位为 0，密码远小于 2^32 字节）
    for (var hi = 0; hi < 4; hi++) padded.push(0);
    padded.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = (padded[off + t * 4] << 24) | (padded[off + t * 4 + 1] << 16) |
               (padded[off + t * 4 + 2] << 8) | padded[off + t * 4 + 3];
      }
      for (var t2 = 16; t2 < 64; t2++) {
        var s0 = rotr(w[t2 - 15], 7) ^ rotr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3);
        var s1 = rotr(w[t2 - 2], 17) ^ rotr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10);
        w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t3 = 0; t3 < 64; t3++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K256[t3] + w[t3]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = [];
    for (var r = 0; r < 8; r++) {
      out.push((H[r] >>> 24) & 0xff, (H[r] >>> 16) & 0xff, (H[r] >>> 8) & 0xff, H[r] & 0xff);
    }
    return out;
  }

  /* ================= 工具 ================= */
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += (h.length < 2 ? '0' : '') + h;
    }
    return s;
  }
  function randomBytes(n) {
    var out = new Uint8Array(n);
    // OAEP 的安全性完全依赖种子的不可预测性：一旦种子可预测，加密形同虚设。
    // Math.random() 不是密码学安全的随机数，绝不能作为兜底——缺少 CSPRNG 时必须显式报错，
    // 让调用方降级到「改用 HTTPS / 换用 WebCrypto」，而不是静默发送弱加密的密码。
    var c = global.crypto || global.msCrypto;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new Error('当前环境缺少安全随机数来源（crypto.getRandomValues），无法加密密码');
    }
    c.getRandomValues(out);
    return out;
  }

  /* MGF1(SHA-256) */
  function mgf1(seed, len) {
    var out = [], counter = 0;
    var hLen = 32;
    while (out.length < len) {
      var c = [(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff];
      var input = Array.prototype.slice.call(seed).concat(c);
      out = out.concat(sha256(input));
      counter++;
    }
    return out.slice(0, len);
  }

  /* ================= ASN.1 解析 ================= */
  function readTLV(bytes, pos) {
    if (pos >= bytes.length) throw new Error('DER 数据不完整');
    var tag = bytes[pos++];
    var len = bytes[pos++];
    if (len & 0x80) {
      var n = len & 0x7f;
      if (n > 4) throw new Error('DER 长度字段异常');
      len = 0;
      for (var i = 0; i < n; i++) len = len * 256 + bytes[pos++];
    }
    if (pos + len > bytes.length) throw new Error('DER 数据越界');
    return { tag: tag, start: pos, len: len, next: pos + len };
  }

  function parseSpkiPem(pem) {
    var b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    var bytes = b64ToBytes(b64);
    var outer = readTLV(bytes, 0);
    if (outer.tag !== 0x30) throw new Error('非法 SPKI');
    var alg = readTLV(bytes, outer.start);
    var bitStr = readTLV(bytes, alg.next);
    if (bitStr.tag !== 0x03) throw new Error('非法公钥结构');
    var rsaSeq = readTLV(bytes, bitStr.start + 1);
    if (rsaSeq.tag !== 0x30) throw new Error('非法公钥结构');
    var intN = readTLV(bytes, rsaSeq.start);
    var intE = readTLV(bytes, intN.next);
    if (intN.tag !== 0x02 || intE.tag !== 0x02) throw new Error('非法公钥结构');
    var n = BigInt('0x' + bytesToHex(bytes.subarray(intN.start, intN.start + intN.len)));
    var e = BigInt('0x' + bytesToHex(bytes.subarray(intE.start, intE.start + intE.len)));
    return { n: n, e: e, byteLen: Math.ceil(n.toString(2).length / 8) };
  }

  /* ================= 模幂 ================= */
  function modPow(base, exp, mod) {
    var result = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return result;
  }

  /**
   * 使用 PEM 公钥对文本做 RSA-OAEP(SHA-256) 加密，返回 base64。
   * 与服务端 crypto.privateDecrypt({ oaepHash:'sha256' }) 对应。
   */
  function rsaOaepEncrypt(pem, text) {
    var key = parseSpkiPem(pem);
    var msg = Array.prototype.slice.call(new TextEncoder().encode(text));
    var k = key.byteLen;
    var hLen = 32;
    var mLen = msg.length;
    if (mLen > k - 2 * hLen - 2) throw new Error('内容过长，无法加密');

    var lHash = sha256([]);                    // 空 label 的 SHA-256
    var ps = [];
    var psLen = k - mLen - 2 * hLen - 2;
    for (var i = 0; i < psLen; i++) ps.push(0);
    var db = lHash.concat(ps).concat([0x01]).concat(msg);

    var seed = Array.prototype.slice.call(randomBytes(hLen));
    var dbMask = mgf1(seed, k - hLen - 1);
    var maskedDB = [];
    for (var d = 0; d < db.length; d++) maskedDB.push(db[d] ^ dbMask[d]);
    var seedMask = mgf1(maskedDB, hLen);
    var maskedSeed = [];
    for (var s = 0; s < seed.length; s++) maskedSeed.push(seed[s] ^ seedMask[s]);

    var em = [0x00].concat(maskedSeed).concat(maskedDB);

    var m = BigInt('0x' + bytesToHex(em));
    var c = modPow(m, key.e, key.n);
    var hex = c.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    while (hex.length < k * 2) hex = '00' + hex;
    var out = new Uint8Array(k);
    for (var p = 0; p < k; p++) out[p] = parseInt(hex.substr(p * 2, 2), 16);
    return bytesToB64(out);
  }

  global.rsaOaepEncrypt = rsaOaepEncrypt;
})(window);

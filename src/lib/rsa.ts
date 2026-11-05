/** 浏览器端 RSA-OAEP(SHA-256) 加密，与 server.js 的 decryptSecret 协议保持一致。 */

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const bytes = base64ToBytes(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface PublicKeyPayload {
  pem: string;
  nonce: string;
}

export interface EncryptedSecret {
  enc: string;
  nonce: string;
}

export async function encryptSecret(plain: string, key: PublicKeyPayload): Promise<EncryptedSecret> {
  if (!key || !key.pem || !key.nonce) throw new Error('安全校验信息缺失，请刷新页面后重试');
  const cryptoKey = await window.crypto.subtle.importKey(
    'spki',
    pemToDer(key.pem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const cipher = await window.crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    cryptoKey,
    new TextEncoder().encode(plain),
  );
  return { enc: bytesToBase64(cipher), nonce: key.nonce };
}

/** 获取一次性公钥与令牌后加密密码；每次提交都必须重新获取，令牌仅可使用一次。 */
export async function encryptPassword(password: string): Promise<EncryptedSecret> {
  const response = await fetch('/api/auth/pubkey', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('获取加密公钥失败，请刷新页面后重试');
  const payload = (await response.json()) as PublicKeyPayload;
  return encryptSecret(password, payload);
}

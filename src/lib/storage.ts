export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储已满或被禁用时静默失败，不阻塞交互 */
  }
}

export function loadString(key: string, fallback = ''): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function downloadBlob(filename: string, content: BlobPart, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 400);
}

/** 生成 32 位十六进制匿名访客令牌（与服务端校验规则一致）。 */
export function visitorToken(): string {
  const key = 'ht_visitor_token';
  const existing = loadString(key);
  if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  let token = '';
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i += 1) token += bytes[i].toString(16).padStart(2, '0');
  } catch {
    for (let i = 0; i < 32; i += 1) token += Math.floor(Math.random() * 16).toString(16);
  }
  saveString(key, token);
  return token;
}

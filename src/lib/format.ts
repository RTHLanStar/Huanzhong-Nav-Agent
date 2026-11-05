export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatNumber(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('zh-CN');
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatRelative(iso?: string): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

export function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Math.max(0, Number(value));
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

export function formatInterval(seconds: number | null | undefined): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60) return `${Math.round(n)} 秒`;
  if (n < 3600) return `${Math.round(n / 60)} 分钟`;
  return `${(n / 3600).toFixed(n % 3600 ? 1 : 0)} 小时`;
}

/** 仅允许 http/https，防御历史脏数据中的伪协议。 */
export function safeUrl(url: string | undefined): string {
  if (!url) return '#';
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch {
    /* fallthrough */
  }
  return '#';
}

/** HTTPS 页面下把 http 图片升级为 https，避免混合内容拦截。 */
export function safeImage(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('http://') && window.location.protocol === 'https:') return `https://${url.slice(7)}`;
  return url;
}

export function formatShortDate(date: string): string {
  const parts = String(date || '').split('-');
  return parts.length === 3 ? `${Number(parts[1])}月${Number(parts[2])}日` : date;
}

export function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

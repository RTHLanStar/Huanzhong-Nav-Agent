import { createTheme, type MantineColorsTuple } from '@mantine/core';

const DEFAULT_ACCENT = '#007aff';

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return null;
  const value = match[1];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function mix(rgb: [number, number, number], target: [number, number, number], ratio: number): string {
  const r = clamp255(rgb[0] + (target[0] - rgb[0]) * ratio);
  const g = clamp255(rgb[1] + (target[1] - rgb[1]) * ratio);
  const b = clamp255(rgb[2] + (target[2] - rgb[2]) * ratio);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** 由单一主题色生成 Mantine 需要的 10 级色板。 */
export function buildPalette(accent: string): MantineColorsTuple {
  const rgb = hexToRgb(accent) || hexToRgb(DEFAULT_ACCENT)!;
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  return [
    mix(rgb, white, 0.92),
    mix(rgb, white, 0.82),
    mix(rgb, white, 0.66),
    mix(rgb, white, 0.44),
    mix(rgb, white, 0.2),
    `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`,
    mix(rgb, black, 0.12),
    mix(rgb, black, 0.26),
    mix(rgb, black, 0.42),
    mix(rgb, black, 0.58),
  ] as unknown as MantineColorsTuple;
}

export function normalizeAccent(value?: string): string {
  return hexToRgb(value || '') ? String(value).toLowerCase() : DEFAULT_ACCENT;
}

export function createAppTheme(accent: string) {
  return createTheme({
    primaryColor: 'brand',
    primaryShade: { light: 5, dark: 4 },
    colors: { brand: buildPalette(accent) },
    defaultRadius: 'lg',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    headings: {
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontWeight: '700',
    },
    components: {
      Paper: { defaultProps: { radius: 'lg' } },
      Button: { defaultProps: { radius: 'xl' } },
      TextInput: { defaultProps: { radius: 'xl' } },
      Textarea: { defaultProps: { radius: 'lg' } },
      Modal: { defaultProps: { radius: 'lg', centered: true } },
    },
  });
}

/** 将主题色同步到 CSS 变量，供自定义样式与全站背景使用。 */
export function applyAccentCss(accent: string) {
  const rgb = hexToRgb(accent);
  if (!rgb) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.14)`);
}

export function applyBackgroundCss(url?: string) {
  const root = document.documentElement;
  if (!url) {
    root.style.removeProperty('--custom-bg');
    document.body.classList.remove('has-custom-bg');
    return;
  }
  let valid = false;
  try {
    if (url.startsWith('/uploads/')) valid = /^\/uploads\/[\w.-]+$/.test(url);
    else {
      const parsed = new URL(url);
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
  } catch {
    valid = false;
  }
  if (!valid) return;
  const src = url.startsWith('http://') && window.location.protocol === 'https:' ? `https://${url.slice(7)}` : url;
  root.style.setProperty('--custom-bg', `url("${src.replace(/"/g, '\\"')}")`);
  document.body.classList.add('has-custom-bg');
}

export function applyFavicon(logo?: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (logo && (/^\/uploads\/[\w.-]+$/.test(logo) || /^https:\/\//i.test(logo))) {
    link.href = logo;
    link.type = 'image/png';
    return;
  }
  link.href =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" rx="20" fill="%231d1d1f"/%3E%3Ctext x="32" y="43" text-anchor="middle" font-size="34" font-family="Arial,sans-serif" font-weight="700" fill="white"%3E%E5%B9%BB%3C/text%3E%3C/svg%3E';
  link.type = 'image/svg+xml';
}

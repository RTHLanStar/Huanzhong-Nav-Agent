import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/notifications/styles.css';
import { api } from '../lib/api';
import { applyAccentCss, applyBackgroundCss, applyFavicon, createAppTheme, normalizeAccent } from '../lib/theme';
import { loadString, saveString } from '../lib/storage';
import type { SiteInfo, UserRole } from '../lib/types';

export type ColorScheme = 'light' | 'dark';

interface AppContextValue {
  info: SiteInfo | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  colorScheme: ColorScheme;
  toggleColorScheme: () => void;
  accent: string;
}

const AppContext = createContext<AppContextValue | null>(null);

const DEFAULT_FEATURES: SiteInfo['features'] = {
  announcements: true,
  qqGroups: true,
  comments: true,
  feedback: true,
  countdown: true,
  friendlinks: true,
  popular: true,
  visitorStats: true,
  lucky: true,
  recent: true,
  download: true,
  shareCodes: true,
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProviders 内使用');
  return ctx;
}

/** 角色等级判断：访客 < 用户 < 管理员 < 站长。 */
export function roleAtLeast(role: UserRole | null | undefined, min: UserRole): boolean {
  const order: UserRole[] = ['guest', 'user', 'admin', 'owner'];
  if (!role) return false;
  return order.indexOf(role) >= order.indexOf(min);
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => {
    const stored = loadString('ht_theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const reload = useCallback(async () => {
    try {
      const data = await api<SiteInfo>('/api/auth/info');
      setInfo({
        ...data,
        features: { ...DEFAULT_FEATURES, ...(data.features || {}) },
        limits: {
          commentMaxLen: Number(data.limits?.commentMaxLen) || 200,
          feedbackMaxLen: Number(data.limits?.feedbackMaxLen) || 300,
        },
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载站点信息失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const accent = normalizeAccent(info?.accentColor);

  useEffect(() => {
    if (!info) return;
    document.title = info.siteName || '幻终の导航';
    applyAccentCss(accent);
    applyBackgroundCss(info.background);
    applyFavicon(info.logo);
  }, [info, accent]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorScheme);
    document.documentElement.style.colorScheme = colorScheme;
  }, [colorScheme]);

  const toggleColorScheme = useCallback(() => {
    setColorScheme((current) => {
      const next: ColorScheme = current === 'dark' ? 'light' : 'dark';
      saveString('ht_theme', next);
      return next;
    });
  }, []);

  const theme = useMemo(() => createAppTheme(accent), [accent]);
  const value = useMemo<AppContextValue>(
    () => ({ info, loading, error, reload, colorScheme, toggleColorScheme, accent }),
    [info, loading, error, reload, colorScheme, toggleColorScheme, accent],
  );

  return (
    <AppContext.Provider value={value}>
      <MantineProvider theme={theme} forceColorScheme={colorScheme}>
        <Notifications position="top-center" limit={3} />
        {children}
      </MantineProvider>
    </AppContext.Provider>
  );
}

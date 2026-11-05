import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronRight,
  IconCloud,
  IconDice5,
  IconDownload,
  IconFolderOff,
  IconMessage,
  IconMessageDots,
  IconMoon,
  IconSearch,
  IconSettings,
  IconSpeakerphone,
  IconStar,
  IconStarFilled,
  IconSun,
  IconUsers,
} from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatNumber, safeImage, safeUrl } from '../../lib/format';
import { loadJson, loadString, saveJson, saveString, downloadBlob, visitorToken } from '../../lib/storage';
import { useApp } from '../../components/AppProviders';
import type { Announcement, Countdown, FriendLink, QqGroup, Site, WeatherInfo } from '../../lib/types';
import {
  AnnouncementsModal,
  CommentsModal,
  FeedbackModal,
  PrefsModal,
  QqModal,
} from './HomeModals';
import { ENGINES, PREF_DEFAULTS, type HomeModal, type PopularItem, type Prefs, type RecentItem } from './homeTypes';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function SiteIcon({ site }: { site: Site }) {
  const [failed, setFailed] = useState(false);
  const src = safeImage(site.icon);
  if (!src || failed) return <>{site.name.trim().charAt(0).toUpperCase() || '?'}</>;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function greetingForHour(hour: number): string {
  if (hour < 6) return '夜深了，注意休息';
  if (hour < 9) return '早上好，开启新的一天';
  if (hour < 12) return '上午好，元气满满';
  if (hour < 14) return '中午好，记得吃饭';
  if (hour < 18) return '下午好，继续加油';
  if (hour < 22) return '晚上好，放松一下';
  return '夜深了，早点休息';
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default function HomePage() {
  const { info, colorScheme, toggleColorScheme } = useApp();
  const features = info?.features;

  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [favs, setFavs] = useState<string[]>(() => {
    const value = loadJson<string[]>('ht_favs', []);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  });
  const [recent, setRecent] = useState<RecentItem[]>(() => {
    const value = loadJson<RecentItem[]>('ht_recent', []);
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string').slice(0, 8) : [];
  });
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const stored = loadJson<Partial<Prefs>>('ht_prefs', {});
    return { ...PREF_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  });
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    const value = loadJson<string[]>('ht_custom_order', []);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  });
  const [engineId, setEngineId] = useState(() => {
    const stored = loadString('ht_engine', 'bing');
    return ENGINES.some((engine) => engine.id === stored) ? stored : 'bing';
  });
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    const value = loadJson<string[]>('ht_search_history', []);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 10) : [];
  });

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [qqGroups, setQqGroups] = useState<QqGroup[]>([]);
  const [countdowns, setCountdowns] = useState<Countdown[]>([]);
  const [popular, setPopular] = useState<PopularItem[]>([]);
  const [friendlinks, setFriendlinks] = useState<FriendLink[]>([]);
  const [quote, setQuote] = useState('');
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [fileSummary, setFileSummary] = useState<{ count: number; downloads: number } | null>(null);

  const [clock, setClock] = useState(() => new Date());
  const [modal, setModal] = useState<HomeModal>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragIdRef = useRef('');
  const justDraggedRef = useRef(false);
  const iconRequestedRef = useRef<Set<string>>(new Set());

  /* ---------------- 时钟 ---------------- */
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /* ---------------- 站点数据 ---------------- */
  useEffect(() => {
    let cancelled = false;
    api<{ sites: Site[] }>('/api/sites')
      .then((data) => {
        if (cancelled) return;
        setSites(Array.isArray(data.sites) ? data.sites : []);
      })
      .catch(() => {
        if (!cancelled) notifications.show({ message: '引导页加载失败，请刷新重试', color: 'red' });
      })
      .finally(() => {
        if (!cancelled) setSitesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* 无图标的站点按需向服务端请求抓取结果（并发 4，避免瞬间打满接口） */
  useEffect(() => {
    const missing = sites.filter((site) => !site.icon && !iconRequestedRef.current.has(site.id));
    if (!missing.length) return;
    let cursor = 0;
    let active = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && cursor < missing.length) {
        const site = missing[cursor];
        cursor += 1;
        iconRequestedRef.current.add(site.id);
        active += 1;
        try {
          const data = await api<{ icon?: string }>(`/api/sites/${encodeURIComponent(site.id)}/icon`);
          if (!stopped && data.icon) {
            setSites((current) => current.map((item) => (item.id === site.id ? { ...item, icon: data.icon } : item)));
          }
        } catch {
          /* 抓取失败时保留首字母占位 */
        } finally {
          active -= 1;
        }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      stopped = true;
      void active;
    };
  }, [sites]);

  /* ---------------- 功能数据 ---------------- */
  useEffect(() => {
    if (!info) return;
    let cancelled = false;

    if (features?.announcements) {
      api<{ announcements: Announcement[] }>('/api/announcements')
        .then((data) => {
          if (!cancelled) setAnnouncements(data.announcements || []);
        })
        .catch(() => undefined);
    }
    if (features?.qqGroups) {
      api<{ groups: QqGroup[] }>('/api/qqgroups')
        .then((data) => {
          if (!cancelled) setQqGroups(data.groups || []);
        })
        .catch(() => undefined);
    }
    if (features?.countdown) {
      api<{ countdowns: Countdown[] }>('/api/countdowns')
        .then((data) => {
          if (!cancelled) setCountdowns(data.countdowns || []);
        })
        .catch(() => undefined);
    }
    if (features?.popular) {
      api<{ popular: PopularItem[] }>('/api/popular')
        .then((data) => {
          if (!cancelled) setPopular(data.popular || []);
        })
        .catch(() => undefined);
    }
    if (features?.friendlinks) {
      api<{ links: FriendLink[] }>('/api/friendlinks')
        .then((data) => {
          if (!cancelled) setFriendlinks(data.links || []);
        })
        .catch(() => undefined);
    }
    if (info.quoteEnabled) {
      api<{ enabled: boolean; text?: string }>('/api/quote')
        .then((data) => {
          if (!cancelled && data.enabled && data.text) setQuote(data.text);
        })
        .catch(() => undefined);
    }
    if (features?.download) {
      api<{ files: { downloads: number }[] }>('/api/files?all=1')
        .then((data) => {
          if (cancelled) return;
          const files = data.files || [];
          setFileSummary({ count: files.length, downloads: files.reduce((sum, file) => sum + (file.downloads || 0), 0) });
        })
        .catch(() => undefined);
    }
    if (features?.visitorStats) {
      api('/api/visitor', {
        method: 'POST',
        body: { token: visitorToken(), referrer: document.referrer || '' },
      }).catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [info, features]);

  /* ---------------- 天气 ---------------- */
  useEffect(() => {
    if (!info?.weatherEnabled) return;
    let cancelled = false;
    const fetchWeather = async (loc = '') => {
      try {
        const data = await api<WeatherInfo>(`/api/weather${loc}`);
        if (!cancelled && data.enabled) setWeather(data);
      } catch {
        if (!cancelled) setWeather({ enabled: true, error: '天气暂不可用' });
      }
    };
    let settled = false;
    if (navigator.geolocation) {
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          void fetchWeather();
        }
      }, 5200);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          void fetchWeather(
            `?lat=${position.coords.latitude.toFixed(2)}&lon=${position.coords.longitude.toFixed(2)}`,
          );
        },
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          void fetchWeather();
        },
        { timeout: 5000 },
      );
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    void fetchWeather();
    return () => {
      cancelled = true;
    };
  }, [info?.weatherEnabled]);

  /* ---------------- 本地偏好应用 ---------------- */
  useEffect(() => {
    document.body.setAttribute('data-layout', prefs.layout);
    document.body.setAttribute('data-font', prefs.font);
    document.body.setAttribute('data-motion', prefs.motion);
    document.body.setAttribute('data-radius', prefs.radius);
  }, [prefs]);

  useEffect(() => {
    saveJson('ht_favs', favs);
  }, [favs]);

  useEffect(() => {
    saveJson('ht_recent', recent);
  }, [recent]);

  useEffect(() => {
    saveJson('ht_prefs', prefs);
  }, [prefs]);

  useEffect(() => {
    saveJson('ht_custom_order', customOrder);
  }, [customOrder]);

  useEffect(() => {
    saveJson('ht_search_history', searchHistory);
  }, [searchHistory]);

  useEffect(() => {
    saveString('ht_engine', engineId);
  }, [engineId]);

  /* ---------------- 快捷操作 ---------------- */
  const recordRecent = useCallback(
    (site: Site) => {
      if (features?.recent === false) return;
      setRecent((current) => {
        const next = current.filter((item) => item.id !== site.id);
        next.unshift({ id: site.id, name: site.name, url: site.url, icon: site.icon || '' });
        return next.slice(0, 8);
      });
    },
    [features?.recent],
  );

  const trackVisit = useCallback((site: Site) => {
    api('/api/visit', { method: 'POST', body: { id: site.id } }).catch(() => undefined);
  }, []);

  const openSite = useCallback(
    (site: Site) => {
      recordRecent(site);
      trackVisit(site);
      window.open(safeUrl(site.url), '_blank', 'noopener');
    },
    [recordRecent, trackVisit],
  );

  const toggleFav = useCallback(
    (id: string) => {
      setFavs((current) => {
        const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
        if (category === '__fav__' && next.length === 0) setCategory('');
        return next;
      });
    },
    [category],
  );

  const selectCategory = useCallback((value: string) => {
    setCategory(value);
  }, []);

  /* ---------------- 过滤与排序 ---------------- */
  const categories = useMemo(() => {
    const list: string[] = [];
    sites.forEach((site) => {
      const name = (site.category || '').trim();
      if (name && !list.includes(name)) list.push(name);
    });
    return list;
  }, [sites]);

  const filteredSites = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = sites.filter((site) => {
      const categoryOk =
        category === '__fav__' ? favs.includes(site.id) : !category || (site.category || '').trim() === category;
      const keywordOk =
        !keyword ||
        (site.name || '').toLowerCase().includes(keyword) ||
        (site.desc || '').toLowerCase().includes(keyword);
      return categoryOk && keywordOk;
    });
    if (prefs.order === 'custom' && customOrder.length) {
      list.sort((a, b) => {
        const indexA = customOrder.indexOf(a.id);
        const indexB = customOrder.indexOf(b.id);
        return (indexA < 0 ? 99999 : indexA) - (indexB < 0 ? 99999 : indexB);
      });
    }
    list.sort((a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)));
    return list;
  }, [sites, query, category, favs, prefs.order, customOrder]);

  /* ---------------- 搜索联想 ---------------- */
  const suggestions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const result: Array<{ type: 'site'; site: Site } | { type: 'history'; text: string }> = [];
    if (!keyword) {
      searchHistory.slice(0, 6).forEach((text) => result.push({ type: 'history', text }));
      return result;
    }
    const matches: Site[] = [];
    sites.forEach((site) => {
      if (
        (site.name || '').toLowerCase().includes(keyword) ||
        (site.desc || '').toLowerCase().includes(keyword)
      ) {
        matches.push(site);
      }
    });
    matches.slice(0, 6).forEach((site) => result.push({ type: 'site', site }));
    searchHistory.forEach((text) => {
      if (text.toLowerCase().includes(keyword) && result.length < 9) result.push({ type: 'history', text });
    });
    return result;
  }, [query, sites, searchHistory]);

  const pushHistory = useCallback((keyword: string) => {
    const value = keyword.trim();
    if (!value) return;
    setSearchHistory((current) => [value, ...current.filter((item) => item !== value)].slice(0, 10));
  }, []);

  const activateSuggestion = useCallback(
    (item: { type: 'site'; site: Site } | { type: 'history'; text: string }) => {
      setSuggestOpen(false);
      setSuggestIndex(-1);
      if (item.type === 'site') {
        pushHistory(item.site.name);
        openSite(item.site);
        setQuery('');
      } else {
        setQuery(item.text);
      }
    },
    [openSite, pushHistory],
  );

  const submitSearch = useCallback(() => {
    const keyword = query.trim();
    if (!keyword) return;
    pushHistory(keyword);
    setSuggestOpen(false);
    if (filteredSites.length === 1) {
      openSite(filteredSites[0]);
      return;
    }
    const engine = ENGINES.find((item) => item.id === engineId) || ENGINES[0];
    window.open(`${engine.url}${encodeURIComponent(keyword)}`, '_blank', 'noopener');
  }, [query, filteredSites, engineId, openSite, pushHistory]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'Escape') {
        setSuggestOpen(false);
        if (typing) (document.activeElement as HTMLElement)?.blur();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  /* ---------------- 拖拽排序 ---------------- */
  const handleDrop = useCallback(
    (targetId: string) => {
      const fromId = dragIdRef.current;
      if (!fromId || fromId === targetId) return;
      const ids = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-site-id]') || []).map(
        (node) => node.dataset.siteId || '',
      );
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, fromId);
      setCustomOrder(ids);
      setPrefs((current) => ({ ...current, order: 'custom' }));
      justDraggedRef.current = true;
      window.setTimeout(() => {
        justDraggedRef.current = false;
      }, 80);
      notifications.show({ message: '已按你的顺序排列（可在偏好设置中恢复默认）', color: 'blue' });
    },
    [],
  );

  const handleCardClick = useCallback(
    (site: Site) => {
      if (justDraggedRef.current) return;
      openSite(site);
    },
    [openSite],
  );

  const lucky = useCallback(() => {
    const pool = sites.filter((site) => site.url);
    if (!pool.length) {
      notifications.show({ message: '还没有引导页', color: 'yellow' });
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    openSite(pick);
    notifications.show({ message: `手气不错 → ${pick.name}`, color: 'blue' });
  }, [sites, openSite]);

  const changePref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }));
  }, []);

  const resetPrefs = useCallback(() => {
    setPrefs({ ...PREF_DEFAULTS });
    setCustomOrder([]);
    notifications.show({ message: '已恢复默认偏好', color: 'blue' });
  }, []);

  const exportPrefs = useCallback(() => {
    const payload = {
      app: 'huanzhong-nav-prefs',
      version: 1,
      exportedAt: new Date().toISOString(),
      favorites: favs,
      recentUses: recent,
      prefs,
      customOrder,
      searchHistory,
      theme: loadString('ht_theme', ''),
      engine: loadString('ht_engine', ''),
    };
    downloadBlob('导航偏好备份.json', JSON.stringify(payload, null, 2));
    notifications.show({ message: '偏好已导出', color: 'green' });
  }, [favs, recent, prefs, customOrder, searchHistory]);

  const importPrefs = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '')) as Record<string, unknown>;
        if (!data || data.app !== 'huanzhong-nav-prefs') {
          notifications.show({ message: '不是有效的偏好备份文件', color: 'red' });
          return;
        }
        if (Array.isArray(data.favorites)) {
          setFavs(data.favorites.filter((item): item is string => typeof item === 'string'));
        }
        if (Array.isArray(data.recentUses)) {
          setRecent(
            (data.recentUses as RecentItem[])
              .filter((item) => item && typeof item.id === 'string')
              .slice(0, 8),
          );
        }
        if (data.prefs && typeof data.prefs === 'object') {
          const clean: Partial<Prefs> = {};
          (['layout', 'font', 'motion', 'radius', 'order'] as (keyof Prefs)[]).forEach((key) => {
            const value = (data.prefs as Record<string, unknown>)[key];
            if (typeof value === 'string') clean[key] = value as never;
          });
          setPrefs({ ...PREF_DEFAULTS, ...clean });
        }
        if (Array.isArray(data.customOrder)) {
          setCustomOrder(data.customOrder.filter((item): item is string => typeof item === 'string'));
        }
        if (Array.isArray(data.searchHistory)) {
          setSearchHistory(
            data.searchHistory.filter((item): item is string => typeof item === 'string').slice(0, 10),
          );
        }
        if (data.theme === 'dark' || data.theme === 'light') saveString('ht_theme', data.theme);
        if (typeof data.engine === 'string' && data.engine) saveString('ht_engine', data.engine);
        notifications.show({ message: '偏好已导入，即将刷新页面', color: 'green' });
        window.setTimeout(() => window.location.reload(), 800);
      } catch {
        notifications.show({ message: '文件解析失败', color: 'red' });
      }
    };
    reader.readAsText(file, 'utf-8');
  }, []);

  const now = clock;
  const greeting = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${
    WEEKDAYS[now.getDay()]
  } · ${greetingForHour(now.getHours())}`;
  const weatherText = weather?.error
    ? '天气暂不可用'
    : weather
      ? `${weather.city || ''} ${weather.desc || ''} ${weather.temp || '--'}℃`
      : '加载中…';
  const weatherTitle = weather
    ? `体感 ${weather.feelsLike ?? '--'}℃ · 湿度 ${weather.humidity ?? '--'}% · 风速 ${
        weather.windKmph ?? '--'
      } 千米/时${weather.stale ? '（缓存数据）' : ''}`
    : '天气数据每 10 分钟刷新';
  const latestAnnouncement = announcements[0];

  return (
    <div className="hz-shell">
      <header className="hz-header">
        <div className="hz-container hz-header-inner">
          <div className="hz-brand">
            <div className="hz-logo">
              {info?.logo ? <img src={safeImage(info.logo)} alt="" /> : '幻'}
            </div>
            <div className="hz-brand-title">{info?.siteName || '幻终の导航'}</div>
          </div>
          <div className="hz-actions">
            <Tooltip label="偏好设置" withArrow>
              <button className="hz-icon-btn" type="button" onClick={() => setModal('prefs')} aria-label="偏好设置">
                <IconSettings size={18} />
              </button>
            </Tooltip>
            {features?.feedback !== false && (
              <Tooltip label="意见反馈" withArrow>
                <button className="hz-icon-btn" type="button" onClick={() => setModal('feedback')} aria-label="意见反馈">
                  <IconMessageDots size={18} />
                </button>
              </Tooltip>
            )}
            {features?.comments !== false && (
              <Tooltip label="留言板" withArrow>
                <button className="hz-icon-btn" type="button" onClick={() => setModal('comments')} aria-label="留言板">
                  <IconMessage size={18} />
                </button>
              </Tooltip>
            )}
            {features?.announcements !== false && announcements.length > 0 && (
              <Tooltip label="公告" withArrow>
                <button className="hz-icon-btn" type="button" onClick={() => setModal('ann')} aria-label="公告">
                  <IconSpeakerphone size={18} />
                  {announcements.length > 1 && <span className="hz-dot">{announcements.length}</span>}
                </button>
              </Tooltip>
            )}
            {features?.qqGroups !== false && qqGroups.length > 0 && (
              <Tooltip label="加入 QQ 群" withArrow>
                <button className="hz-icon-btn" type="button" onClick={() => setModal('qq')} aria-label="加入 QQ 群">
                  <IconUsers size={18} />
                  {qqGroups.length > 1 && <span className="hz-dot">{qqGroups.length}</span>}
                </button>
              </Tooltip>
            )}
            <Tooltip label={colorScheme === 'dark' ? '切换浅色' : '切换深色'} withArrow>
              <button className="hz-icon-btn" type="button" onClick={toggleColorScheme} aria-label="切换主题">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </button>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="hz-container" style={{ flex: 1, paddingBottom: 24 }}>
        <section className="hz-hero">
          <div className="hz-clock">{`${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`}</div>
          <div className="hz-greet">{greeting}</div>
          {quote && <div className="hz-quote">「 {quote} 」</div>}

          {(info?.weatherEnabled || features?.lucky !== false) && (
            <div className="hz-widgets">
              {info?.weatherEnabled && (
                <span className="hz-widget" title={weatherTitle}>
                  <span className="hz-widget-ic">
                    <IconCloud size={15} />
                  </span>
                  <span>{weatherText}</span>
                </span>
              )}
              {features?.lucky !== false && (
                <button className="hz-widget" type="button" onClick={lucky} title="随机打开一个引导页">
                  <span className="hz-widget-ic">
                    <IconDice5 size={15} />
                  </span>
                  手气不错
                </button>
              )}
            </div>
          )}

          {features?.countdown !== false && countdowns.length > 0 && (
            <div className="hz-countdowns">
              {countdowns.map((item) => {
                const target = new Date(`${item.date}T00:00:00`);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
                return (
                  <span
                    key={item.id}
                    className={`hz-countdown${days === 0 ? ' is-today' : ''}`}
                    title={item.date}
                  >
                    <span>{item.name}</span>
                    <strong>{days === 0 ? '就是今天' : `${days} 天`}</strong>
                  </span>
                );
              })}
            </div>
          )}
        </section>

        <div className="hz-search">
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSuggestOpen(true);
              setSuggestIndex(-1);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
            onKeyDown={(event) => {
              if (suggestOpen && suggestions.length) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSuggestIndex((index) => (index + 1) % suggestions.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSuggestIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === 'Enter' && suggestIndex >= 0) {
                  event.preventDefault();
                  activateSuggestion(suggestions[suggestIndex]);
                  return;
                }
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                submitSearch();
              }
            }}
            placeholder="搜索引导页，或输入后回车用搜索引擎直达…"
            autoComplete="off"
            aria-label="搜索引导页"
          />
          <span className="hz-search-icon">
            <IconSearch size={17} />
          </span>
          {suggestOpen && suggestions.length > 0 && (
            <div className="hz-suggest">
              {suggestions.map((item, index) => (
                <div
                  key={`${item.type}-${item.type === 'site' ? item.site.id : item.text}`}
                  className={`hz-suggest-item${index === suggestIndex ? ' is-active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    activateSuggestion(item);
                  }}
                >
                  <span className="hz-suggest-tag">{item.type === 'site' ? '站点' : '历史'}</span>
                  <span className="hz-suggest-name">{item.type === 'site' ? item.site.name : item.text}</span>
                  {item.type === 'history' && (
                    <span
                      className="hz-suggest-del"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSearchHistory((current) => current.filter((text) => text !== item.text));
                      }}
                    >
                      ✕ 删除
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="hz-search-hint">在搜索框输入关键词后按回车，可用当前选中的搜索引擎直接搜索</div>
        <div className="hz-engines">
          {ENGINES.map((engine) => (
            <button
              key={engine.id}
              type="button"
              className={`hz-engine${engine.id === engineId ? ' is-active' : ''}`}
              onClick={() => {
                setEngineId(engine.id);
                notifications.show({ message: `已切换搜索引擎：${engine.name}`, color: 'blue' });
              }}
            >
              {engine.name}
            </button>
          ))}
        </div>

        {features?.announcements !== false && latestAnnouncement && (
          <div
            className="hz-announce"
            role="button"
            tabIndex={0}
            onClick={() => setModal('ann')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setModal('ann');
            }}
          >
            <IconSpeakerphone size={16} color="var(--accent)" />
            <span className="hz-announce-text">
              {latestAnnouncement.title ? `【${latestAnnouncement.title}】` : ''}
              {latestAnnouncement.content}
            </span>
            {announcements.length > 1 && <span className="hz-announce-more">查看全部 ›</span>}
          </div>
        )}

        {features?.recent !== false && recent.length > 0 && (
          <div className="hz-recent">
            <div className="hz-recent-title">最近使用</div>
            <div className="hz-recent-list">
              {recent.map((item) => (
                <a
                  key={item.id}
                  className="hz-recent-item"
                  href={safeUrl(item.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`最近使用：${item.name}`}
                  onClick={() => {
                    const site = sites.find((entry) => entry.id === item.id);
                    if (site) trackVisit(site);
                  }}
                >
                  {item.icon && <img src={safeImage(item.icon)} alt="" onError={(event) => (event.currentTarget.style.display = 'none')} />}
                  <span>{item.name}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {(categories.length > 0 || favs.length > 0) && (
          <div className="hz-cats">
            <button
              type="button"
              className={`hz-cat${category === '' ? ' is-active' : ''}`}
              onClick={() => selectCategory('')}
            >
              全部
            </button>
            {favs.length > 0 && (
              <button
                type="button"
                className={`hz-cat${category === '__fav__' ? ' is-active' : ''}`}
                onClick={() => selectCategory('__fav__')}
              >
                ★ 收藏
              </button>
            )}
            {categories.map((name) => (
              <button
                key={name}
                type="button"
                className={`hz-cat${category === name ? ' is-active' : ''}`}
                onClick={() => selectCategory(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {features?.popular !== false && popular.length > 0 && (
          <div className="hz-section">
            <div className="hz-section-title">🔥 大家都在用</div>
            <div className="hz-popular">
              {popular.map((item, index) => (
                <a
                  key={item.id}
                  className="hz-popular-item"
                  href={safeUrl(item.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${item.name}（${item.total} 次访问）`}
                  onClick={() => {
                    recordRecent(item as unknown as Site);
                    trackVisit(item as unknown as Site);
                  }}
                >
                  <span className="hz-popular-rank">{index + 1}</span>
                  {item.icon && <img src={safeImage(item.icon)} alt="" />}
                  <span>{item.name}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        <div ref={gridRef} className="hz-grid" data-layout={prefs.layout} style={{ marginTop: 18 }}>
          {filteredSites.map((site) => (
            <div
              key={site.id}
              className="hz-card"
              data-site-id={site.id}
              role="link"
              tabIndex={0}
              draggable
              onDragStart={(event) => {
                dragIdRef.current = site.id;
                event.dataTransfer.effectAllowed = 'move';
                try {
                  event.dataTransfer.setData('text/plain', site.id);
                } catch {
                  /* ignore */
                }
              }}
              onDragEnd={() => {
                dragIdRef.current = '';
                window.setTimeout(() => {
                  justDraggedRef.current = false;
                }, 60);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                justDraggedRef.current = true;
                handleDrop(site.id);
              }}
              onClick={() => handleCardClick(site)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleCardClick(site);
                }
              }}
              title={site.desc || site.name}
            >
              <div className="hz-card-tile">
                <SiteIcon site={site} />
              </div>
              <button
                type="button"
                className={`hz-fav${favs.includes(site.id) ? ' is-on' : ''}`}
                aria-label={favs.includes(site.id) ? '取消收藏' : '收藏'}
                title={favs.includes(site.id) ? '取消收藏' : '收藏'}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleFav(site.id);
                }}
              >
                {favs.includes(site.id) ? <IconStarFilled size={15} /> : <IconStar size={15} />}
              </button>
              <div className="hz-card-info">
                <div className="hz-card-name">{site.name}</div>
                {site.desc && <div className="hz-card-desc">{site.desc}</div>}
              </div>
            </div>
          ))}
        </div>

        {!sitesLoading && filteredSites.length === 0 && (
          <div className="hz-empty">
            <IconFolderOff size={46} stroke={1.5} />
            <div>{sites.length ? '没有找到匹配的引导页' : '暂无引导页，请等待管理员添加'}</div>
          </div>
        )}

        {sitesLoading && (
          <Stack align="center" py="xl">
            <Loader size="sm" />
            <Text size="xs" c="dimmed">
              正在加载引导页…
            </Text>
          </Stack>
        )}

        {features?.download !== false && (
          <a className="hz-download-entry" href="/download">
            <span className="hz-download-icon">
              <IconDownload size={22} />
            </span>
            <span className="hz-download-main">
              <span className="hz-download-title">文件下载</span>
              <span className="hz-download-sub">
                {fileSummary
                  ? `${fileSummary.count} 个文件 · 累计下载 ${formatNumber(fileSummary.downloads)} 次`
                  : '暂无可下载的文件'}
              </span>
            </span>
            <IconChevronRight size={18} className="hz-muted" />
          </a>
        )}

        {features?.friendlinks !== false && friendlinks.length > 0 && (
          <div className="hz-friends">
            <div className="hz-section-title">友情链接</div>
            <div className="hz-friends-list">
              {friendlinks.map((link) => (
                <a
                  key={link.id}
                  className="hz-friend"
                  href={safeUrl(link.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.name}
                </a>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="hz-footer">
        <span>{info?.footerText || '幻终の导航 · 轻量网址导航'}</span>
        <a href="/status" title="查看服务运行状态">
          运行状态
        </a>
      </footer>

      <AnnouncementsModal opened={modal === 'ann'} onClose={() => setModal(null)} items={announcements} />
      <QqModal opened={modal === 'qq'} onClose={() => setModal(null)} groups={qqGroups} />
      <CommentsModal
        opened={modal === 'comments'}
        onClose={() => setModal(null)}
        maxLen={info?.limits.commentMaxLen || 200}
      />
      <FeedbackModal
        opened={modal === 'feedback'}
        onClose={() => setModal(null)}
        maxLen={info?.limits.feedbackMaxLen || 300}
      />
      <PrefsModal
        opened={modal === 'prefs'}
        onClose={() => setModal(null)}
        prefs={prefs}
        onChange={changePref}
        onReset={resetPrefs}
        onExport={exportPrefs}
        onImport={importPrefs}
      />
    </div>
  );
}

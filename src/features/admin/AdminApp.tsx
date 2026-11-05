import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChartBar,
  IconCloudUpload,
  IconFolder,
  IconLayoutDashboard,
  IconList,
  IconLogout,
  IconMenu2,
  IconMessage,
  IconMoon,
  IconSettings,
  IconShieldLock,
  IconSpeakerphone,
  IconStar,
  IconSun,
  IconTimeline,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { api } from '../../lib/api';
import { encryptPassword } from '../../lib/rsa';
import { useApp } from '../../components/AppProviders';
import type { CurrentUser, SiteInfo } from '../../lib/types';
import DashboardSection from './DashboardSection';
import SitesSection from './SitesSection';
import FilesSection from './FilesSection';
import NodesSection from './NodesSection';
import {
  AnnouncementsSection,
  CommentsSection,
  CountdownsSection,
  FeedbacksSection,
  FriendLinksSection,
  QqGroupsSection,
} from './ContentSections';
import LogsSection from './LogsSection';
import UsersSection from './UsersSection';
import SecuritySection from './SecuritySection';
import SettingsSection from './SettingsSection';
import MonitorsSection from './MonitorsSection';

type SectionKey =
  | 'dashboard'
  | 'sites'
  | 'files'
  | 'nodes'
  | 'announcements'
  | 'qqgroups'
  | 'comments'
  | 'feedbacks'
  | 'countdowns'
  | 'friendlinks'
  | 'logs'
  | 'users'
  | 'security'
  | 'settings'
  | 'monitors';

const NAV: { group: string; items: { key: SectionKey; label: string; icon: typeof IconLayoutDashboard }[] }[] = [
  { group: '总览', items: [{ key: 'dashboard', label: '仪表盘', icon: IconLayoutDashboard }] },
  {
    group: '内容与文件',
    items: [
      { key: 'sites', label: '引导页管理', icon: IconList },
      { key: 'files', label: '文件管理', icon: IconFolder },
      { key: 'nodes', label: '节点系统', icon: IconCloudUpload },
    ],
  },
  {
    group: '运营',
    items: [
      { key: 'announcements', label: '公告管理', icon: IconSpeakerphone },
      { key: 'qqgroups', label: 'QQ群管理', icon: IconUsers },
      { key: 'comments', label: '留言管理', icon: IconMessage },
      { key: 'feedbacks', label: '反馈管理', icon: IconMessage },
      { key: 'countdowns', label: '倒计时管理', icon: IconTimeline },
      { key: 'friendlinks', label: '友链管理', icon: IconStar },
    ],
  },
  {
    group: '系统与安全',
    items: [
      { key: 'logs', label: '日志记录', icon: IconChartBar },
      { key: 'users', label: '账号管理', icon: IconUsers },
      { key: 'security', label: '安全防护', icon: IconShieldLock },
      { key: 'settings', label: '系统设置', icon: IconSettings },
      { key: 'monitors', label: '网站监控', icon: IconTimeline },
    ],
  },
];

const TITLES: Record<SectionKey, string> = Object.fromEntries(
  NAV.flatMap((group) => group.items.map((item) => [item.key, item.label])),
) as Record<SectionKey, string>;

function readSection(): SectionKey {
  const hash = window.location.hash.replace('#', '') as SectionKey;
  return TITLES[hash] ? hash : 'dashboard';
}

export default function AdminApp() {
  const { info, reload: reloadInfo, colorScheme, toggleColorScheme } = useApp();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(true);

  const checkSession = useCallback(async () => {
    setChecking(true);
    try {
      const data = await api<{ user: CurrentUser }>('/api/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const handleLoggedIn = useCallback(async () => {
    await Promise.all([checkSession(), reloadInfo()]);
  }, [checkSession, reloadInfo]);

  if (checking) {
    return (
      <Center mih="100vh">
        <Stack align="center" gap={10}>
          <Loader />
          <Text size="sm" c="dimmed">
            正在校验登录状态…
          </Text>
        </Stack>
      </Center>
    );
  }

  if (!user) {
    return <AuthView info={info} onSuccess={handleLoggedIn} />;
  }

  if (user.role !== 'owner' && user.role !== 'admin') {
    return <RoleDeniedView user={user} onLogout={async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      setUser(null);
    }} />;
  }

  return (
    <AdminShell
      user={user}
      siteName={info?.siteName || '幻终の导航'}
      logo={info?.logo || ''}
      colorScheme={colorScheme}
      toggleColorScheme={toggleColorScheme}
      onLogout={async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        setUser(null);
        notifications.show({ message: '已退出登录', color: 'blue' });
      }}
    />
  );
}

/* ============================ 登录 / 注册 ============================ */

function AuthView({ info, onSuccess }: { info: SiteInfo | null; onSuccess: () => Promise<void> }) {
  const firstRun = Boolean(info?.firstRun);
  const allowRegister = firstRun || Boolean(info?.allowRegister);
  const [mode, setMode] = useState<'login' | 'register'>(firstRun ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const needCaptcha = Boolean(info?.loginCaptcha) && !(mode === 'register' && firstRun);

  const refreshCaptcha = useCallback(async () => {
    try {
      const data = await api<{ captchaId: string }>('/api/captcha/new');
      if (data.captchaId) {
        setCaptchaId(data.captchaId);
        setCaptchaAnswer('');
      }
    } catch {
      setCaptchaId('');
    }
  }, []);

  useEffect(() => {
    if (needCaptcha) void refreshCaptcha();
  }, [needCaptcha, refreshCaptcha]);

  const submit = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名与密码');
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (needCaptcha && (!captchaId || !captchaAnswer.trim())) {
      setError('请输入验证码');
      return;
    }
    setBusy(true);
    try {
      const encrypted = await encryptPassword(password);
      const body: Record<string, unknown> = { username: username.trim(), password: encrypted };
      if (needCaptcha) {
        body.captchaId = captchaId;
        body.captchaAnswer = captchaAnswer.trim();
      }
      await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body });
      notifications.show({
        message: mode === 'login' ? '登录成功' : '账号已创建并登录',
        color: 'green',
      });
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
      if (needCaptcha) await refreshCaptcha();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hz-auth">
      <div className="hz-auth-card">
        <Stack gap="sm">
          <Group gap={10} mb={4}>
            <div className="hz-logo">
              {info?.logo ? <img src={info.logo} alt="" /> : '幻'}
            </div>
            <div>
              <Title order={3} style={{ fontSize: 19 }}>
                {info?.siteName || '幻终の导航'}
              </Title>
              <Text size="xs" c="dimmed">
                管理后台
              </Text>
            </div>
          </Group>

          {firstRun && (
            <Alert color="blue" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="xs">系统尚未创建任何账号，请注册首个「站长」账号完成初始化。</Text>
            </Alert>
          )}

          <TextInput
            label="用户名"
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
            placeholder="2-20 位中文、字母、数字或下划线"
            autoComplete="username"
          />
          <PasswordInput
            label="密码"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            placeholder="6-64 位"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {mode === 'register' && (
            <PasswordInput
              label="确认密码"
              value={confirm}
              onChange={(event) => setConfirm(event.currentTarget.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
            />
          )}
          {needCaptcha && (
            <Group gap={8} align="flex-end">
              {captchaId ? (
                <img
                  src={`/api/captcha/img?c=${encodeURIComponent(captchaId)}&t=${Date.now()}`}
                  alt="验证码"
                  title="点击刷新"
                  onClick={() => void refreshCaptcha()}
                  style={{
                    height: 40,
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: '1px solid var(--line)',
                    background: '#fff',
                  }}
                />
              ) : (
                <Button variant="default" size="compact-sm" onClick={() => void refreshCaptcha()}>
                  获取验证码
                </Button>
              )}
              <TextInput
                label="验证码"
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.currentTarget.value)}
                maxLength={4}
                style={{ flex: 1 }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
              />
            </Group>
          )}

          {error && (
            <Text size="xs" c="red">
              {error}
            </Text>
          )}

          <Button loading={busy} onClick={() => void submit()} fullWidth mt={4}>
            {mode === 'login' ? '登录' : '创建账号并登录'}
          </Button>

          {allowRegister && !firstRun && (
            <Text size="xs" c="dimmed" ta="center">
              {mode === 'login' ? '还没有账号？' : '已有账号？'}
              <Anchor
                component="button"
                type="button"
                size="xs"
                ml={4}
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError('');
                }}
              >
                {mode === 'login' ? '注册（默认访客角色）' : '返回登录'}
              </Anchor>
            </Text>
          )}
          <Divider my={4} />
          <Group justify="center" gap={12}>
            <Anchor href="/" size="xs" c="dimmed">
              返回前台
            </Anchor>
            <Anchor href="/status" size="xs" c="dimmed">
              运行状态
            </Anchor>
          </Group>
        </Stack>
      </div>
    </div>
  );
}

/* ============================ 无权限提示 ============================ */

function RoleDeniedView({ user, onLogout }: { user: CurrentUser; onLogout: () => Promise<void> }) {
  return (
    <div className="hz-auth">
      <div className="hz-auth-card" style={{ textAlign: 'center' }}>
        <Stack align="center" gap="sm">
          <div className="hz-logo" style={{ width: 52, height: 52 }}>
            <IconShieldLock size={26} />
          </div>
          <Title order={3} style={{ fontSize: 20 }}>
            权限不足
          </Title>
          <Text size="sm" c="dimmed">
            当前账号 <strong>{user.username}</strong> 的角色为「{user.roleLabel || user.role}」，无法进入管理后台。
          </Text>
          <Text size="xs" c="dimmed">
            请联系站长在「账号管理」中提升角色为「管理员」或「站长」。
          </Text>
          <Group gap={8} mt={6}>
            <Button variant="default" size="xs" onClick={() => void onLogout()}>
              退出登录
            </Button>
            <Button component="a" href="/" size="xs">
              返回前台
            </Button>
          </Group>
        </Stack>
      </div>
    </div>
  );
}

/* ============================ 后台布局 ============================ */

function AdminShell({
  user,
  siteName,
  logo,
  colorScheme,
  toggleColorScheme,
  onLogout,
}: {
  user: CurrentUser;
  siteName: string;
  logo: string;
  colorScheme: 'light' | 'dark';
  toggleColorScheme: () => void;
  onLogout: () => Promise<void>;
}) {
  const [section, setSection] = useState<SectionKey>(() => readSection());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const handler = () => setSection(readSection());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = (key: SectionKey) => {
    setSection(key);
    setNavOpen(false);
    if (window.location.hash !== `#${key}`) {
      window.history.replaceState(null, '', `#${key}`);
    }
  };

  const content = useMemo(() => {
    switch (section) {
      case 'dashboard':
        return <DashboardSection />;
      case 'sites':
        return <SitesSection />;
      case 'files':
        return <FilesSection />;
      case 'nodes':
        return <NodesSection />;
      case 'announcements':
        return <AnnouncementsSection />;
      case 'qqgroups':
        return <QqGroupsSection />;
      case 'comments':
        return <CommentsSection />;
      case 'feedbacks':
        return <FeedbacksSection />;
      case 'countdowns':
        return <CountdownsSection />;
      case 'friendlinks':
        return <FriendLinksSection />;
      case 'logs':
        return <LogsSection />;
      case 'users':
        return <UsersSection user={user} />;
      case 'security':
        return <SecuritySection />;
      case 'settings':
        return <SettingsSection user={user} />;
      case 'monitors':
        return <MonitorsSection />;
      default:
        return <DashboardSection />;
    }
  }, [section, user]);

  return (
    <div className="hz-admin">
      <aside className={`hz-admin-side${navOpen ? ' is-open' : ''}`}>
        <div className="hz-admin-brand">
          <div className="hz-logo" style={{ width: 32, height: 32, fontSize: 15 }}>
            {logo ? <img src={logo} alt="" /> : '幻'}
          </div>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {siteName}
          </span>
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            onClick={() => setNavOpen(false)}
            aria-label="关闭导航"
            className="hz-nav-close"
          >
            <IconX size={14} />
          </Button>
        </div>

        {NAV.map((group) => (
          <div key={group.group}>
            <div className="hz-admin-group">{group.group}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`hz-nav-item${section === item.key ? ' is-active' : ''}`}
                  onClick={() => navigate(item.key)}
                >
                  <Icon size={17} />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <a className="hz-nav-item" href="/">
            <IconArrowLeft size={17} />
            返回前台
          </a>
        </div>
      </aside>

      <div className="hz-admin-main">
        <div className="hz-admin-top">
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            onClick={() => setNavOpen(true)}
            aria-label="打开导航"
            className="hz-nav-open"
          >
            <IconMenu2 size={18} />
          </Button>
          <Title order={4} style={{ fontSize: 17, flex: 1 }}>
            {TITLES[section]}
          </Title>
          <Text size="xs" c="dimmed" visibleFrom="sm">
            {user.username} · {user.roleLabel || user.role}
          </Text>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            onClick={toggleColorScheme}
            aria-label="切换主题"
          >
            {colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
          </Button>
          <Button variant="default" size="compact-sm" leftSection={<IconLogout size={14} />} onClick={() => void onLogout()}>
            退出
          </Button>
        </div>
        <div className="hz-admin-content">{content}</div>
      </div>
    </div>
  );
}


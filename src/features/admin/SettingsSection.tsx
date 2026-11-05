import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Divider,
  FileButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconDownload, IconPhoto, IconUpload } from '@tabler/icons-react';
import { api, uploadIcon } from '../../lib/api';
import { encryptPassword } from '../../lib/rsa';
import { formatBytes, formatDateTime } from '../../lib/format';
import type { AdminSettings, CurrentUser } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, useLoad } from './shared';

interface SettingsPayload {
  settings: AdminSettings;
  numRules: Record<string, { min: number; max: number; def: number }>;
}

const FEATURE_ITEMS: { key: keyof AdminSettings; label: string }[] = [
  { key: 'announcementsEnabled', label: '公告系统' },
  { key: 'qqGroupsEnabled', label: 'QQ 群入口' },
  { key: 'commentsEnabled', label: '留言板' },
  { key: 'feedbackEnabled', label: '意见反馈' },
  { key: 'countdownEnabled', label: '倒计时' },
  { key: 'friendlinksEnabled', label: '友情链接' },
  { key: 'popularEnabled', label: '热门横条' },
  { key: 'visitorStatsEnabled', label: '访客统计' },
  { key: 'luckyEnabled', label: '手气不错' },
  { key: 'recentEnabled', label: '最近使用' },
  { key: 'downloadEnabled', label: '文件共享' },
  { key: 'shareCodesEnabled', label: '取件码' },
];

const NUM_ITEMS: { key: keyof AdminSettings; label: string; unit: string }[] = [
  { key: 'commentMaxLen', label: '留言最大字数', unit: '字' },
  { key: 'feedbackMaxLen', label: '反馈最大字数', unit: '字' },
  { key: 'popularTopN', label: '热门横条展示条数', unit: '条' },
  { key: 'shareDefaultTtlHours', label: '取件码默认有效期', unit: '小时' },
  { key: 'downloadRateMbps', label: '下载限速', unit: 'MB/s（0 不限速）' },
  { key: 'fileMaxMb', label: '单个共享文件上限', unit: 'MB' },
  { key: 'maxAttempts', label: '登录失败封禁阈值', unit: '次' },
  { key: 'banDurationMin', label: 'IP 封禁时长', unit: '分钟' },
  { key: 'heatmapDays', label: '热力图统计天数', unit: '天' },
];

const BACKUP_CHUNK = 1024 * 1024;

export default function SettingsSection({ user }: { user: CurrentUser }) {
  const { data, loading, error, reload } = useLoad<SettingsPayload>('/api/admin/settings');
  const [form, setForm] = useState<AdminSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [quotesOpen, setQuotesOpen] = useState(false);
  const [quotes, setQuotes] = useState<{ id: string; text: string }[]>([]);
  const [newQuote, setNewQuote] = useState('');
  const [restoreProgress, setRestoreProgress] = useState<{ label: string; percent: number } | null>(null);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => {
    if (data?.settings) setForm({ ...data.settings });
  }, [data]);

  const numRules = data?.numRules || {};

  const update = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await api('/api/admin/settings', { method: 'PUT', body: form });
      notifications.show({ message: '设置已保存并即时生效', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const pickImage = async (file: File | null, key: 'logo' | 'background') => {
    if (!file || !form) return;
    try {
      const result = await uploadIcon(file);
      update(key, result.url);
      notifications.show({ message: result.converted ? '已上传并自动转换为 PNG' : '图片已上传', color: 'green' });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '上传失败', color: 'red' });
    }
  };

  const openQuotes = async () => {
    setQuotesOpen(true);
    try {
      const result = await api<{ quotes: { id: string; text: string }[] }>('/api/admin/quotes');
      setQuotes(result.quotes || []);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '加载语录失败', color: 'red' });
    }
  };

  const addQuote = async () => {
    if (!newQuote.trim()) return;
    try {
      await api('/api/admin/quotes', { method: 'POST', body: { text: newQuote.trim() } });
      setNewQuote('');
      const result = await api<{ quotes: { id: string; text: string }[] }>('/api/admin/quotes');
      setQuotes(result.quotes || []);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '添加失败', color: 'red' });
    }
  };

  const removeQuote = async (id: string) => {
    try {
      await api(`/api/admin/quotes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setQuotes((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const importJsonBackup = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      const result = await api<{ sites: number }>('/api/admin/restore', { method: 'POST', body: parsed });
      notifications.show({ message: `数据备份已导入，共 ${result.sites} 条引导页`, color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '导入失败', color: 'red' });
    }
  };

  const importFullBackup = async (file: File | null) => {
    if (!file) return;
    const totalChunks = Math.max(1, Math.ceil(file.size / BACKUP_CHUNK));
    setRestoreProgress({ label: '正在初始化…', percent: 2 });
    try {
      const init = await api<{ taskId: string }>('/api/admin/restore/full/init', {
        method: 'POST',
        body: { size: file.size, totalChunks },
      });
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * BACKUP_CHUNK;
        const blob = file.slice(start, Math.min(file.size, start + BACKUP_CHUNK));
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
          };
          reader.onerror = () => reject(new Error('读取分块失败'));
          reader.readAsDataURL(blob);
        });
        await api('/api/admin/restore/full/chunk', {
          method: 'POST',
          body: { taskId: init.taskId, index, data: base64 },
        });
        setRestoreProgress({
          label: `正在上传备份… ${formatBytes(Math.min(file.size, start + BACKUP_CHUNK))} / ${formatBytes(file.size)}`,
          percent: Math.min(90, Math.round(((index + 1) / totalChunks) * 85)),
        });
      }
      setRestoreProgress({ label: '正在校验并恢复数据…', percent: 94 });
      await api('/api/admin/restore/full/finish', { method: 'POST', body: { taskId: init.taskId } });
      setRestoreProgress({ label: '恢复完成', percent: 100 });
      notifications.show({ message: '完整备份已恢复，数据已重新加载', color: 'green', autoClose: 6000 });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '恢复失败', color: 'red', autoClose: 8000 });
      setRestoreProgress(null);
    }
  };

  const changePassword = async () => {
    if (!oldPassword || !newPassword) {
      notifications.show({ message: '请填写原密码与新密码', color: 'red' });
      return;
    }
    setPasswordBusy(true);
    try {
      const [oldEncrypted, newEncrypted] = await Promise.all([
        encryptPassword(oldPassword),
        encryptPassword(newPassword),
      ]);
      await api('/api/admin/password', {
        method: 'PUT',
        body: { oldPassword: oldEncrypted, newPassword: newEncrypted },
      });
      notifications.show({ message: '密码已修改，其他设备会话已下线', color: 'green' });
      setOldPassword('');
      setNewPassword('');
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '修改失败', color: 'red' });
    } finally {
      setPasswordBusy(false);
    }
  };

  const featureSummary = useMemo(
    () => FEATURE_ITEMS.filter((item) => form && form[item.key] === false).map((item) => item.label),
    [form],
  );

  if (loading && !form) return <LoadingBlock label="正在加载系统设置…" />;
  if (error && !form) return <ErrorBlock message={error} onRetry={reload} />;
  if (!form) return null;

  return (
    <div>
      <Panel title="站点信息" description="保存后立即生效，无需重启服务">
        <Stack gap="md">
          <TextInput
            label="站点名称"
            maxLength={30}
            value={form.siteName}
            onChange={(event) => update('siteName', event.currentTarget.value)}
            style={{ maxWidth: 360 }}
          />
          <Group grow align="flex-start">
            <Select
              label="注册开关"
              value={form.allowRegister ? 'on' : 'off'}
              onChange={(value) => update('allowRegister', value === 'on')}
              data={[
                { value: 'on', label: '开启（自助注册默认访客角色）' },
                { value: 'off', label: '关闭（仅后台手动创建）' },
              ]}
            />
            <Select
              label="登录人机验证"
              value={form.loginCaptcha ? 'on' : 'off'}
              onChange={(value) => update('loginCaptcha', value === 'on')}
              data={[
                { value: 'on', label: '开启（登录需图形验证码）' },
                { value: 'off', label: '关闭' },
              ]}
            />
          </Group>

          <div>
            <Text size="sm" fw={500} mb={4}>站点 Logo</Text>
            <Group gap={8} align="center">
              <TextInput
                placeholder="图片地址或上传图片，留空使用默认文字 Logo"
                value={form.logo}
                onChange={(event) => update('logo', event.currentTarget.value)}
                style={{ flex: 1, maxWidth: 420 }}
              />
              <FileButton accept="image/*" onChange={(file) => void pickImage(file, 'logo')}>
                {(props) => (
                  <Button variant="light" leftSection={<IconPhoto size={14} />} {...props}>
                    上传
                  </Button>
                )}
              </FileButton>
              <Button variant="subtle" onClick={() => update('logo', '')}>
                恢复默认
              </Button>
            </Group>
            {form.logo && <img src={form.logo} alt="" style={{ height: 40, marginTop: 8, borderRadius: 8 }} />}
            <Text size="xs" c="dimmed" mt={4}>
              支持 PNG / JPG / GIF / WebP / ICO / BMP / SVG / AVIF / TIFF / APNG（≤1MB）
            </Text>
          </div>

          <div>
            <Text size="sm" fw={500} mb={4}>主题色</Text>
            <Group gap={8}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : '#007aff'}
                onChange={(event) => update('accentColor', event.currentTarget.value)}
                style={{ width: 46, height: 36, border: '1px solid var(--line)', borderRadius: 10, background: 'transparent' }}
                aria-label="选择主题色"
              />
              <TextInput
                placeholder="#007aff"
                maxLength={7}
                value={form.accentColor}
                onChange={(event) => update('accentColor', event.currentTarget.value)}
                style={{ width: 110 }}
              />
              <Button variant="subtle" onClick={() => update('accentColor', '')}>
                恢复默认
              </Button>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              前台首页、下载页与后台的按钮/高亮颜色
            </Text>
          </div>

          <div>
            <Text size="sm" fw={500} mb={4}>整页背景图</Text>
            <Group gap={8}>
              <TextInput
                placeholder="图片地址或上传图片，留空使用默认渐变背景"
                value={form.background}
                onChange={(event) => update('background', event.currentTarget.value)}
                style={{ flex: 1, maxWidth: 420 }}
              />
              <FileButton accept="image/*" onChange={(file) => void pickImage(file, 'background')}>
                {(props) => (
                  <Button variant="light" leftSection={<IconUpload size={14} />} {...props}>
                    上传
                  </Button>
                )}
              </FileButton>
              <Button variant="subtle" onClick={() => update('background', '')}>
                恢复默认
              </Button>
            </Group>
            {form.background && (
              <img src={form.background} alt="" style={{ height: 60, marginTop: 8, borderRadius: 8, objectFit: 'cover' }} />
            )}
          </div>

          <TextInput
            label="页脚文案"
            maxLength={200}
            placeholder="如：备案号 京ICP备xxxx号 · 一句话介绍"
            value={form.footerText}
            onChange={(event) => update('footerText', event.currentTarget.value)}
            style={{ maxWidth: 520 }}
          />

          <Group grow align="flex-end">
            <Select
              label="天气显示"
              value={form.weatherEnabled ? 'on' : 'off'}
              onChange={(value) => update('weatherEnabled', value === 'on')}
              data={[
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' },
              ]}
            />
            <TextInput
              label="备用城市（可选）"
              maxLength={30}
              placeholder="如：北京"
              value={form.weatherCity}
              onChange={(event) => update('weatherCity', event.currentTarget.value)}
            />
          </Group>

          <Group gap={8}>
            <Select
              label="每日一言"
              value={form.quoteEnabled ? 'on' : 'off'}
              onChange={(value) => update('quoteEnabled', value === 'on')}
              data={[
                { value: 'on', label: '开启（随机展示一句）' },
                { value: 'off', label: '关闭' },
              ]}
              style={{ width: 220 }}
            />
            <Button variant="light" mt={22} onClick={() => void openQuotes()}>
              管理自定义语录
            </Button>
          </Group>

          <Group align="flex-end" gap={8}>
            <Select
              label="定时死链检测"
              value={form.linkCheckEnabled ? 'on' : 'off'}
              onChange={(value) => update('linkCheckEnabled', value === 'on')}
              data={[
                { value: 'off', label: '关闭（仅手动检测）' },
                { value: 'on', label: '开启自动检测' },
              ]}
              style={{ width: 220 }}
            />
            <NumberInput
              label="检测间隔（小时）"
              min={1}
              max={168}
              value={form.linkCheckInterval}
              onChange={(value) => update('linkCheckInterval', Number(value) || 24)}
              style={{ width: 150 }}
            />
          </Group>
        </Stack>
      </Panel>

      <Panel title="访问控制" description="被拦截的访客会看到自定义拦截页；管理员登录后豁免，不影响后台管理">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={10} mb="md">
          <Switch
            label="拦截国内 IP"
            checked={form.acDomesticBlock}
            onChange={(event) => update('acDomesticBlock', event.currentTarget.checked)}
          />
          <Switch
            label="拦截海外 IP"
            checked={form.acOverseasBlock}
            onChange={(event) => update('acOverseasBlock', event.currentTarget.checked)}
          />
          <Switch
            label="拦截机房 IP"
            checked={form.acDatacenterBlock}
            onChange={(event) => update('acDatacenterBlock', event.currentTarget.checked)}
          />
          <Switch
            label="机房 IP 自动关闭页面"
            checked={form.acDcAutoClose}
            onChange={(event) => update('acDcAutoClose', event.currentTarget.checked)}
          />
          <Switch
            label="F12 调试防护"
            checked={form.acF12Block}
            onChange={(event) => update('acF12Block', event.currentTarget.checked)}
          />
          <Switch
            label="检测到开发者工具后自动关闭页面"
            checked={form.acF12AutoClose}
            onChange={(event) => update('acF12AutoClose', event.currentTarget.checked)}
          />
        </SimpleGrid>
        <Divider mb="md" />
        <Stack gap="sm" style={{ maxWidth: 560 }}>
          <TextInput
            label="拦截页标题"
            maxLength={60}
            value={form.blockTitle}
            onChange={(event) => update('blockTitle', event.currentTarget.value)}
          />
          <Textarea
            label="拦截页正文"
            minRows={3}
            maxLength={500}
            value={form.blockContent}
            onChange={(event) => update('blockContent', event.currentTarget.value)}
          />
          <Group align="flex-end" gap={12}>
            <NumberInput
              label="默认字体大小"
              min={12}
              max={32}
              value={form.blockFontSize}
              onChange={(value) => update('blockFontSize', Number(value) || 16)}
              style={{ width: 120 }}
            />
            <Switch
              label="文本自动换行"
              checked={form.blockTextWrap}
              onChange={(event) => update('blockTextWrap', event.currentTarget.checked)}
              mb={6}
            />
          </Group>
        </Stack>
      </Panel>

      <Panel
        title="功能开关"
        description={
          featureSummary.length
            ? `当前已关闭：${featureSummary.join('、')}；关闭后前台隐藏入口且对外接口不再返回数据`
            : '关闭某功能后，前台将隐藏对应入口，相关对外接口也不再返回数据；后台数据管理不受影响'
        }
      >
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={8}>
          {FEATURE_ITEMS.map((item) => (
            <Switch
              key={item.key}
              label={item.label}
              checked={Boolean(form[item.key])}
              onChange={(event) => update(item.key, event.currentTarget.checked as never)}
            />
          ))}
        </SimpleGrid>
      </Panel>

      <Panel title="数值设置" description="超出允许范围的值无法保存">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={12}>
          {NUM_ITEMS.map((item) => {
            const rule = numRules[item.key as string];
            return (
              <div key={item.key}>
                <NumberInput
                  label={`${item.label}（${item.unit}）`}
                  min={rule?.min}
                  max={rule?.max}
                  value={Number(form[item.key])}
                  onChange={(value) => update(item.key, Number(value) as never)}
                />
                {rule && (
                  <Text size="xs" c="dimmed" mt={2}>
                    允许范围 {rule.min}～{rule.max}，默认 {rule.def}
                  </Text>
                )}
              </div>
            );
          })}
        </SimpleGrid>
      </Panel>

      <Group justify="flex-end" mb={16}>
        <Button size="md" loading={saving} onClick={() => void save()}>
          保存设置
        </Button>
      </Group>

      <Panel title="数据备份与恢复" description="数据备份仅包含引导页、设置等元数据；完整备份额外包含全部共享文件">
        <Group gap={10} wrap="wrap">
          <Button component="a" href="/api/admin/backup" leftSection={<IconDownload size={14} />}>
            导出数据备份
          </Button>
          <FileButton accept=".json,application/json" onChange={(file) => void importJsonBackup(file)}>
            {(props) => (
              <Button variant="light" leftSection={<IconUpload size={14} />} {...props}>
                导入数据备份
              </Button>
            )}
          </FileButton>
          <Button component="a" href="/api/admin/backup/full" variant="light" leftSection={<IconDownload size={14} />}>
            导出完整备份
          </Button>
          <FileButton accept=".zip,application/zip" onChange={(file) => void importFullBackup(file)}>
            {(props) => (
              <Button variant="light" leftSection={<IconUpload size={14} />} {...props}>
                导入完整备份
              </Button>
            )}
          </FileButton>
        </Group>
        <Text size="xs" c="dimmed" mt={8}>
          完整备份上限 1GB；恢复过程会校验 ZIP 条目数量与解压总量，恢复期间请勿刷新页面。
        </Text>
        {restoreProgress && (
          <div style={{ marginTop: 12 }}>
            <Group justify="space-between" mb={4}>
              <Text size="xs" c="dimmed">
                {restoreProgress.label}
              </Text>
              <Text size="xs" c="dimmed">
                {restoreProgress.percent}%
              </Text>
            </Group>
            <Progress value={restoreProgress.percent} size={8} radius="xl" animated={restoreProgress.percent < 100} />
          </div>
        )}
      </Panel>

      <Panel title="修改我的密码" description="修改后其他设备的会话会自动下线，当前会话保留">
        <Stack gap="sm" style={{ maxWidth: 360 }}>
          <PasswordInput
            label="原密码"
            value={oldPassword}
            onChange={(event) => setOldPassword(event.currentTarget.value)}
            autoComplete="current-password"
          />
          <PasswordInput
            label="新密码（6-64 位）"
            value={newPassword}
            onChange={(event) => setNewPassword(event.currentTarget.value)}
            autoComplete="new-password"
          />
          <Group>
            <Button loading={passwordBusy} onClick={() => void changePassword()}>
              修改密码
            </Button>
            <Text size="xs" c="dimmed">
              当前账号：{user.username}
            </Text>
          </Group>
        </Stack>
      </Panel>

      <Modal opened={quotesOpen} onClose={() => setQuotesOpen(false)} title="自定义语录" size="md">
        <Stack gap="sm">
          <Group align="flex-end" gap={8}>
            <TextInput
              label="新增语录（最多 100 字）"
              value={newQuote}
              maxLength={100}
              onChange={(event) => setNewQuote(event.currentTarget.value)}
              style={{ flex: 1 }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addQuote();
              }}
            />
            <Button onClick={() => void addQuote()}>添加</Button>
          </Group>
          {quotes.length === 0 ? (
            <Alert color="blue" variant="light" icon={<IconAlertTriangle size={15} />}>
              <Text size="xs">尚未添加自定义语录，前台将使用内置语录池。</Text>
            </Alert>
          ) : (
            <Stack gap={6} mah={360} style={{ overflowY: 'auto' }}>
              {quotes.map((item) => (
                <Group
                  key={item.id}
                  justify="space-between"
                  gap={8}
                  style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}
                >
                  <Text size="sm" style={{ flex: 1 }}>{item.text}</Text>
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => void removeQuote(item.id)}>
                    删除
                  </Button>
                </Group>
              ))}
            </Stack>
          )}
          <Text size="xs" c="dimmed">最多保存 100 条；添加自定义语录后，前台不再使用内置语录。</Text>
        </Stack>
      </Modal>

      <Text size="xs" c="dimmed">
        修改时间：{formatDateTime(new Date().toISOString())} · 设置保存后立即生效
        <Badge size="xs" ml={6} variant="light">
          无需重启
        </Badge>
      </Text>
    </div>
  );
}

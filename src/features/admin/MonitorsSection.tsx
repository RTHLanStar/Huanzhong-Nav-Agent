import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowUpRight, IconGripVertical, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatDateTime, formatLatency } from '../../lib/format';
import type { Monitor } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, TableWrap, useLoad } from './shared';

const MONITOR_STATUS: Record<string, { label: string; color: string }> = {
  operational: { label: '正常', color: 'green' },
  outage: { label: '异常', color: 'red' },
  pending: { label: '待检测', color: 'gray' },
  disabled: { label: '已暂停', color: 'gray' },
};

interface UptimeRobotConfig {
  configured: boolean;
  keyHint: string;
  keySource: string;
  days: number;
  updatedAt: string;
  apiUrl: string;
  localMonitors: number;
  historyDays: number;
}

export default function MonitorsSection() {
  const monitors = useLoad<{ monitors: Monitor[] }>('/api/admin/status/monitors');
  const uptime = useLoad<UptimeRobotConfig>('/api/admin/status/uptimerobot');
  const [modal, setModal] = useState<{ id?: string; name: string; url: string; description: string; enabled: boolean; retryOnFail: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [days, setDays] = useState(60);
  const [urBusy, setUrBusy] = useState(false);
  const dragId = useRef('');

  const list = monitors.data?.monitors || [];

  const openCreate = () =>
    setModal({ name: '', url: '', description: '', enabled: true, retryOnFail: false });

  const openEdit = (monitor: Monitor) =>
    setModal({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      description: monitor.description || '',
      enabled: monitor.enabled !== false,
      retryOnFail: Boolean(monitor.retryOnFail),
    });

  const save = async () => {
    if (!modal) return;
    if (!modal.name.trim() || !modal.url.trim()) {
      notifications.show({ message: '名称与网址为必填项', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: modal.name.trim(),
        url: modal.url.trim(),
        description: modal.description.trim(),
        enabled: modal.enabled,
        retryOnFail: modal.retryOnFail,
      };
      if (modal.id) await api(`/api/admin/status/monitors/${encodeURIComponent(modal.id)}`, { method: 'PUT', body });
      else await api('/api/admin/status/monitors', { method: 'POST', body });
      notifications.show({ message: modal.id ? '已保存' : '已添加', color: 'green' });
      setModal(null);
      await Promise.all([monitors.reload(), uptime.reload()]);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const check = async (monitor: Monitor) => {
    try {
      await api(`/api/admin/status/monitors/${encodeURIComponent(monitor.id)}/check`, { method: 'POST' });
      notifications.show({ message: `${monitor.name} 已重新检测`, color: 'blue' });
      await monitors.reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '检测失败', color: 'red' });
    }
  };

  const remove = async (monitor: Monitor) => {
    if (!window.confirm(`确定删除监控项「${monitor.name}」？`)) return;
    try {
      await api(`/api/admin/status/monitors/${encodeURIComponent(monitor.id)}`, { method: 'DELETE' });
      notifications.show({ message: '已删除', color: 'green' });
      await Promise.all([monitors.reload(), uptime.reload()]);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const toggleRetry = async (monitor: Monitor, retryOnFail: boolean) => {
    try {
      await api(`/api/admin/status/monitors/${encodeURIComponent(monitor.id)}`, {
        method: 'PUT',
        body: { retryOnFail },
      });
      await monitors.reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '操作失败', color: 'red' });
    }
  };

  const handleDrop = async (targetId: string) => {
    const from = dragId.current;
    if (!from || from === targetId) return;
    const ids = list.map((item) => item.id);
    const fromIndex = ids.indexOf(from);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, from);
    try {
      await api('/api/admin/status/monitors/reorder', { method: 'PUT', body: { ids } });
      notifications.show({ message: '排序已保存', color: 'green' });
      await monitors.reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '排序失败', color: 'red' });
    }
  };

  const saveUptime = async (clear = false) => {
    setUrBusy(true);
    try {
      const result = await api<{ configured: boolean; keyHint: string; days: number }>(
        '/api/admin/status/uptimerobot',
        {
          method: 'PUT',
          body: clear ? { apiKey: '', days } : { apiKey, days },
        },
      );
      notifications.show({
        message: clear ? '已清除 API Key' : `配置已保存${result.configured ? `（${result.keyHint}）` : ''}`,
        color: 'green',
      });
      setApiKey('');
      await uptime.reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setUrBusy(false);
    }
  };

  const testUptime = async () => {
    setUrBusy(true);
    try {
      const result = await api<{ monitorLimit: number; up: number; down: number; paused: number }>(
        '/api/admin/status/uptimerobot/test',
        { method: 'POST', body: apiKey ? { apiKey } : {} },
      );
      notifications.show({
        message: `连接成功：监控上限 ${result.monitorLimit}，正常 ${result.up}，异常 ${result.down}，暂停 ${result.paused}`,
        color: 'green',
        autoClose: 7000,
      });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '连接失败', color: 'red' });
    } finally {
      setUrBusy(false);
    }
  };

  const config = uptime.data;

  return (
    <div>
      <Panel
        title="网站监控"
        description="每 5 分钟自动检测一次，支持 HTTP/HTTPS；拖拽行首把手可调整状态页顺序"
        extra={
          <Group gap={8}>
            <Button variant="light" size="compact-sm" leftSection={<IconRefresh size={13} />} onClick={() => void monitors.reload()}>
              刷新状态
            </Button>
            <Button size="compact-sm" leftSection={<IconPlus size={13} />} onClick={openCreate}>
              添加监控网站
            </Button>
          </Group>
        }
      >
        {monitors.loading && !monitors.data ? (
          <LoadingBlock />
        ) : monitors.error ? (
          <ErrorBlock message={monitors.error} onRetry={monitors.reload} />
        ) : list.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            暂未添加网站监控
          </Text>
        ) : (
          <TableWrap minWidth={1000}>
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>名称</th>
                <th>网址</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 70 }}>HTTP</th>
                <th style={{ width: 90 }}>延迟</th>
                <th style={{ width: 100 }}>失败重试</th>
                <th style={{ width: 150 }}>最后检测</th>
                <th style={{ width: 170 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((monitor) => {
                const status = MONITOR_STATUS[monitor.status] || MONITOR_STATUS.pending;
                return (
                  <tr
                    key={monitor.id}
                    draggable
                    onDragStart={() => {
                      dragId.current = monitor.id;
                    }}
                    onDragEnd={() => {
                      dragId.current = '';
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(monitor.id);
                    }}
                  >
                    <td style={{ cursor: 'grab', color: 'var(--txt-2)' }}>
                      <IconGripVertical size={15} />
                    </td>
                    <td>
                      <Text size="sm" fw={600}>
                        {monitor.name}
                      </Text>
                      {monitor.description && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {monitor.description}
                        </Text>
                      )}
                    </td>
                    <td className="hz-truncate" style={{ fontSize: 12 }}>
                      {monitor.url}
                    </td>
                    <td>
                      <Badge size="sm" variant="light" color={status.color}>
                        {status.label}
                      </Badge>
                    </td>
                    <td className="hz-mono">{monitor.statusCode || '—'}</td>
                    <td className="hz-mono">{formatLatency(monitor.latency)}</td>
                    <td>
                      <Switch
                        size="xs"
                        checked={Boolean(monitor.retryOnFail)}
                        onChange={(event) => void toggleRetry(monitor, event.currentTarget.checked)}
                        aria-label="失败重试"
                      />
                    </td>
                    <td style={{ fontSize: 12 }}>{monitor.lastChecked ? formatDateTime(monitor.lastChecked) : '—'}</td>
                    <td>
                      <Group gap={4}>
                        <Button size="compact-xs" variant="subtle" onClick={() => void check(monitor)}>
                          检测
                        </Button>
                        <Button size="compact-xs" variant="subtle" onClick={() => openEdit(monitor)}>
                          编辑
                        </Button>
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(monitor)}>
                          <IconTrash size={12} />
                        </Button>
                      </Group>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel
        title="UptimeRobot 数据源"
        description="状态页优先展示 UptimeRobot 真实监控数据；未配置时回退到本地监控"
        extra={
          <Badge variant="light" color={config?.configured ? 'green' : 'gray'}>
            {config?.configured ? `已配置 ${config.keyHint || ''}` : '未配置'}
          </Badge>
        }
      >
        <Stack gap="sm" style={{ maxWidth: 520 }}>
          <TextInput
            label="Read-Only API Key"
            type="password"
            placeholder="粘贴 Read-Only API Key"
            value={apiKey}
            maxLength={128}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            {config?.configured
              ? `当前密钥来源：${config.keySource === 'env' ? '环境变量' : '后台配置'}；${config.keyHint || ''}`
              : '尚未配置。请在 UptimeRobot 后台 Integrations 页面创建 Read-Only API Key。'}
          </Text>
          <Select
            label="统计天数"
            value={String(days)}
            onChange={(value) => setDays(Number(value) || 60)}
            data={[
              { value: '30', label: '30 天' },
              { value: '60', label: '60 天' },
              { value: '90', label: '90 天' },
            ]}
          />
          <Group gap={8}>
            <Button loading={urBusy} onClick={() => void saveUptime(false)}>
              保存配置
            </Button>
            <Button variant="light" loading={urBusy} onClick={() => void testUptime()}>
              测试连接
            </Button>
            <Button variant="subtle" color="red" disabled={!config?.configured} onClick={() => void saveUptime(true)}>
              清除 Key
            </Button>
            <Button
              component="a"
              href="/status"
              target="_blank"
              rel="noopener noreferrer"
              variant="subtle"
              rightSection={<IconArrowUpRight size={13} />}
            >
              查看状态页
            </Button>
          </Group>
          <NumberInput label="统计天数（保存时生效）" value={days} onChange={(value) => setDays(Number(value) || 60)} min={30} max={90} style={{ display: 'none' }} />
        </Stack>
      </Panel>

      <Panel title="使用说明">
        <Text size="sm" c="dimmed" style={{ lineHeight: 1.9 }}>
          返回 2xx/3xx 状态码视为正常；4xx、5xx、超时或连接失败视为异常。系统会自动阻止内网、回环地址和云元数据地址，避免误配置造成安全问题。
        </Text>
      </Panel>

      <Modal opened={Boolean(modal)} onClose={() => setModal(null)} title={modal?.id ? '编辑监控网站' : '添加监控网站'} size="md">
        {modal && (
          <Stack gap="sm">
            <TextInput
              label="名称"
              value={modal.name}
              onChange={(event) => setModal({ ...modal, name: event.currentTarget.value })}
            />
            <TextInput
              label="网址"
              placeholder="https://example.com"
              value={modal.url}
              onChange={(event) => setModal({ ...modal, url: event.currentTarget.value })}
            />
            <TextInput
              label="描述（选填）"
              maxLength={120}
              value={modal.description}
              onChange={(event) => setModal({ ...modal, description: event.currentTarget.value })}
            />
            <Switch
              label="启用该监控"
              checked={modal.enabled}
              onChange={(event) => setModal({ ...modal, enabled: event.currentTarget.checked })}
            />
            <Switch
              label="首次失败自动重试一次"
              checked={modal.retryOnFail}
              onChange={(event) => setModal({ ...modal, retryOnFail: event.currentTarget.checked })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setModal(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

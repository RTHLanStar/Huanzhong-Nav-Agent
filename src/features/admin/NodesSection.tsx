import { useMemo, useState } from 'react';
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
import { IconKey, IconLink, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { NodeRecord } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, TableWrap, useLoad } from './shared';

interface HealthResult {
  ok: boolean;
  degraded?: boolean;
  error?: string;
  latency?: number;
  status?: number;
}

export default function NodesSection() {
  const { data, loading, error, reload } = useLoad<{ nodes: NodeRecord[] }>('/api/admin/nodes');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', capacityMbps: 100 });
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState('');
  const [tokenOpen, setTokenOpen] = useState(false);
  const [connectNode, setConnectNode] = useState<NodeRecord | null>(null);
  const [peerId, setPeerId] = useState('');

  const nodes = data?.nodes || [];

  const addNode = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      notifications.show({ message: '请填写节点名称与地址', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const result = await api<{ token: string }>('/api/admin/nodes', { method: 'POST', body: form });
      setToken(result.token);
      setTokenOpen(true);
      setAddOpen(false);
      setForm({ name: '', baseUrl: '', capacityMbps: 100 });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '添加失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const checkNode = async (node: NodeRecord) => {
    try {
      const result = await api<{ ok: boolean; health: HealthResult }>(
        `/api/admin/nodes/${encodeURIComponent(node.id)}/check`,
        { method: 'POST' },
      );
      notifications.show({
        message: result.ok
          ? `${node.name} 连接正常${result.health?.latency ? `（${result.health.latency}ms）` : ''}`
          : `${node.name} 连接异常：${result.health?.error || '未知原因'}`,
        color: result.ok ? 'green' : 'red',
        autoClose: 6000,
      });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '检测失败', color: 'red' });
    }
  };

  const rotateToken = async (node: NodeRecord) => {
    if (!window.confirm(`轮换「${node.name}」的令牌？旧令牌将立即失效，节点需更新配置后才能连接。`)) return;
    try {
      const result = await api<{ token: string }>(`/api/admin/nodes/${encodeURIComponent(node.id)}/rotate-token`, {
        method: 'POST',
      });
      setToken(result.token);
      setTokenOpen(true);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '轮换失败', color: 'red' });
    }
  };

  const toggleEnabled = async (node: NodeRecord, enabled: boolean) => {
    try {
      await api(`/api/admin/nodes/${encodeURIComponent(node.id)}`, { method: 'PUT', body: { enabled } });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '操作失败', color: 'red' });
    }
  };

  const removeNode = async (node: NodeRecord) => {
    if (!window.confirm(`确定删除节点「${node.name}」？若仍有文件使用该节点，需先迁移文件。`)) return;
    try {
      await api(`/api/admin/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      notifications.show({ message: '节点已删除', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const connect = async () => {
    if (!connectNode || !peerId) return;
    try {
      await api(`/api/admin/nodes/${encodeURIComponent(connectNode.id)}/connect`, {
        method: 'POST',
        body: { peerId },
      });
      notifications.show({ message: '节点已建立连接', color: 'green' });
      setConnectNode(null);
      setPeerId('');
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '连接失败', color: 'red' });
    }
  };

  const peerOptions = useMemo(
    () =>
      nodes
        .filter((node) => node.id !== connectNode?.id)
        .map((node) => ({ value: node.id, label: `${node.name}（${node.baseUrl}）` })),
    [nodes, connectNode?.id],
  );

  return (
    <div>
      <Panel
        title="节点系统"
        description="节点需部署独立 node-agent 并定时心跳；主站按剩余带宽调度文件下载"
        extra={
          <Group gap={8}>
            <Button variant="light" size="compact-sm" leftSection={<IconRefresh size={13} />} onClick={() => void reload()}>
              刷新
            </Button>
            <Button size="compact-sm" leftSection={<IconPlus size={13} />} onClick={() => setAddOpen(true)}>
              添加节点
            </Button>
          </Group>
        }
      >
        {loading && !data ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : nodes.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            暂无节点，请先添加一个可连接的节点。
          </Text>
        ) : (
          <TableWrap minWidth={980}>
            <thead>
              <tr>
                <th>名称</th>
                <th>地址</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 150 }}>容量 / 剩余</th>
                <th style={{ width: 110 }}>活跃任务</th>
                <th style={{ width: 90 }}>节点文件</th>
                <th style={{ width: 120 }}>最后心跳</th>
                <th style={{ width: 300 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>
                    {node.name}
                    {!node.enabled && (
                      <Badge size="xs" ml={4} variant="light" color="gray">
                        已停用
                      </Badge>
                    )}
                  </td>
                  <td className="hz-truncate" style={{ fontSize: 12 }}>
                    {node.baseUrl}
                  </td>
                  <td>
                    <Badge size="sm" variant="light" color={node.online ? 'green' : 'gray'}>
                      {node.online ? '在线' : '离线'}
                    </Badge>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {node.capacityMbps} / {node.freeBandwidthMbps} Mbps
                  </td>
                  <td>{node.activeTasks}</td>
                  <td>{node.files}</td>
                  <td style={{ fontSize: 12 }}>
                    {node.lastHeartbeat ? formatDateTime(new Date(node.lastHeartbeat).toISOString()) : '—'}
                  </td>
                  <td>
                    <Group gap={4}>
                      <Button size="compact-xs" variant="subtle" onClick={() => void checkNode(node)}>
                        检测
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconLink size={11} />}
                        disabled={nodes.length < 2}
                        onClick={() => {
                          setConnectNode(node);
                          setPeerId('');
                        }}
                      >
                        连接
                      </Button>
                      <Button size="compact-xs" variant="subtle" leftSection={<IconKey size={11} />} onClick={() => void rotateToken(node)}>
                        令牌
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        component="a"
                        href={`/api/admin/nodes/${encodeURIComponent(node.id)}/config`}
                      >
                        配置
                      </Button>
                      <Switch
                        size="xs"
                        checked={node.enabled}
                        onChange={(event) => void toggleEnabled(node, event.currentTarget.checked)}
                        aria-label="启用节点"
                      />
                      <Button size="compact-xs" variant="subtle" color="red" onClick={() => void removeNode(node)}>
                        <IconTrash size={12} />
                      </Button>
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="使用说明">
        <Text size="sm" c="dimmed" style={{ lineHeight: 1.9 }}>
          1. 在节点服务器运行 <code>node-agent.js</code>，使用「配置」下载对应 JSON 配置文件；
          <br />
          2. 节点需能被主站访问，并定时向主站心跳上报剩余带宽；
          <br />
          3. 主站会阻止指向内网、回环与云元数据地址的节点，避免 SSRF；
          <br />
          4. 删除节点前请先迁移该节点上的全部文件。
        </Text>
      </Panel>

      <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="添加节点" size="sm">
        <Stack gap="sm">
          <TextInput label="节点名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} />
          <TextInput
            label="节点地址"
            placeholder="https://node.example.com"
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.currentTarget.value })}
          />
          <NumberInput
            label="带宽容量（Mbps）"
            min={0}
            max={1000}
            value={form.capacityMbps}
            onChange={(value) => setForm({ ...form, capacityMbps: Number(value) || 0 })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAddOpen(false)}>取消</Button>
            <Button loading={saving} onClick={() => void addNode()}>添加</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={tokenOpen} onClose={() => setTokenOpen(false)} title="节点令牌" size="md">
        <Stack gap="sm">
          <Text size="sm" c="red">
            令牌仅显示一次，请立即保存到节点配置中。
          </Text>
          <TextInput value={token} readOnly onFocus={(event) => event.currentTarget.select()} />
          <Group justify="flex-end">
            <Button
              variant="light"
              onClick={() => {
                void navigator.clipboard.writeText(token).then(() => notifications.show({ message: '已复制', color: 'green' }));
              }}
            >
              复制令牌
            </Button>
            <Button onClick={() => setTokenOpen(false)}>完成</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(connectNode)} onClose={() => setConnectNode(null)} title="连接节点" size="sm">
        <Stack gap="sm">
          <Text size="sm">
            将「{connectNode?.name}」与另一个节点建立双向连接，连接后调度器可把任务交给任一在线节点。
          </Text>
          <Select label="目标节点" data={peerOptions} value={peerId} onChange={(value) => setPeerId(value || '')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConnectNode(null)}>取消</Button>
            <Button disabled={!peerId} onClick={() => void connect()}>连接</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

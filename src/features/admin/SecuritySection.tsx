import { useState } from 'react';
import { Badge, Button, Group, SimpleGrid, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefresh, IconShieldLock } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/format';
import type { BanRecord, SessionRecord } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, StatCard, TableWrap, useLoad } from './shared';

interface SecurityData {
  overview: {
    todayFail: number;
    todayBanned: number;
    todayRate: number;
    bannedNow: number;
    activeSessions: number;
    activeDownloads: number;
    activeDownloadIps: number;
  };
  rules: {
    maxAttempts: number;
    banDuration: number;
    rateApi: { max: number; window: number };
    rateAuth: { max: number; window: number };
    rateDlStart: { max: number; window: number };
    rateDlStart5: { max: number; window: number };
    maxConcurrentDl: number;
    maxConcurrentDlPerIp: number;
    downloadRate: number;
  };
}

interface DiagnoseData {
  request: Record<string, unknown>;
  geo: Record<string, unknown>;
  access: Record<string, unknown> & { wouldBlock?: boolean; blockType?: string; note?: string };
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join('、') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

const REQUEST_LABELS: Record<string, string> = {
  ip: '服务端识别的客户端 IP',
  remote: 'TCP 远端地址',
  remoteAddress: 'TCP 远端地址',
  xff: 'X-Forwarded-For',
  xForwardedFor: 'X-Forwarded-For',
  xRealIp: 'X-Real-IP',
  trustProxy: 'TRUST_PROXY',
  socket: 'Socket 地址',
};

export default function SecuritySection() {
  const security = useLoad<SecurityData>('/api/admin/security');
  const bans = useLoad<{ bans: BanRecord[] }>('/api/admin/bans');
  const sessions = useLoad<{ sessions: SessionRecord[] }>('/api/admin/sessions');
  const [diagnose, setDiagnose] = useState<DiagnoseData | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const runDiagnose = async () => {
    setDiagnosing(true);
    try {
      const data = await api<DiagnoseData>('/api/admin/ip-diagnose');
      setDiagnose(data);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '诊断失败', color: 'red' });
    } finally {
      setDiagnosing(false);
    }
  };

  const unban = async (ip: string) => {
    try {
      await api(`/api/admin/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
      notifications.show({ message: `已解封 ${ip}`, color: 'green' });
      await Promise.all([bans.reload(), security.reload()]);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '解封失败', color: 'red' });
    }
  };

  const killSession = async (session: SessionRecord) => {
    if (!window.confirm(`确定强制下线「${session.username}」的该会话？`)) return;
    try {
      await api(`/api/admin/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      notifications.show({ message: '会话已下线', color: 'green' });
      await Promise.all([sessions.reload(), security.reload()]);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '操作失败', color: 'red' });
    }
  };

  const overview = security.data?.overview;
  const rules = security.data?.rules;

  return (
    <div>
      {security.loading && !security.data ? (
        <LoadingBlock />
      ) : security.error ? (
        <ErrorBlock message={security.error} onRetry={security.reload} />
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing={12} mb={16}>
          <StatCard label="今日登录失败" value={formatNumber(overview?.todayFail)} />
          <StatCard label="今日触发封禁" value={formatNumber(overview?.todayBanned)} />
          <StatCard label="当前封禁 IP" value={formatNumber(overview?.bannedNow)} />
          <StatCard label="今日限流命中" value={formatNumber(overview?.todayRate)} />
          <StatCard label="活跃会话" value={formatNumber(overview?.activeSessions)} />
          <StatCard label="进行中下载" value={formatNumber(overview?.activeDownloads)} />
        </SimpleGrid>
      )}

      <Panel title="封禁中的 IP" description="登录失败次数超过阈值将自动封禁，可手动解封">
        {bans.loading && !bans.data ? (
          <LoadingBlock />
        ) : bans.error ? (
          <ErrorBlock message={bans.error} onRetry={bans.reload} />
        ) : !bans.data?.bans.length ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            当前没有封禁中的 IP
          </Text>
        ) : (
          <TableWrap minWidth={680}>
            <thead>
              <tr>
                <th>IP</th>
                <th>失败次数</th>
                <th>最后失败</th>
                <th>封禁至</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {bans.data.bans.map((item) => (
                <tr key={item.ip}>
                  <td className="hz-mono">{item.ip}</td>
                  <td>{item.failCount}</td>
                  <td>{formatDateTime(item.lastFail)}</td>
                  <td>{formatDateTime(item.banUntil)}</td>
                  <td>
                    <Button size="compact-xs" variant="subtle" onClick={() => void unban(item.ip)}>
                      解封
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel
        title="活跃会话"
        description="修改/重置密码会自动下线对应账号的会话，也可在此手动下线"
        extra={
          <Button size="compact-sm" variant="subtle" leftSection={<IconRefresh size={13} />} onClick={() => void sessions.reload()}>
            刷新
          </Button>
        }
      >
        {sessions.loading && !sessions.data ? (
          <LoadingBlock />
        ) : sessions.error ? (
          <ErrorBlock message={sessions.error} onRetry={sessions.reload} />
        ) : !sessions.data?.sessions.length ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            暂无活跃会话
          </Text>
        ) : (
          <TableWrap minWidth={760}>
            <thead>
              <tr>
                <th>账号</th>
                <th>IP</th>
                <th>登录时间</th>
                <th>过期时间</th>
                <th style={{ width: 110 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.sessions.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.username}
                    {item.self && (
                      <Badge size="xs" ml={6} variant="light">
                        当前会话
                      </Badge>
                    )}
                  </td>
                  <td className="hz-mono">{item.ip}</td>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td>{formatDateTime(item.expiresAt)}</td>
                  <td>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      disabled={item.self}
                      onClick={() => void killSession(item)}
                    >
                      强制下线
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel
        title="当前请求 IP 诊断"
        description="用于排查海外/机房 IP 未拦截：显示服务器实际收到的地址、代理头与最终判定"
        extra={
          <Button size="compact-sm" variant="light" loading={diagnosing} leftSection={<IconShieldLock size={13} />} onClick={() => void runDiagnose()}>
            开始检测
          </Button>
        }
      >
        {!diagnose ? (
          <Text size="sm" c="dimmed">
            点击「开始检测」获取当前请求的 IP、代理头与地理判定结果。
          </Text>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <Text size="sm" fw={600} mb={4}>
              请求信息
            </Text>
            {Object.entries(diagnose.request).map(([key, value]) => (
              <div key={key} style={{ color: 'var(--txt-2)' }}>
                {REQUEST_LABELS[key] || key}：<span style={{ color: 'var(--txt)' }}>{renderValue(value)}</span>
              </div>
            ))}
            <Text size="sm" fw={600} mt={10} mb={4}>
              地理与风险判定
            </Text>
            {Object.entries(diagnose.geo).map(([key, value]) => (
              <div key={key} style={{ color: 'var(--txt-2)' }}>
                {key}：<span style={{ color: 'var(--txt)' }}>{renderValue(value)}</span>
              </div>
            ))}
            <Text size="sm" fw={600} mt={10} mb={4}>
              拦截结论
            </Text>
            <div>
              <Badge color={diagnose.access.wouldBlock ? 'red' : 'green'} variant="light">
                {diagnose.access.wouldBlock ? `会被拦截（${diagnose.access.blockType}）` : '不会拦截'}
              </Badge>
            </div>
            <Text size="xs" c="dimmed" mt={4}>
              {diagnose.access.note}
            </Text>
          </div>
        )}
      </Panel>

      <Panel title="当前防护规则">
        {!rules ? (
          <Text size="sm" c="dimmed">
            暂无规则数据
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={4}>
            <Text size="sm" c="dimmed">
              登录失败封禁阈值：{rules.maxAttempts} 次
            </Text>
            <Text size="sm" c="dimmed">
              封禁时长：{Math.round(rules.banDuration / 60000)} 分钟
            </Text>
            <Text size="sm" c="dimmed">
              全局 API 限流：{rules.rateApi.max} 次 / {Math.round(rules.rateApi.window / 1000)} 秒
            </Text>
            <Text size="sm" c="dimmed">
              登录接口限流：{rules.rateAuth.max} 次 / {Math.round(rules.rateAuth.window / 1000)} 秒
            </Text>
            <Text size="sm" c="dimmed">
              下载发起限流：{rules.rateDlStart.max} 次 / {Math.round(rules.rateDlStart.window / 1000)} 秒
            </Text>
            <Text size="sm" c="dimmed">
              下载长窗口限流：{rules.rateDlStart5.max} 次 / {Math.round(rules.rateDlStart5.window / 60000)} 分钟
            </Text>
            <Text size="sm" c="dimmed">
              并发下载上限：{rules.maxConcurrentDl}（单 IP {rules.maxConcurrentDlPerIp}）
            </Text>
            <Text size="sm" c="dimmed">
              下载限速：{rules.downloadRate > 0 ? `${formatBytes(rules.downloadRate)}/s` : '不限速'}
            </Text>
          </SimpleGrid>
        )}
      </Panel>
    </div>
  );
}

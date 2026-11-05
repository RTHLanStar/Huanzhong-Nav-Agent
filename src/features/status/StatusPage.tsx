import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Badge, Button, Group, Loader, Progress, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import {
  IconActivityHeartbeat,
  IconArrowLeft,
  IconChecks,
  IconClock,
  IconMoon,
  IconRefresh,
  IconSun,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { api } from '../../lib/api';
import BrandLogo from '../../components/BrandLogo';
import {
  formatDateTime,
  formatInterval,
  formatLatency,
  formatPercent,
  formatRelative,
  formatShortDate,
} from '../../lib/format';
import { useApp } from '../../components/AppProviders';
import type { StatusComponent, StatusPayload } from '../../lib/types';

const STATUS_META: Record<
  StatusPayload['status'],
  { label: string; color: string; className: string }
> = {
  operational: { label: '全部服务运行正常', color: 'green', className: 'is-ok' },
  degraded: { label: '部分服务性能下降', color: 'yellow', className: 'is-warn' },
  outage: { label: '存在服务异常', color: 'red', className: 'is-danger' },
  unknown: { label: '暂无监控数据', color: 'gray', className: 'is-muted' },
};

const COMPONENT_STATUS: Record<StatusComponent['status'], { label: string; color: string }> = {
  up: { label: '运行正常', color: 'green' },
  down: { label: '服务异常', color: 'red' },
  degraded: { label: '性能下降', color: 'yellow' },
  paused: { label: '已暂停', color: 'gray' },
  unknown: { label: '状态未知', color: 'gray' },
};

function ringColor(status: StatusPayload['status']): string {
  if (status === 'operational') return '#22c55e';
  if (status === 'degraded') return '#f59e0b';
  if (status === 'outage') return '#ef4444';
  return '#94a3b8';
}

export default function StatusPage() {
  const { colorScheme, toggleColorScheme, info } = useApp();
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    setRefreshing(force);
    try {
      const payload = await api<StatusPayload>(`/api/status${force ? '?refresh=1' : ''}`);
      setData(payload);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态数据加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (data?.name) document.title = `${data.name} · 运行状态`;
  }, [data?.name]);

  const meta = STATUS_META[data?.status || 'unknown'];
  const summary = data?.summary;
  const uptime = summary?.uptime ?? null;
  const ringPercent = uptime === null ? 0 : Math.max(0, Math.min(100, uptime));
  const siteName = data?.name || info?.siteName || '幻终の导航';

  const totalDays = useMemo(
    () => (data?.components || []).reduce((sum, component) => sum + (component.days?.length || 0), 0),
    [data?.components],
  );

  return (
    <div className="hz-shell">
      <header className="hz-header">
        <div className="hz-container hz-header-inner">
          <a className="hz-brand" href="/">
            <BrandLogo />
            <div>
              <div className="hz-brand-title">{siteName}</div>
              <div style={{ fontSize: 11, color: 'var(--txt-2)' }}>运行状态中心</div>
            </div>
          </a>
          <div className="hz-actions">
            <Tooltip label="返回首页" withArrow>
              <a className="hz-icon-btn" href="/" aria-label="返回首页">
                <IconArrowLeft size={18} />
              </a>
            </Tooltip>
            <Tooltip label={colorScheme === 'dark' ? '切换浅色' : '切换深色'} withArrow>
              <button className="hz-icon-btn" type="button" onClick={toggleColorScheme} aria-label="切换主题">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </button>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="hz-container" style={{ flex: 1 }}>
        <section
          className="hz-status-hero"
          aria-live="polite"
          style={{ borderColor: data ? `color-mix(in srgb, ${ringColor(data.status)} 35%, var(--line))` : undefined }}
        >
          <div style={{ flex: 1, minWidth: 260 }}>
            <Group gap={7} mb={6}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: ringColor(data?.status || 'unknown'),
                  display: 'inline-block',
                }}
              />
              <Text size="xs" c="dimmed" fw={600} style={{ letterSpacing: '0.12em' }}>
                SYSTEM STATUS
              </Text>
            </Group>
            <Title order={2} style={{ fontSize: 26 }}>
              {loading ? '正在获取运行状态' : data?.statusLabel || meta.label}
            </Title>
            <Text size="sm" c="dimmed" mt={6}>
              {loading
                ? '正在连接监控服务，请稍候…'
                : data
                  ? `${summary?.up || 0} / ${summary?.total || 0} 个监控项运行正常，共统计 ${data.days} 天可用率。`
                  : '暂时无法获取状态数据。'}
            </Text>
            <Group gap={8} mt={12}>
              <Badge variant="light" color={data?.source === 'local' ? 'gray' : 'blue'}>
                {data?.source === 'uptimerobot'
                  ? 'UptimeRobot'
                  : data?.source === 'cache'
                    ? '缓存数据'
                    : data?.source === 'local'
                      ? '本站本地探测'
                      : '正在连接'}
              </Badge>
              {data?.fetchedAt && (
                <Text size="xs" c="dimmed">
                  更新于 {formatDateTime(data.fetchedAt)} · {formatRelative(data.fetchedAt)}
                </Text>
              )}
              {data?.cacheAge !== undefined && data.cacheAge > 0 && (
                <Text size="xs" c="dimmed">
                  （缓存 {data.cacheAge}s）
                </Text>
              )}
            </Group>
          </div>
          <div
            className="hz-status-ring"
            style={
              {
                '--p': ringPercent,
                '--ring-color': ringColor(data?.status || 'unknown'),
              } as CSSProperties
            }
            aria-hidden
          >
            <div>
              <div>
                <strong>{uptime === null ? '—' : formatPercent(uptime)}</strong>
                <br />
                <span>平均可用率</span>
              </div>
            </div>
          </div>
        </section>

        {(data?.warning || error) && (
          <div
            style={{
              marginTop: 14,
              padding: '11px 16px',
              borderRadius: 14,
              border: '1px solid var(--line)',
              background: 'var(--accent-soft)',
              fontSize: 13,
            }}
          >
            {error || data?.warning}
          </div>
        )}

        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing={12} mt={18} mb={20}>
          {[
            { label: '监控总数', value: summary?.total ?? '—', sub: `${totalDays} 天历史` },
            { label: '运行正常', value: summary?.up ?? '—', sub: `${summary?.unknown || 0} 个未知` },
            { label: '异常服务', value: summary?.down ?? '—', sub: `${summary?.degraded || 0} 个降级` },
            { label: '平均可用率', value: uptime === null ? '—' : formatPercent(uptime), sub: `近 ${data?.days || 30} 天` },
          ].map((item) => (
            <div className="hz-stat" key={item.label}>
              <div className="hz-stat-label">{item.label}</div>
              <div className="hz-stat-value">{item.value}</div>
              <div style={{ fontSize: 11, color: 'var(--txt-2)', marginTop: 2 }}>{item.sub}</div>
            </div>
          ))}
        </SimpleGrid>

        <section style={{ marginBottom: 24 }}>
          <Group justify="space-between" mb={12}>
            <Text fw={600}>监控项目</Text>
            <Group gap={8}>
              <Text size="xs" c="dimmed">
                每 60 秒自动刷新
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                loading={refreshing}
                leftSection={<IconRefresh size={13} />}
                onClick={() => void load(true)}
              >
                刷新
              </Button>
            </Group>
          </Group>

          {loading ? (
            <Stack align="center" py="xl" gap={8}>
              <Loader size="sm" />
              <Text size="xs" c="dimmed">
                正在加载监控数据…
              </Text>
            </Stack>
          ) : (data?.components?.length || 0) === 0 ? (
            <div className="hz-panel" style={{ textAlign: 'center', color: 'var(--txt-2)' }}>
              <IconActivityHeartbeat size={36} style={{ opacity: 0.4 }} />
              <Text size="sm" mt={8}>
                暂未配置监控项
              </Text>
            </div>
          ) : (
            <div className="hz-status-grid">
              {data!.components.map((component) => {
                const statusMeta = COMPONENT_STATUS[component.status];
                return (
                  <div className="hz-monitor" key={component.id}>
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                      <div style={{ minWidth: 0 }}>
                        <Text fw={600} size="sm" lineClamp={1}>
                          {component.name}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {component.description || '监控项目'}
                        </Text>
                      </div>
                      <Badge size="sm" variant="light" color={statusMeta.color} style={{ flexShrink: 0 }}>
                        {component.statusLabel || statusMeta.label}
                      </Badge>
                    </Group>

                    <div className="hz-bars" aria-label="每日可用率">
                      {component.days.map((day) => {
                        const empty = day.uptime === null;
                        const down = !empty && Number(day.uptime) < 100;
                        return (
                          <div
                            key={day.date}
                            className={`hz-bar${empty ? ' is-empty' : down ? ' is-down' : ''}`}
                            title={`${formatShortDate(day.date)}：${
                              empty ? '暂无数据' : `可用率 ${formatPercent(day.uptime)}`
                            }`}
                          />
                        );
                      })}
                    </div>

                    <Group justify="space-between" gap={6}>
                      <Text size="xs" c="dimmed">
                        可用率 <strong style={{ color: 'var(--txt)' }}>{formatPercent(component.uptime)}</strong>
                      </Text>
                      <Text size="xs" c="dimmed">
                        延迟 <strong style={{ color: 'var(--txt)' }}>{formatLatency(component.latency)}</strong>
                      </Text>
                    </Group>
                    <Group justify="space-between" gap={6} mt={4}>
                      <Text size="xs" c="dimmed">
                        <IconClock size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                        {formatInterval(component.interval)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {component.lastChecked ? formatRelative(component.lastChecked) : '等待检测'}
                      </Text>
                    </Group>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {(data?.incidents?.length || 0) > 0 && (
          <section style={{ marginBottom: 24 }}>
            <Group justify="space-between" mb={8}>
              <Text fw={600}>近期事件</Text>
              <Text size="xs" c="dimmed">
                最近 {data!.incidents.length} 条
              </Text>
            </Group>
            <div className="hz-panel">
              {data!.incidents.map((incident) => (
                <div className="hz-incident" key={incident.id}>
                  <IconAlertTriangle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600}>
                      {incident.monitorName || '监控项'} · 宕机事件
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatDateTime(incident.startedAt)} ·{' '}
                      {incident.ongoing ? '持续中' : `持续 ${formatInterval(incident.duration)}`}
                      {incident.reason ? ` · ${incident.reason}` : ''}
                    </Text>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {(summary?.total || 0) > 0 && (
          <>
            <Progress
              value={uptime ?? 0}
              size={4}
              radius="xl"
              color={data?.status === 'outage' ? 'red' : 'green'}
            />
            <Text size="xs" c="dimmed" ta="center" mt={6}>
              {data?.status === 'operational' ? '所有监控项目运行正常' : meta.label} · 数据更新于{' '}
              {formatDateTime(data?.checkedAt)}
            </Text>
          </>
        )}
      </main>

      <footer className="hz-footer">
        <Group justify="center" gap={8}>
          <IconChecks size={13} />
          <span>
            数据来源：{data?.source === 'local' ? '本站本地探测' : data?.source === 'cache' ? '缓存数据' : 'UptimeRobot'}
          </span>
          <span>·</span>
          <span>{data?.fetchedAt ? formatRelative(data.fetchedAt) : '等待首次更新'}</span>
          <span>·</span>
          <a href="/" style={{ marginLeft: 0 }}>
            返回导航
          </a>
        </Group>
      </footer>
    </div>
  );
}

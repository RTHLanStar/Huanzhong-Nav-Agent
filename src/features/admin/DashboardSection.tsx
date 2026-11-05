import { Alert, Badge, Group, SimpleGrid, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/format';
import type { AdminStats } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, StatCard, TableWrap, useLoad } from './shared';
import { Heatmap, TrendChart } from './Chart';

interface SecurityOverview {
  overview: {
    todayFail: number;
    todayBanned: number;
    todayRate: number;
    bannedNow: number;
    activeSessions: number;
    activeDownloads: number;
    activeDownloadIps: number;
  };
}

export default function DashboardSection() {
  const stats = useLoad<AdminStats>('/api/admin/stats');
  const security = useLoad<SecurityOverview>('/api/admin/security');

  if (stats.loading && !stats.data) return <LoadingBlock label="正在加载统计数据…" />;
  if (stats.error && !stats.data) return <ErrorBlock message={stats.error} onRetry={stats.reload} />;

  const totals = stats.data?.totals;
  const overview = security.data?.overview;

  return (
    <div>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing={12} mb={16}>
        <StatCard label="引导页数量" value={formatNumber(totals?.sites)} />
        <StatCard label="累计访问" value={formatNumber(totals?.visits)} />
        <StatCard label="今日访问" value={formatNumber(totals?.today)} />
        <StatCard label="共享文件数" value={formatNumber(totals?.files)} />
        <StatCard label="文件累计下载" value={formatNumber(totals?.fileDownloads)} />
        <StatCard label="管理员账号" value={formatNumber(totals?.users)} />
        <StatCard label="今日独立访客" value={formatNumber(totals?.todayVisitors)} />
        <StatCard label="今日登录失败" value={formatNumber(overview?.todayFail)} />
        <StatCard label="封禁中 IP" value={formatNumber(overview?.bannedNow)} />
        <StatCard label="活跃会话" value={formatNumber(overview?.activeSessions)} />
      </SimpleGrid>

      {(stats.data?.deadLinks?.length || 0) > 0 && (
        <Panel title={<Text fw={600} c="red">⚠ 死链告警（以下引导页最近检测异常）</Text>}>
          <TableWrap minWidth={620}>
            <thead>
              <tr>
                <th>名称</th>
                <th>链接</th>
                <th>原因</th>
                <th>检测时间</th>
              </tr>
            </thead>
            <tbody>
              {stats.data!.deadLinks.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td className="hz-truncate">
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.url}
                    </a>
                  </td>
                  <td style={{ color: 'var(--txt-2)' }}>{item.detail || '无法访问'}</td>
                  <td>{formatDateTime(item.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Panel>
      )}

      <Panel title="近 14 天访问趋势">
        {stats.data?.trend?.length ? <TrendChart data={stats.data.trend} /> : <Text size="sm" c="dimmed">暂无数据</Text>}
      </Panel>

      <Panel title="访问热力图" description="最近统计天数 × 24 小时的访问分布">
        {stats.data?.heatmap?.length ? <Heatmap data={stats.data.heatmap} /> : <Text size="sm" c="dimmed">暂无数据</Text>}
      </Panel>

      <Panel title="近 14 天独立访客趋势">
        {stats.data?.visitorTrend?.length ? (
          <TrendChart data={stats.data.visitorTrend} />
        ) : (
          <Text size="sm" c="dimmed">暂无数据</Text>
        )}
      </Panel>

      <Panel title="访问来源 Top10">
        {(stats.data?.referrers?.length || 0) === 0 ? (
          <Text size="sm" c="dimmed">暂无来源数据（访客从外部链接进入时自动记录来源域名）</Text>
        ) : (
          <TableWrap minWidth={480}>
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>来源域名</th>
                <th>累计次数</th>
              </tr>
            </thead>
            <tbody>
              {stats.data!.referrers.map((item, index) => (
                <tr key={item.host}>
                  <td>{index + 1}</td>
                  <td>{item.host}</td>
                  <td className="hz-mono">{formatNumber(item.count)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="访问排行">
        <TableWrap minWidth={680}>
          <thead>
            <tr>
              <th style={{ width: 48 }}>#</th>
              <th>名称</th>
              <th>链接</th>
              <th>累计访问</th>
              <th>今日访问</th>
            </tr>
          </thead>
          <tbody>
            {(stats.data?.ranking || []).map((item, index) => (
              <tr key={item.id}>
                <td>{index + 1}</td>
                <td>{item.name}</td>
                <td className="hz-truncate">
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.url}
                  </a>
                </td>
                <td className="hz-mono">{formatNumber(item.total)}</td>
                <td className="hz-mono">{formatNumber(item.today)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Panel>

      <Panel title="热门文件 Top10（按下载量）">
        {(stats.data?.fileRanking?.length || 0) === 0 ? (
          <Text size="sm" c="dimmed">还没有共享文件</Text>
        ) : (
          <TableWrap minWidth={640}>
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>文件名</th>
                <th>大小</th>
                <th>累计下载</th>
                <th>上传时间</th>
              </tr>
            </thead>
            <tbody>
              {stats.data!.fileRanking.map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>{item.name}</td>
                  <td>{formatBytes(item.size)}</td>
                  <td className="hz-mono">{formatNumber(item.downloads)}</td>
                  <td>{formatDateTime(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      {security.error && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
          <Group gap={8}>
            <Text size="xs">安全概览加载失败：{security.error}</Text>
            <Badge size="xs" variant="light">
              不影响其他统计
            </Badge>
          </Group>
        </Alert>
      )}
    </div>
  );
}

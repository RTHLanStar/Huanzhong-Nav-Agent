import { useMemo, useState } from 'react';
import { Badge, Button, Group, Select, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { LogsResponse } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, TableWrap, useLoad } from './shared';

const CATEGORIES = [
  { value: '', label: '全部操作分类' },
  { value: 'ip', label: 'IP 拦截' },
  { value: 'site', label: '网站与内容变更' },
  { value: 'file', label: '文件管理' },
  { value: 'account', label: '账号与安全' },
  { value: 'system', label: '系统设置' },
  { value: 'other', label: '其他操作' },
];

const RESULT_META: Record<string, { label: string; color: string }> = {
  success: { label: '成功', color: 'green' },
  fail: { label: '失败', color: 'red' },
  banned: { label: '封禁', color: 'orange' },
};

export default function LogsSection() {
  const [type, setType] = useState<'login' | 'operation'>('login');
  const [result, setResult] = useState('');
  const [category, setCategory] = useState('');
  const [keyword, setKeyword] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState({ keyword: '', from: '', to: '', result: '', category: '' });
  const pageSize = 20;

  const query = useMemo(() => {
    const params = new URLSearchParams({ type, page: String(page), pageSize: String(pageSize) });
    if (applied.keyword) params.set('keyword', applied.keyword);
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (type === 'login' && applied.result) params.set('result', applied.result);
    if (type === 'operation' && applied.category) params.set('category', applied.category);
    return params.toString();
  }, [type, page, applied]);

  const { data, loading, error, reload } = useLoad<LogsResponse>(`/api/admin/logs?${query}`);

  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / pageSize));

  const apply = () => {
    setPage(1);
    setApplied({ keyword: keyword.trim(), from, to, result, category });
  };

  const reset = () => {
    setKeyword('');
    setFrom('');
    setTo('');
    setResult('');
    setCategory('');
    setPage(1);
    setApplied({ keyword: '', from: '', to: '', result: '', category: '' });
  };

  const exportLogs = (format: 'csv' | 'json') => {
    const params = new URLSearchParams({ type, format });
    if (applied.keyword) params.set('keyword', applied.keyword);
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (type === 'login' && applied.result) params.set('result', applied.result);
    if (type === 'operation' && applied.category) params.set('category', applied.category);
    window.location.href = `/api/admin/logs/export?${params.toString()}`;
  };

  const clearLogs = async () => {
    if (!window.confirm(`确定清空${type === 'login' ? '登录日志' : '操作日志'}？该操作不可撤销。`)) return;
    try {
      await api('/api/admin/logs/clear', { method: 'POST', body: { type } });
      notifications.show({ message: '日志已清空', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '清空失败', color: 'red' });
    }
  };

  return (
    <Panel>
      <div className="hz-toolbar">
        <Select
          value={type}
          onChange={(value) => {
            setType(value === 'operation' ? 'operation' : 'login');
            setPage(1);
            setApplied({ keyword: '', from: '', to: '', result: '', category: '' });
          }}
          data={[
            { value: 'login', label: '登录日志' },
            { value: 'operation', label: '操作日志' },
          ]}
          w={140}
        />
        {type === 'login' ? (
          <Select
            value={result}
            onChange={(value) => setResult(value || '')}
            data={[
              { value: '', label: '全部结果' },
              { value: 'success', label: '成功' },
              { value: 'fail', label: '失败' },
              { value: 'banned', label: '封禁' },
            ]}
            w={140}
          />
        ) : (
          <Select value={category} onChange={(value) => setCategory(value || '')} data={CATEGORIES} w={180} />
        )}
        <TextInput
          placeholder="关键词（用户名/IP/操作…）"
          value={keyword}
          onChange={(event) => setKeyword(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply();
          }}
          w={220}
        />
        <TextInput
          type="date"
          value={from}
          onChange={(event) => setFrom(event.currentTarget.value)}
          w={150}
          aria-label="开始日期"
        />
        <Text size="xs" c="dimmed">
          至
        </Text>
        <TextInput
          type="date"
          value={to}
          onChange={(event) => setTo(event.currentTarget.value)}
          w={150}
          aria-label="结束日期"
        />
        <Button size="compact-sm" onClick={apply}>
          筛选
        </Button>
        <Button size="compact-sm" variant="subtle" onClick={reset}>
          重置
        </Button>
        <Button size="compact-sm" variant="light" leftSection={<IconDownload size={13} />} onClick={() => exportLogs('csv')}>
          导出 CSV
        </Button>
        <Button size="compact-sm" variant="light" leftSection={<IconDownload size={13} />} onClick={() => exportLogs('json')}>
          导出 JSON
        </Button>
        <Button size="compact-sm" variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={() => void clearLogs()}>
          清空此类日志
        </Button>
        <Button size="compact-sm" variant="subtle" leftSection={<IconRefresh size={13} />} onClick={() => void reload()}>
          刷新
        </Button>
      </div>

      <Text size="xs" c="dimmed" mb={8}>
        共 {data?.total || 0} 条记录 · 时间统一按中国上海时区（UTC+8）展示与导出
      </Text>

      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.list.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          没有符合条件的日志
        </Text>
      ) : (
        <TableWrap minWidth={type === 'login' ? 760 : 860}>
          {type === 'login' ? (
            <>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>时间</th>
                  <th style={{ width: 150 }}>用户名</th>
                  <th style={{ width: 140 }}>IP</th>
                  <th style={{ width: 90 }}>结果</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {data.list.map((raw, index) => {
                  const item = raw as { time: string; username: string; ip: string; result: string; detail: string };
                  const meta = RESULT_META[item.result] || { label: item.result, color: 'gray' };
                  return (
                    <tr key={`${item.time}-${index}`}>
                      <td>{formatDateTime(item.time)}</td>
                      <td>{item.username || '—'}</td>
                      <td className="hz-mono">{item.ip}</td>
                      <td>
                        <Badge size="sm" color={meta.color} variant="light">
                          {meta.label}
                        </Badge>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--txt-2)' }}>{item.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>时间</th>
                  <th style={{ width: 130 }}>管理员</th>
                  <th style={{ width: 130 }}>IP</th>
                  <th style={{ width: 140 }}>分类</th>
                  <th style={{ width: 160 }}>操作</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {data.list.map((raw, index) => {
                  const item = raw as {
                    time: string;
                    user: string;
                    ip: string;
                    category?: string;
                    action: string;
                    detail: string;
                  };
                  const categoryLabel =
                    CATEGORIES.find((entry) => entry.value === item.category)?.label || item.category || '其他操作';
                  return (
                    <tr key={`${item.time}-${index}`}>
                      <td>{formatDateTime(item.time)}</td>
                      <td>{item.user || '—'}</td>
                      <td className="hz-mono">{item.ip || '—'}</td>
                      <td>
                        <Badge size="sm" variant="light">
                          {categoryLabel.replace('全部操作分类', '其他操作')}
                        </Badge>
                      </td>
                      <td>{item.action}</td>
                      <td style={{ fontSize: 12, color: 'var(--txt-2)' }}>{item.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          )}
        </TableWrap>
      )}

      <Group justify="space-between" mt={12}>
        <Text size="xs" c="dimmed">
          第 {data?.page || page} / {totalPages} 页
        </Text>
        <Group gap={6}>
          <Button
            size="compact-sm"
            variant="default"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            下一页
          </Button>
        </Group>
      </Group>
    </Panel>
  );
}

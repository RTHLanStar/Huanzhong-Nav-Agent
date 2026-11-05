import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { api } from '../../lib/api';

/** 后台通用数据加载：失败时展示错误并提供重试，不阻塞页面其余部分。 */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const result = await api<T>(path);
      setData(result);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, loading, error, reload };
}

export function Panel({
  title,
  extra,
  children,
  description,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <section className="hz-panel">
      {(title || extra) && (
        <Group justify="space-between" align="center" mb={10} wrap="wrap" gap={8}>
          <div>
            {title && <Text fw={600}>{title}</Text>}
            {description && (
              <Text size="xs" c="dimmed" mt={2}>
                {description}
              </Text>
            )}
          </div>
          {extra}
        </Group>
      )}
      {children}
    </section>
  );
}

export function TableWrap({ children, minWidth = 640 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="hz-table-wrap">
      <table className="hz-table" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function EmptyTip({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <Text size="sm" c="dimmed" ta="center" py="md">
      {children}
    </Text>
  );
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <Stack align="center" py="lg" gap={8}>
      <Loader size="sm" />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
      <Group justify="space-between" gap={8}>
        <Text size="sm">{message}</Text>
        {onRetry && (
          <Button size="compact-xs" variant="light" color="red" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
            重试
          </Button>
        )}
      </Group>
    </Alert>
  );
}

export function RoleBadge({ role, label }: { role: string; label?: string }) {
  const color =
    role === 'owner' ? 'violet' : role === 'admin' ? 'blue' : role === 'user' ? 'teal' : 'gray';
  return (
    <Badge size="sm" variant="light" color={color}>
      {label || role}
    </Badge>
  );
}

export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="hz-stat">
      <div className="hz-stat-label">{label}</div>
      <div className="hz-stat-value">{value}</div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--txt-2)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

export function confirmAction(message: string): boolean {
  return window.confirm(message);
}

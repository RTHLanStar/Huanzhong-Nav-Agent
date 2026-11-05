import { useState } from 'react';
import { Badge, Button, Group, Modal, PasswordInput, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconKey, IconPlus, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { encryptPassword } from '../../lib/rsa';
import { formatDateTime } from '../../lib/format';
import type { AdminUser, BanRecord, CurrentUser, UserRole } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, RoleBadge, TableWrap, useLoad } from './shared';

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'owner', label: '站长' },
  { value: 'admin', label: '管理员' },
  { value: 'user', label: '用户' },
  { value: 'guest', label: '访客' },
];

export default function UsersSection({ user }: { user: CurrentUser }) {
  const users = useLoad<{ isOwner: boolean; users: AdminUser[] }>('/api/admin/users');
  const bans = useLoad<{ bans: BanRecord[] }>('/api/admin/bans');
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'user' as UserRole });
  const [createBusy, setCreateBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  const isOwner = Boolean(users.data?.isOwner);

  const refreshAll = async () => {
    await Promise.all([users.reload(), bans.reload()]);
  };

  const createUser = async () => {
    if (!createForm.username.trim() || !createForm.password) {
      notifications.show({ message: '请填写用户名与密码', color: 'red' });
      return;
    }
    setCreateBusy(true);
    try {
      const password = await encryptPassword(createForm.password);
      await api('/api/admin/users', {
        method: 'POST',
        body: { username: createForm.username.trim(), password, role: createForm.role },
      });
      notifications.show({ message: '账号已创建', color: 'green' });
      setCreateOpen(false);
      setCreateForm({ username: '', password: '', role: 'user' });
      await refreshAll();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '创建失败', color: 'red' });
    } finally {
      setCreateBusy(false);
    }
  };

  const changeRole = async (target: AdminUser, role: UserRole) => {
    if (role === target.role) return;
    const warning =
      role === 'owner'
        ? `将「${target.username}」设为站长后，你的角色将降为管理员，确定继续？`
        : `确定将「${target.username}」的角色改为「${ROLE_OPTIONS.find((item) => item.value === role)?.label}」？`;
    if (!window.confirm(warning)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(target.id)}/role`, { method: 'PUT', body: { role } });
      notifications.show({ message: '角色已更新', color: 'green' });
      await refreshAll();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '修改失败', color: 'red' });
    }
  };

  const resetPassword = async () => {
    if (!resetTarget || !newPassword) {
      notifications.show({ message: '请输入新密码', color: 'red' });
      return;
    }
    setResetBusy(true);
    try {
      const password = await encryptPassword(newPassword);
      await api(`/api/admin/users/${encodeURIComponent(resetTarget.id)}/password`, {
        method: 'PUT',
        body: { password },
      });
      notifications.show({ message: '密码已重置，该账号所有会话已下线', color: 'green' });
      setResetTarget(null);
      setNewPassword('');
      await refreshAll();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '重置失败', color: 'red' });
    } finally {
      setResetBusy(false);
    }
  };

  const removeUser = async (target: AdminUser) => {
    if (!window.confirm(`确定删除账号「${target.username}」？该账号的全部会话将立即失效。`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      notifications.show({ message: '账号已删除', color: 'green' });
      await refreshAll();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const unban = async (ip: string) => {
    try {
      await api(`/api/admin/bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
      notifications.show({ message: `已解封 ${ip}`, color: 'green' });
      await bans.reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '解封失败', color: 'red' });
    }
  };

  return (
    <div>
      <Panel
        title="账号管理"
        description="站长拥有全部权限并可管理角色；管理员可操作后台；用户仅可使用前台；访客无任何访问权限"
        extra={
          <Button leftSection={<IconUserPlus size={14} />} onClick={() => setCreateOpen(true)}>
            新建账号
          </Button>
        }
      >
        {users.loading && !users.data ? (
          <LoadingBlock />
        ) : users.error ? (
          <ErrorBlock message={users.error} onRetry={users.reload} />
        ) : (
          <TableWrap minWidth={760}>
            <thead>
              <tr>
                <th>用户名</th>
                <th style={{ width: 150 }}>角色</th>
                <th style={{ width: 170 }}>创建时间</th>
                <th style={{ width: 170 }}>来源</th>
                <th style={{ width: 200 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {(users.data?.users || []).map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.username}
                    {item.self && (
                      <Badge size="xs" ml={6} variant="light">
                        当前登录
                      </Badge>
                    )}
                  </td>
                  <td>
                    {isOwner ? (
                      <Select
                        size="xs"
                        value={item.role}
                        data={ROLE_OPTIONS}
                        onChange={(value) => value && void changeRole(item, value as UserRole)}
                        disabled={item.self}
                        styles={{ input: { height: 28 } }}
                      />
                    ) : (
                      <RoleBadge role={item.role} label={item.roleLabel} />
                    )}
                  </td>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td style={{ fontSize: 12, color: 'var(--txt-2)' }}>{item.createdBy || '—'}</td>
                  <td>
                    <Group gap={4}>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconKey size={12} />}
                        onClick={() => {
                          setResetTarget(item);
                          setNewPassword('');
                        }}
                      >
                        重置密码
                      </Button>
                      {!item.self && (
                        <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconTrash size={12} />} onClick={() => void removeUser(item)}>
                          删除
                        </Button>
                      )}
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="当前封禁的 IP" description="登录失败次数超过阈值将自动封禁；可在此手动解封">
        {bans.loading && !bans.data ? (
          <LoadingBlock />
        ) : bans.error ? (
          <ErrorBlock message={bans.error} onRetry={bans.reload} />
        ) : !bans.data?.bans.length ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            当前没有封禁中的 IP
          </Text>
        ) : (
          <TableWrap minWidth={620}>
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

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="新建账号" size="sm">
        <Stack gap="sm">
          <TextInput
            label="用户名"
            value={createForm.username}
            onChange={(event) => setCreateForm({ ...createForm, username: event.currentTarget.value })}
            placeholder="2-20 位中文、字母、数字或下划线"
          />
          <PasswordInput
            label="初始密码"
            value={createForm.password}
            onChange={(event) => setCreateForm({ ...createForm, password: event.currentTarget.value })}
            placeholder="6-64 位"
          />
          <Select
            label="角色"
            value={createForm.role}
            onChange={(value) => setCreateForm({ ...createForm, role: (value as UserRole) || 'user' })}
            data={isOwner ? ROLE_OPTIONS : ROLE_OPTIONS.filter((item) => item.value !== 'owner')}
          />
          <Text size="xs" c="dimmed">
            新账号首次登录后可自行使用；如创建为访客，需由站长提升角色后才能访问前台。
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button loading={createBusy} leftSection={<IconPlus size={13} />} onClick={() => void createUser()}>
              创建
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(resetTarget)} onClose={() => setResetTarget(null)} title="重置账号密码" size="sm">
        <Stack gap="sm">
          <Text size="sm">
            账号：<strong>{resetTarget?.username}</strong>
          </Text>
          <PasswordInput
            label="新密码"
            value={newPassword}
            onChange={(event) => setNewPassword(event.currentTarget.value)}
            placeholder="6-64 位"
          />
          <Text size="xs" c="dimmed">
            重置后该账号的所有在线会话将立即下线。
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button loading={resetBusy} onClick={() => void resetPassword()}>
              确认重置
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Text size="xs" c="dimmed">
        当前登录：{user.username}（{user.roleLabel || user.role}）
      </Text>
    </div>
  );
}

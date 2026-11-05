import { useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRefresh } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { Announcement, CommentItem, Countdown, FeedbackItem, FriendLink, QqGroup } from '../../lib/types';
import { confirmAction } from './shared';
import { ErrorBlock, LoadingBlock, Panel, TableWrap, useLoad } from './shared';

function useDelete(path: string, reload: () => Promise<void>, what: string) {
  return async (id: string, label?: string) => {
    if (!confirmAction(`确定删除${what}${label ? `「${label}」` : ''}？`)) return;
    try {
      await api(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      notifications.show({ message: '已删除', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };
}

/* ============================ 公告 ============================ */

export function AnnouncementsSection() {
  const { data, loading, error, reload } = useLoad<{ announcements: Announcement[] }>('/api/admin/announcements');
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', pinned: false, startAt: '', endAt: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const remove = useDelete('/api/admin/announcements', reload, '公告');

  const open = (item?: Announcement) => {
    setEditing(item || null);
    setModalOpen(true);
    setForm({
      title: item?.title || '',
      content: item?.content || '',
      pinned: Boolean(item?.pinned),
      startAt: item?.startAt ? item.startAt.slice(0, 16) : '',
      endAt: item?.endAt ? item.endAt.slice(0, 16) : '',
    });
    setFormError('');
  };

  const save = async () => {
    if (!form.content.trim()) {
      setFormError('公告内容不能为空');
      return;
    }
    setSaving(true);
    try {
      const body = {
        title: form.title.trim(),
        content: form.content.trim(),
        pinned: form.pinned,
        startAt: form.startAt || '',
        endAt: form.endAt || '',
      };
      if (editing) await api(`/api/admin/announcements/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
      else await api('/api/admin/announcements', { method: 'POST', body });
      notifications.show({ message: editing ? '已保存' : '已发布', color: 'green' });
      setEditing(null);
      setModalOpen(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const state = (item: Announcement) => {
    const now = new Date().toISOString();
    if (item.startAt && now < item.startAt) return <Badge color="yellow" variant="light">未开始</Badge>;
    if (item.endAt && now > item.endAt) return <Badge color="gray" variant="light">已结束</Badge>;
    return <Badge color="green" variant="light">生效中</Badge>;
  };

  return (
    <Panel
      title="公告管理"
      description="前台公告条与右上角入口会展示生效中的公告；置顶公告优先显示"
      extra={
        <Button leftSection={<IconPlus size={14} />} onClick={() => open()}>
          发布公告
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.announcements.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无公告，点击「发布公告」开始吧
        </Text>
      ) : (
        <TableWrap minWidth={760}>
          <thead>
            <tr>
              <th style={{ width: 84 }}>状态</th>
              <th style={{ width: 180 }}>标题</th>
              <th>内容</th>
              <th style={{ width: 150 }}>更新时间</th>
              <th style={{ width: 140 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.announcements.map((item) => (
              <tr key={item.id}>
                <td>{state(item)}</td>
                <td>
                  {item.title || '站点公告'}
                  {item.pinned && (
                    <Badge size="xs" ml={4} variant="light">
                      置顶
                    </Badge>
                  )}
                </td>
                <td style={{ maxWidth: 360, fontSize: 12, color: 'var(--txt-2)' }}>{item.content}</td>
                <td>{formatDateTime(item.updatedAt)}</td>
                <td>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="subtle" onClick={() => open(item)}>
                      编辑
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(item.id, item.title)}>
                      删除
                    </Button>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={modalOpen} onClose={() => {
        setModalOpen(false);
        setEditing(null);
        setForm({ title: '', content: '', pinned: false, startAt: '', endAt: '' });
      }} title={editing ? '编辑公告' : '发布公告'} size="md">
        <Stack gap="sm">
          <TextInput
            label="标题"
            maxLength={60}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
          />
          <Textarea
            label="内容"
            required
            minRows={4}
            maxLength={2000}
            value={form.content}
            onChange={(event) => setForm({ ...form, content: event.currentTarget.value })}
          />
          <Switch
            label="置顶显示"
            checked={form.pinned}
            onChange={(event) => setForm({ ...form, pinned: event.currentTarget.checked })}
          />
          <Group grow>
            <TextInput
              label="定时上线"
              type="datetime-local"
              value={form.startAt}
              onChange={(event) => setForm({ ...form, startAt: event.currentTarget.value })}
            />
            <TextInput
              label="定时下线"
              type="datetime-local"
              value={form.endAt}
              onChange={(event) => setForm({ ...form, endAt: event.currentTarget.value })}
            />
          </Group>
          {formError && (
            <Text size="xs" c="red">
              {formError}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => {
              setModalOpen(false);
              setEditing(null);
              setForm({ title: '', content: '', pinned: false, startAt: '', endAt: '' });
            }}>
              取消
            </Button>
            <Button loading={saving} onClick={() => void save()}>
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Panel>
  );
}

/* ============================ QQ 群 ============================ */

export function QqGroupsSection() {
  const { data, loading, error, reload } = useLoad<{ groups: QqGroup[] }>('/api/admin/qqgroups');
  const [form, setForm] = useState<{ id?: string; name: string; url: string; order: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useDelete('/api/admin/qqgroups', reload, 'QQ 群');

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.url.trim()) {
      notifications.show({ message: '群名称与加群链接为必填项', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const body = { name: form.name.trim(), url: form.url.trim(), order: form.order };
      if (form.id) await api(`/api/admin/qqgroups/${encodeURIComponent(form.id)}`, { method: 'PUT', body });
      else await api('/api/admin/qqgroups', { method: 'POST', body });
      notifications.show({ message: '已保存', color: 'green' });
      setForm(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="QQ 群管理"
      description="前台右上角 QQ 群按钮展示这些群；可直接填群号或完整加群链接"
      extra={
        <Button leftSection={<IconPlus size={14} />} onClick={() => setForm({ name: '', url: '', order: 0 })}>
          添加 QQ 群
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.groups.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无 QQ 群
        </Text>
      ) : (
        <TableWrap minWidth={640}>
          <thead>
            <tr>
              <th style={{ width: 60 }}>排序</th>
              <th style={{ width: 180 }}>群名称</th>
              <th>加群链接 / 群号</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <tr key={group.id}>
                <td>{group.order || 0}</td>
                <td>{group.name}</td>
                <td className="hz-truncate">{group.url}</td>
                <td>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="subtle" onClick={() => setForm({ ...group, order: group.order || 0 })}>
                      编辑
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(group.id, group.name)}>
                      删除
                    </Button>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={Boolean(form)} onClose={() => setForm(null)} title={form?.id ? '编辑 QQ 群' : '添加 QQ 群'} size="sm">
        {form && (
          <Stack gap="sm">
            <TextInput
              label="群名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <TextInput
              label="加群链接 / 群号"
              placeholder="https://qm.qq.com/... 或 123456789"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.currentTarget.value })}
            />
            <NumberInput
              label="排序值"
              value={form.order}
              onChange={(value) => setForm({ ...form, order: Number(value) || 0 })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Panel>
  );
}

/* ============================ 留言 ============================ */

export function CommentsSection() {
  const { data, loading, error, reload } = useLoad<{ comments: CommentItem[] }>('/api/admin/comments');
  const [reply, setReply] = useState<{ item: CommentItem; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useDelete('/api/admin/comments', reload, '留言');

  const saveReply = async () => {
    if (!reply) return;
    setSaving(true);
    try {
      await api(`/api/admin/comments/${encodeURIComponent(reply.item.id)}`, {
        method: 'PUT',
        body: { reply: reply.text.trim() },
      });
      notifications.show({ message: '回复已保存', color: 'green' });
      setReply(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="留言管理"
      description="访客在前台「留言板」提交的内容；可回复（前台可见）或删除"
      extra={
        <Button variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void reload()}>
          刷新
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.comments.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无留言
        </Text>
      ) : (
        <TableWrap minWidth={860}>
          <thead>
            <tr>
              <th style={{ width: 110 }}>昵称</th>
              <th>留言内容</th>
              <th style={{ width: 120 }}>IP</th>
              <th style={{ width: 150 }}>时间</th>
              <th>管理员回复</th>
              <th style={{ width: 130 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.comments.map((item) => (
              <tr key={item.id}>
                <td>{item.nick || '匿名访客'}</td>
                <td style={{ maxWidth: 320, fontSize: 12 }}>{item.content}</td>
                <td style={{ fontSize: 11, color: 'var(--txt-2)' }}>{item.ip || '—'}</td>
                <td>{formatDateTime(item.createdAt)}</td>
                <td style={{ maxWidth: 240, fontSize: 12, color: 'var(--txt-2)' }}>{item.reply || '—'}</td>
                <td>
                  <Group gap={4}>
                    <Button size="compact-xs" variant="subtle" onClick={() => setReply({ item, text: item.reply || '' })}>
                      回复
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(item.id)}>
                      删除
                    </Button>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={Boolean(reply)} onClose={() => setReply(null)} title="回复留言" size="md">
        {reply && (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {reply.item.nick || '匿名访客'}：{reply.item.content}
            </Text>
            <Textarea
              label="回复内容"
              minRows={3}
              maxLength={500}
              value={reply.text}
              onChange={(event) => setReply({ ...reply, text: event.currentTarget.value })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReply(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void saveReply()}>
                保存回复
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Panel>
  );
}

/* ============================ 反馈 ============================ */

const FEEDBACK_STATUS: Record<string, { label: string; color: string }> = {
  open: { label: '待处理', color: 'yellow' },
  processing: { label: '处理中', color: 'blue' },
  resolved: { label: '已解决', color: 'green' },
};

export function FeedbacksSection() {
  const { data, loading, error, reload } = useLoad<{ feedbacks: FeedbackItem[] }>('/api/admin/feedbacks');
  const [handle, setHandle] = useState<{ item: FeedbackItem; reply: string; status: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useDelete('/api/admin/feedbacks', reload, '反馈');

  const save = async () => {
    if (!handle) return;
    setSaving(true);
    try {
      await api(`/api/admin/feedbacks/${encodeURIComponent(handle.item.id)}`, {
        method: 'PUT',
        body: { reply: handle.reply.trim(), status: handle.status },
      });
      notifications.show({ message: '已更新', color: 'green' });
      setHandle(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="反馈管理"
      description="访客通过前台「意见反馈」提交；可回复并标记处理状态"
      extra={
        <Button variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void reload()}>
          刷新
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.feedbacks.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无反馈
        </Text>
      ) : (
        <TableWrap minWidth={900}>
          <thead>
            <tr>
              <th style={{ width: 120 }}>联系方式</th>
              <th>反馈内容</th>
              <th style={{ width: 110 }}>IP</th>
              <th style={{ width: 150 }}>时间</th>
              <th style={{ width: 90 }}>状态</th>
              <th>回复</th>
              <th style={{ width: 120 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.feedbacks.map((item) => {
              const meta = FEEDBACK_STATUS[item.status || 'open'] || FEEDBACK_STATUS.open;
              return (
                <tr key={item.id}>
                  <td style={{ fontSize: 12 }}>{item.contact || '—'}</td>
                  <td style={{ maxWidth: 300, fontSize: 12 }}>{item.content}</td>
                  <td style={{ fontSize: 11, color: 'var(--txt-2)' }}>{item.ip || '—'}</td>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td>
                    <Badge size="sm" color={meta.color} variant="light">
                      {meta.label}
                    </Badge>
                  </td>
                  <td style={{ maxWidth: 220, fontSize: 12, color: 'var(--txt-2)' }}>{item.reply || '—'}</td>
                  <td>
                    <Group gap={4}>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() =>
                          setHandle({ item, reply: item.reply || '', status: item.status || 'open' })
                        }
                      >
                        处理
                      </Button>
                      <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(item.id)}>
                        删除
                      </Button>
                    </Group>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={Boolean(handle)} onClose={() => setHandle(null)} title="处理反馈" size="md">
        {handle && (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {handle.item.content}
            </Text>
            <Select
              label="处理状态"
              value={handle.status}
              onChange={(value) => setHandle({ ...handle, status: value || 'open' })}
              data={[
                { value: 'open', label: '待处理' },
                { value: 'processing', label: '处理中' },
                { value: 'resolved', label: '已解决' },
              ]}
            />
            <Textarea
              label="回复内容"
              minRows={3}
              maxLength={500}
              value={handle.reply}
              onChange={(event) => setHandle({ ...handle, reply: event.currentTarget.value })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setHandle(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Panel>
  );
}

/* ============================ 倒计时 ============================ */

export function CountdownsSection() {
  const { data, loading, error, reload } = useLoad<{ countdowns: Countdown[] }>('/api/admin/countdowns');
  const [form, setForm] = useState<{ name: string; date: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useDelete('/api/admin/countdowns', reload, '倒计时');

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.date) {
      notifications.show({ message: '请填写名称与目标日期', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      await api('/api/admin/countdowns', { method: 'POST', body: form });
      notifications.show({ message: '已添加', color: 'green' });
      setForm(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '添加失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="倒计时管理"
      description="前台时钟下方展示未过期的倒计时，最多 10 条"
      extra={
        <Button leftSection={<IconPlus size={14} />} onClick={() => setForm({ name: '', date: '' })}>
          添加倒计时
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.countdowns.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无倒计时
        </Text>
      ) : (
        <TableWrap minWidth={600}>
          <thead>
            <tr>
              <th>名称</th>
              <th style={{ width: 140 }}>目标日期</th>
              <th style={{ width: 120 }}>剩余</th>
              <th style={{ width: 90 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.countdowns.map((item) => {
              const target = new Date(`${item.date}T00:00:00`).getTime();
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const days = Math.round((target - today.getTime()) / 86_400_000);
              return (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.date}</td>
                  <td>{days === 0 ? '就是今天' : `${days} 天`}</td>
                  <td>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(item.id, item.name)}>
                      删除
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={Boolean(form)} onClose={() => setForm(null)} title="添加倒计时" size="sm">
        {form && (
          <Stack gap="sm">
            <TextInput
              label="名称"
              maxLength={30}
              placeholder="如：春节"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <TextInput
              label="目标日期"
              type="date"
              value={form.date}
              onChange={(event) => setForm({ ...form, date: event.currentTarget.value })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Panel>
  );
}

/* ============================ 友情链接 ============================ */

export function FriendLinksSection() {
  const { data, loading, error, reload } = useLoad<{ links: FriendLink[] }>('/api/admin/friendlinks');
  const [form, setForm] = useState<{ id?: string; name: string; url: string; order: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useDelete('/api/admin/friendlinks', reload, '友链');

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.url.trim()) {
      notifications.show({ message: '名称与链接为必填项', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const body = { name: form.name.trim(), url: form.url.trim(), order: form.order };
      if (form.id) await api(`/api/admin/friendlinks/${encodeURIComponent(form.id)}`, { method: 'PUT', body });
      else await api('/api/admin/friendlinks', { method: 'POST', body });
      notifications.show({ message: '已保存', color: 'green' });
      setForm(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="友链管理"
      description="前台「友情链接」专区展示这些合作站点，按排序值升序"
      extra={
        <Button leftSection={<IconPlus size={14} />} onClick={() => setForm({ name: '', url: '', order: 0 })}>
          添加友链
        </Button>
      }
    >
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data?.links.length ? (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          暂无友链
        </Text>
      ) : (
        <TableWrap minWidth={680}>
          <thead>
            <tr>
              <th style={{ width: 60 }}>排序</th>
              <th style={{ width: 180 }}>名称</th>
              <th>链接</th>
              <th style={{ width: 150 }}>添加时间</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.links.map((link) => (
              <tr key={link.id}>
                <td>{link.order || 0}</td>
                <td>{link.name}</td>
                <td className="hz-truncate">{link.url}</td>
                <td>{formatDateTime(link.createdAt)}</td>
                <td>
                  <Group gap={4}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setForm({ id: link.id, name: link.name, url: link.url, order: link.order || 0 })}
                    >
                      编辑
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(link.id, link.name)}>
                      删除
                    </Button>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <Modal opened={Boolean(form)} onClose={() => setForm(null)} title={form?.id ? '编辑友链' : '添加友链'} size="sm">
        {form && (
          <Stack gap="sm">
            <TextInput
              label="名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <TextInput
              label="链接"
              placeholder="https://example.com"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.currentTarget.value })}
            />
            <NumberInput
              label="排序值"
              value={form.order}
              onChange={(value) => setForm({ ...form, order: Number(value) || 0 })}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Panel>
  );
}


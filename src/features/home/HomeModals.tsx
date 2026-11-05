import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMessage2 } from '@tabler/icons-react';
import { api, ApiError } from '../../lib/api';
import type { Announcement, CommentItem, QqGroup } from '../../lib/types';
import type { Prefs } from './homeTypes';

export function AnnouncementsModal({
  opened,
  onClose,
  items,
}: {
  opened: boolean;
  onClose: () => void;
  items: Announcement[];
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="站点公告" size="lg">
      {items.length === 0 ? (
        <Text c="dimmed" ta="center" py="lg" size="sm">
          暂无公告
        </Text>
      ) : (
        <Stack gap={8}>
          {items.map((item) => (
            <div key={item.id} className={`hz-list-item${item.pinned ? ' is-pinned' : ''}`}>
              <div className="hz-list-head">
                <span className="hz-list-title">{item.title || '站点公告'}</span>
                {item.pinned && <span className="hz-suggest-tag">置顶</span>}
                <span className="hz-list-time">{item.updatedAt ? item.updatedAt.slice(0, 16).replace('T', ' ') : ''}</span>
              </div>
              <div className="hz-list-body">{item.content}</div>
            </div>
          ))}
        </Stack>
      )}
    </Modal>
  );
}

export function QqModal({
  opened,
  onClose,
  groups,
}: {
  opened: boolean;
  onClose: () => void;
  groups: QqGroup[];
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="加入 QQ 群" size="sm">
      {groups.length === 0 ? (
        <Text c="dimmed" ta="center" py="lg" size="sm">
          暂无 QQ 群
        </Text>
      ) : (
        <Stack gap={8}>
          {groups.map((group) => (
            <Anchor
              key={group.id}
              href={group.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hz-list-item"
              style={{ display: 'flex', alignItems: 'center', gap: 10 }}
              underline="never"
            >
              <IconMessage2 size={20} color="var(--accent)" />
              <span style={{ flex: 1 }}>
                <Text size="sm" fw={600}>
                  {group.name}
                </Text>
                <Text size="xs" c="dimmed">
                  点击加入该群
                </Text>
              </span>
              <Text c="dimmed">›</Text>
            </Anchor>
          ))}
        </Stack>
      )}
    </Modal>
  );
}

export function CommentsModal({
  opened,
  onClose,
  maxLen,
}: {
  opened: boolean;
  onClose: () => void;
  maxLen: number;
}) {
  const [items, setItems] = useState<CommentItem[]>([]);
  const [content, setContent] = useState('');
  const [nick, setNick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [captchaId, setCaptchaId] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);
  const captchaInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ comments: CommentItem[] }>('/api/comments');
      setItems(data.comments || []);
    } catch {
      /* 加载失败时保留现有列表 */
    }
  }, []);

  const refreshCaptcha = useCallback(async () => {
    try {
      const data = await api<{ captchaId: string }>('/api/captcha/new');
      if (data.captchaId) {
        setCaptchaId(data.captchaId);
        setCaptchaAnswer('');
        setTimeout(() => captchaInputRef.current?.focus(), 30);
      }
    } catch {
      setError('验证码获取失败，请重试');
    }
  }, []);

  useEffect(() => {
    if (!opened) return;
    setError('');
    void load();
  }, [opened, load]);

  const submit = async () => {
    setError('');
    const text = content.trim();
    if (!text) {
      setError('留言内容不能为空');
      return;
    }
    if (text.length > maxLen) {
      setError(`留言内容不能超过 ${maxLen} 字`);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { nick: nick.trim(), content: text };
      if (captchaId) {
        body.captchaId = captchaId;
        body.captchaAnswer = captchaAnswer.trim();
      }
      await api('/api/comments', { method: 'POST', body });
      setContent('');
      setCaptchaId('');
      setCaptchaAnswer('');
      setShowCaptcha(false);
      notifications.show({ message: '留言成功', color: 'green' });
      await load();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.data?.requireCaptcha) {
        setShowCaptcha(true);
        await refreshCaptcha();
        setError(apiError.message !== 'need_captcha' ? apiError.message : '请先完成安全验证');
      } else {
        setError(err instanceof Error ? err.message : '留言失败，请稍后再试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="留言板" size="lg">
      <Stack gap="sm">
        <Textarea
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          maxLength={maxLen}
          minRows={3}
          placeholder={`说点什么吧…（最多 ${maxLen} 字）`}
        />
        <TextInput
          value={nick}
          onChange={(event) => setNick(event.currentTarget.value)}
          maxLength={20}
          placeholder="昵称（选填，最多 20 字）"
        />
        {showCaptcha && (
          <Group gap="xs" align="center">
            {captchaId && (
              <img
                src={`/api/captcha/img?c=${encodeURIComponent(captchaId)}&t=${Date.now()}`}
                alt="验证码"
                title="看不清？点击换一张"
                onClick={() => void refreshCaptcha()}
                style={{ height: 40, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--line)', background: '#fff' }}
              />
            )}
            <TextInput
              ref={captchaInputRef}
              value={captchaAnswer}
              onChange={(event) => setCaptchaAnswer(event.currentTarget.value)}
              maxLength={4}
              placeholder="验证码"
              style={{ flex: 1 }}
            />
          </Group>
        )}
        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}
        <Group justify="space-between" align="center">
          <Text size="xs" c="dimmed">
            {content.length} / {maxLen}
          </Text>
          <Button loading={busy} onClick={() => void submit()}>
            发布留言
          </Button>
        </Group>

        <Text size="sm" fw={600} mt="xs">
          全部留言（{items.length}）
        </Text>
        {items.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="md">
            还没有留言，来说第一句吧
          </Text>
        ) : (
          <Stack gap={8} mah={360} style={{ overflowY: 'auto' }}>
            {items.map((item) => (
              <div key={item.id} className="hz-list-item">
                <div className="hz-list-head">
                  <span className="hz-list-title">{item.nick || '匿名访客'}</span>
                  <span className="hz-list-time">{item.createdAt ? item.createdAt.slice(0, 16).replace('T', ' ') : ''}</span>
                </div>
                <div className="hz-list-body" style={{ color: 'var(--txt)' }}>
                  {item.content}
                </div>
                {item.reply && (
                  <div className="hz-list-body" style={{ marginTop: 6, color: 'var(--accent)' }}>
                    <strong>管理员回复：</strong>
                    {item.reply}
                  </div>
                )}
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

export function FeedbackModal({
  opened,
  onClose,
  maxLen,
}: {
  opened: boolean;
  onClose: () => void;
  maxLen: number;
}) {
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [captchaId, setCaptchaId] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);

  const refreshCaptcha = useCallback(async () => {
    try {
      const data = await api<{ captchaId: string }>('/api/captcha/new');
      if (data.captchaId) {
        setCaptchaId(data.captchaId);
        setCaptchaAnswer('');
      }
    } catch {
      setError('验证码获取失败，请重试');
    }
  }, []);

  const submit = async () => {
    setError('');
    const text = content.trim();
    if (!text) {
      setError('反馈内容不能为空');
      return;
    }
    if (text.length > maxLen) {
      setError(`反馈内容不能超过 ${maxLen} 字`);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { contact: contact.trim(), content: text };
      if (captchaId) {
        body.captchaId = captchaId;
        body.captchaAnswer = captchaAnswer.trim();
      }
      await api('/api/feedback', { method: 'POST', body });
      setContent('');
      setContact('');
      setCaptchaId('');
      setShowCaptcha(false);
      notifications.show({ message: '反馈已提交，感谢你的建议', color: 'green' });
      onClose();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.data?.requireCaptcha) {
        setShowCaptcha(true);
        await refreshCaptcha();
        setError(apiError.message !== 'need_captcha' ? apiError.message : '请先完成安全验证');
      } else {
        setError(err instanceof Error ? err.message : '提交失败，请稍后再试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="意见反馈" size="md">
      <Stack gap="sm">
        <Textarea
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          maxLength={maxLen}
          minRows={4}
          placeholder={`说说你的建议或遇到的问题…（最多 ${maxLen} 字）`}
        />
        <TextInput
          value={contact}
          onChange={(event) => setContact(event.currentTarget.value)}
          maxLength={40}
          placeholder="联系方式（选填，方便回复你）"
        />
        {showCaptcha && (
          <Group gap="xs">
            {captchaId && (
              <img
                src={`/api/captcha/img?c=${encodeURIComponent(captchaId)}&t=${Date.now()}`}
                alt="验证码"
                onClick={() => void refreshCaptcha()}
                style={{ height: 40, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--line)', background: '#fff' }}
              />
            )}
            <TextInput
              value={captchaAnswer}
              onChange={(event) => setCaptchaAnswer(event.currentTarget.value)}
              maxLength={4}
              placeholder="验证码"
              style={{ flex: 1 }}
            />
          </Group>
        )}
        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end">
          <Button loading={busy} onClick={() => void submit()}>
            提交反馈
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function PrefsModal({
  opened,
  onClose,
  prefs,
  onChange,
  onReset,
  onExport,
  onImport,
}: {
  opened: boolean;
  onClose: () => void;
  prefs: Prefs;
  onChange: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  onReset: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const rows: { key: keyof Prefs; label: string; options: { value: string; label: string }[] }[] = [
    {
      key: 'layout',
      label: '卡片布局',
      options: [
        { value: 'large', label: '大卡片' },
        { value: 'compact', label: '紧凑小卡' },
        { value: 'list', label: '列表' },
      ],
    },
    {
      key: 'font',
      label: '字号',
      options: [
        { value: 's', label: '小' },
        { value: 'm', label: '中' },
        { value: 'l', label: '大' },
      ],
    },
    {
      key: 'motion',
      label: '悬浮动效',
      options: [
        { value: 'on', label: '开启' },
        { value: 'off', label: '关闭（简洁）' },
      ],
    },
    {
      key: 'radius',
      label: '卡片圆角',
      options: [
        { value: 'on', label: '圆润' },
        { value: 'off', label: '方正' },
      ],
    },
    {
      key: 'order',
      label: '卡片排序',
      options: [
        { value: 'default', label: '默认（按后台排序）' },
        { value: 'custom', label: '自定义（已拖拽调整）' },
      ],
    },
  ];

  return (
    <Modal opened={opened} onClose={onClose} title="偏好设置" size="md">
      <Stack gap={4}>
        {rows.map((row) => (
          <div className="hz-prefs-row" key={row.key}>
            <span className="hz-prefs-label">{row.label}</span>
            {row.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`hz-pref-opt${prefs[row.key] === option.value ? ' is-active' : ''}`}
                onClick={() => onChange(row.key, option.value as never)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ))}
        <Group gap={8} mt="sm">
          <Button variant="light" size="xs" onClick={onExport}>
            导出个人偏好
          </Button>
          <Button variant="light" size="xs" component="label">
            导入个人偏好
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) onImport(file);
              }}
            />
          </Button>
          <Button variant="subtle" color="red" size="xs" onClick={onReset}>
            恢复全部默认
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={6}>
          偏好与收藏、最近使用保存在本机浏览器中；导出的 JSON 文件可带到其他设备导入。
        </Text>
      </Stack>
    </Modal>
  );
}

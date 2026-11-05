import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconExternalLink,
  IconGripVertical,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { api, uploadIcon } from '../../lib/api';
import { formatNumber, safeImage, safeUrl } from '../../lib/format';
import { downloadBlob } from '../../lib/storage';
import type { SiteAdmin } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, TableWrap, useLoad } from './shared';

interface SiteForm {
  id: string;
  name: string;
  url: string;
  desc: string;
  category: string;
  icon: string;
  order: number;
  enabled: boolean;
}

const EMPTY_FORM: SiteForm = {
  id: '',
  name: '',
  url: '',
  desc: '',
  category: '',
  icon: '',
  order: 0,
  enabled: true,
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

function csvToSites(text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((item) => item.trim().toLowerCase());
  const column = (name: string) => header.indexOf(name);
  return rows.slice(1).map((row) => ({
    name: column('name') >= 0 ? row[column('name')]?.trim() : '',
    url: column('url') >= 0 ? row[column('url')]?.trim() : '',
    desc: column('desc') >= 0 ? row[column('desc')]?.trim() : '',
    category: column('category') >= 0 ? row[column('category')]?.trim() : '',
    icon: column('icon') >= 0 ? row[column('icon')]?.trim() : '',
  }));
}

export default function SitesSection() {
  const { data, loading, error, reload } = useLoad<{ sites: SiteAdmin[] }>('/api/admin/sites');
  const [form, setForm] = useState<SiteForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const dragId = useRef('');

  const sites = data?.sites || [];

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setFormError('');
  };

  const openEdit = (site: SiteAdmin) => {
    setForm({
      id: site.id,
      name: site.name,
      url: site.url,
      desc: site.desc || '',
      category: site.category || '',
      icon: site.icon || '',
      order: Number(site.order) || 0,
      enabled: site.enabled !== false,
    });
    setFormError('');
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.url.trim()) {
      setFormError('名称与链接为必填项');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const body = {
        name: form.name.trim(),
        url: form.url.trim(),
        desc: form.desc.trim(),
        category: form.category.trim(),
        icon: form.icon.trim(),
        order: form.order,
        enabled: form.enabled,
      };
      if (form.id) await api(`/api/admin/sites/${encodeURIComponent(form.id)}`, { method: 'PUT', body });
      else await api('/api/admin/sites', { method: 'POST', body });
      notifications.show({ message: form.id ? '已保存' : '已添加', color: 'green' });
      setForm(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (site: SiteAdmin) => {
    if (!window.confirm(`确定删除引导页「${site.name}」？该操作不可撤销。`)) return;
    try {
      await api(`/api/admin/sites/${encodeURIComponent(site.id)}`, { method: 'DELETE' });
      notifications.show({ message: '已删除', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const refreshIcon = async (site: SiteAdmin) => {
    try {
      const result = await api<{ icon?: string }>(`/api/admin/sites/${encodeURIComponent(site.id)}/refresh-icon`, {
        method: 'POST',
      });
      notifications.show({
        message: result.icon ? '图标已更新' : '未能抓取到图标',
        color: result.icon ? 'green' : 'yellow',
      });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '刷新图标失败', color: 'red' });
    }
  };

  const checkLinks = async () => {
    setChecking(true);
    try {
      const result = await api<{ total: number; dead: number }>('/api/admin/sites/check-links', { method: 'POST' });
      notifications.show({
        message: `检测完成：共 ${result.total} 个，异常 ${result.dead} 个`,
        color: result.dead ? 'yellow' : 'green',
      });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '检测失败', color: 'red' });
    } finally {
      setChecking(false);
    }
  };

  const importFile = async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      let rows: Record<string, string>[] = [];
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) rows = parsed as Record<string, string>[];
        else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sites?: unknown }).sites)) {
          rows = (parsed as { sites: Record<string, string>[] }).sites;
        }
      } else {
        rows = csvToSites(text);
      }
      if (!rows.length) {
        notifications.show({ message: '文件中没有可导入的数据', color: 'red' });
        return;
      }
      const result = await api<{ added: number; failed: number; errors: { row: number; name: string; reason: string }[] }>(
        '/api/admin/sites/import',
        { method: 'POST', body: { sites: rows } },
      );
      notifications.show({
        message: `导入完成：成功 ${result.added} 条，失败 ${result.failed} 条`,
        color: result.failed ? 'yellow' : 'green',
      });
      if (result.errors?.length) {
        notifications.show({
          message: result.errors
            .slice(0, 3)
            .map((item) => `第 ${item.row} 行 ${item.name}：${item.reason}`)
            .join('；'),
          color: 'yellow',
          autoClose: 8000,
        });
      }
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '导入失败', color: 'red' });
    } finally {
      setImporting(false);
    }
  };

  const saveOrder = useCallback(
    async (ids: string[]) => {
      try {
        await api('/api/admin/sites/reorder', { method: 'PUT', body: { ids } });
        notifications.show({ message: '排序已保存', color: 'green' });
        await reload();
      } catch (err) {
        notifications.show({ message: err instanceof Error ? err.message : '排序保存失败', color: 'red' });
      }
    },
    [reload],
  );

  const handleDrop = (targetId: string) => {
    const from = dragId.current;
    if (!from || from === targetId) return;
    const ids = sites.map((site) => site.id);
    const fromIndex = ids.indexOf(from);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, from);
    void saveOrder(ids);
  };

  const statusBadge = (site: SiteAdmin) => {
    if (site.linkStatus === 'dead') {
      return (
        <Tooltip label={site.linkDetail || '链接异常'} withArrow>
          <Badge color="red" size="sm" variant="light">
            异常
          </Badge>
        </Tooltip>
      );
    }
    if (site.linkStatus === 'ok') {
      return (
        <Badge color="green" size="sm" variant="light">
          正常
        </Badge>
      );
    }
    return (
      <Badge color="gray" size="sm" variant="light">
        未检测
      </Badge>
    );
  };

  const example = useMemo(
    () => [
      { name: '示例站点', url: 'https://example.com', desc: '示例描述', category: '工具', icon: '' },
      { name: 'GitHub', url: 'https://github.com', desc: '代码托管平台', category: '开发', icon: '' },
    ],
    [],
  );

  return (
    <div>
      <Panel>
        <div className="hz-toolbar">
          <Button leftSection={<IconPlus size={15} />} onClick={openCreate}>
            添加引导页
          </Button>
          <Button variant="light" loading={checking} onClick={() => void checkLinks()} leftSection={<IconRefresh size={14} />}>
            检测链接
          </Button>
          <FileButton accept=".json,.csv,application/json,text/csv" onChange={(file) => void importFile(file)}>
            {(props) => (
              <Button variant="light" loading={importing} leftSection={<IconUpload size={14} />} {...props}>
                批量导入
              </Button>
            )}
          </FileButton>
          <Button variant="subtle" onClick={() => downloadBlob('批量导入示例.json', JSON.stringify(example, null, 2))}>
            示例模板
          </Button>
          <Text size="xs" c="dimmed" ml="auto">
            拖动行首把手可调整前台显示顺序；图标留空时自动抓取
          </Text>
        </div>

        {loading && !data ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : sites.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            还没有引导页，点击「添加引导页」开始吧
          </Text>
        ) : (
          <TableWrap minWidth={860}>
            <thead>
              <tr>
                <th style={{ width: 38 }} />
                <th>名称</th>
                <th>链接</th>
                <th>分类</th>
                <th>图标</th>
                <th>状态</th>
                <th>累计 / 今日</th>
                <th style={{ width: 200 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  key={site.id}
                  draggable
                  onDragStart={() => {
                    dragId.current = site.id;
                  }}
                  onDragEnd={() => {
                    dragId.current = '';
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDrop(site.id);
                  }}
                >
                  <td style={{ cursor: 'grab', color: 'var(--txt-2)' }}>
                    <IconGripVertical size={15} />
                  </td>
                  <td>
                    <Text size="sm" fw={600}>
                      {site.name}
                    </Text>
                    {site.desc && (
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {site.desc}
                      </Text>
                    )}
                  </td>
                  <td className="hz-truncate" style={{ fontSize: 12 }}>
                    <a href={safeUrl(site.url)} target="_blank" rel="noopener noreferrer">
                      {site.url}
                    </a>
                  </td>
                  <td>
                    {site.category ? (
                      <Badge size="sm" variant="light">
                        {site.category}
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </td>
                  <td>
                    {site.icon ? (
                      <img
                        src={safeImage(site.icon)}
                        alt=""
                        style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'contain' }}
                      />
                    ) : (
                      <Text size="xs" c="dimmed">
                        自动
                      </Text>
                    )}
                  </td>
                  <td>
                    {statusBadge(site)}
                    {site.enabled === false && (
                      <Badge size="sm" variant="light" color="gray" ml={4}>
                        已停用
                      </Badge>
                    )}
                  </td>
                  <td className="hz-mono" style={{ fontSize: 12 }}>
                    {formatNumber(site.total)} / {formatNumber(site.today)}
                  </td>
                  <td>
                    <Group gap={4} wrap="nowrap">
                      <Button variant="subtle" size="compact-xs" onClick={() => openEdit(site)}>
                        编辑
                      </Button>
                      <Tooltip label="刷新图标" withArrow>
                        <Button variant="subtle" size="compact-xs" onClick={() => void refreshIcon(site)}>
                          <IconPhoto size={14} />
                        </Button>
                      </Tooltip>
                      <Tooltip label="打开链接" withArrow>
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          component="a"
                          href={safeUrl(site.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <IconExternalLink size={14} />
                        </Button>
                      </Tooltip>
                      <Button variant="subtle" color="red" size="compact-xs" onClick={() => void remove(site)}>
                        <IconTrash size={14} />
                      </Button>
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Modal
        opened={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? '编辑引导页' : '添加引导页'}
        size="md"
      >
        {form && (
          <Stack gap="sm">
            <TextInput
              label="名称"
              required
              maxLength={30}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            />
            <TextInput
              label="链接"
              required
              placeholder="https://example.com"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.currentTarget.value })}
            />
            <Textarea
              label="描述"
              maxLength={60}
              minRows={2}
              value={form.desc}
              onChange={(event) => setForm({ ...form, desc: event.currentTarget.value })}
            />
            <Group grow>
              <TextInput
                label="分类"
                maxLength={12}
                placeholder="如：工具"
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.currentTarget.value })}
              />
              <NumberInput
                label="排序值"
                value={form.order}
                onChange={(value) => setForm({ ...form, order: Number(value) || 0 })}
              />
            </Group>
            <Group align="flex-end" gap={8}>
              <TextInput
                label="图标地址"
                placeholder="留空自动抓取，或上传图片"
                style={{ flex: 1 }}
                value={form.icon}
                onChange={(event) => setForm({ ...form, icon: event.currentTarget.value })}
              />
              <FileButton
                accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/bmp,image/svg+xml,image/avif,image/tiff,image/apng"
                onChange={(file) => {
                  if (!file) return;
                  void uploadIcon(file)
                    .then((result) => {
                      setForm((current) => (current ? { ...current, icon: result.url } : current));
                      notifications.show({
                        message: result.converted ? '已上传并自动转换为 PNG' : '图标已上传',
                        color: 'green',
                      });
                    })
                    .catch((err) => notifications.show({ message: err.message, color: 'red' }));
                }}
              >
                {(props) => (
                  <Button variant="light" {...props}>
                    上传
                  </Button>
                )}
              </FileButton>
            </Group>
            {form.icon && (
              <Group gap={8}>
                <img src={safeImage(form.icon)} alt="" style={{ width: 34, height: 34, objectFit: 'contain' }} />
                <Button variant="subtle" size="compact-xs" onClick={() => setForm({ ...form, icon: '' })}>
                  移除图标
                </Button>
              </Group>
            )}
            <Switch
              label="在前台展示"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })}
            />
            {formError && (
              <Text size="xs" c="red">
                {formError}
              </Text>
            )}
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
    </div>
  );
}

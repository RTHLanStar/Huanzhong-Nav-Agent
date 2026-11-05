import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Menu,
  Modal,
  NumberInput,
  Progress,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronRight,
  IconCopy,
  IconDots,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconFile,
  IconFilePlus,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconFolderPlus,
  IconHome,
  IconLink,
  IconScissors,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { api, ApiError } from '../../lib/api';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/format';
import type { AdminFile, Folder, NodeRecord, ShareCode } from '../../lib/types';
import { ErrorBlock, LoadingBlock, Panel, useLoad } from './shared';

const TEXT_EXT = new Set([
  'txt', 'md', 'log', 'json', 'csv', 'xml', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'py', 'go',
  'java', 'c', 'cpp', 'h', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'yaml', 'yml', 'ini', 'conf', 'env', 'vue',
]);

function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function isTextFile(name: string): boolean {
  return TEXT_EXT.has(extOf(name));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const index = result.indexOf(',');
      resolve(index >= 0 ? result.slice(index + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取文件分块失败'));
    reader.readAsDataURL(blob);
  });
}

const CHUNK_SIZE = 1024 * 1024;

interface EntryRef {
  type: 'file' | 'folder';
  id: string;
}

export default function FilesSection() {
  const [folderId, setFolderId] = useState('');
  const { data, loading, error, reload } = useLoad<{
    files: AdminFile[];
    folders: Folder[];
    allFolders: Folder[];
  }>(`/api/admin/files?folder=${encodeURIComponent(folderId)}`);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [fileModal, setFileModal] = useState(false);
  const [fileForm, setFileForm] = useState({ name: '', content: '' });
  const [externalModal, setExternalModal] = useState(false);
  const [externalForm, setExternalForm] = useState({ name: '', sourceUrl: '', desc: '', nodeId: '', nodePath: '' });
  const [renameTarget, setRenameTarget] = useState<EntryRef | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moveTargets, setMoveTargets] = useState<EntryRef[] | null>(null);
  const [moveDest, setMoveDest] = useState('');
  const [editFile, setEditFile] = useState<AdminFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [shareFile, setShareFile] = useState<AdminFile | null>(null);
  const [shareHours, setShareHours] = useState<number>(24);
  const [shares, setShares] = useState<ShareCode[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [clipboard, setClipboard] = useState<EntryRef[]>([]);
  const [migrateFile, setMigrateFile] = useState<AdminFile | null>(null);
  const [migrateNodeId, setMigrateNodeId] = useState('');
  const [migratePath, setMigratePath] = useState('');
  const [policyFile, setPolicyFile] = useState<AdminFile | null>(null);
  const [policyHidden, setPolicyHidden] = useState(false);
  const [policySpeed, setPolicySpeed] = useState(0);
  const nodesData = useLoad<{ nodes: NodeRecord[] }>('/api/admin/nodes');

  const files = data?.files || [];
  const nodes = nodesData.data?.nodes || [];
  const folders = data?.folders || [];
  const allFolders = data?.allFolders || [];

  const folderOptions = useMemo(() => {
    const map = new Map(allFolders.map((folder) => [folder.id, folder]));
    const label = (folder: Folder): string => {
      const chain: string[] = [];
      let current: Folder | undefined = folder;
      let guard = 0;
      while (current && guard < 50) {
        chain.unshift(current.name);
        current = current.parentId ? map.get(current.parentId) : undefined;
        guard += 1;
      }
      return chain.join(' / ');
    };
    return [
      { value: '', label: '根目录' },
      ...allFolders.map((folder) => ({ value: folder.id, label: label(folder) })),
    ];
  }, [allFolders]);

  const breadcrumb = useMemo(() => {
    const map = new Map(allFolders.map((folder) => [folder.id, folder]));
    const chain: Folder[] = [];
    let current = folderId;
    let guard = 0;
    while (current && guard < 50) {
      const folder = map.get(current);
      if (!folder) break;
      chain.unshift(folder);
      current = folder.parentId;
      guard += 1;
    }
    return chain;
  }, [folderId, allFolders]);

  const changeFolder = (id: string) => {
    setFolderId(id);
    setSelection(new Set());
  };

  const toggleSelect = (key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedEntries = (): EntryRef[] =>
    Array.from(selection).map((key) => {
      const [type, id] = key.split(':');
      return { type: type as 'file' | 'folder', id };
    });

  const uploadFiles = async (fileList: File[]) => {
    if (!fileList.length) return;
    setBusy(true);
    try {
      for (const file of fileList) {
        const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        setProgress({ name: file.name, percent: 0 });
        const init = await api<{ fileId: string; resumed?: boolean; receivedChunks?: number[] }>(
          '/api/admin/files/init',
          {
            method: 'POST',
            body: { filename: file.name, size: file.size, totalChunks, folderId },
          },
        );
        const received = new Set(init.receivedChunks || []);
        for (let index = 0; index < totalChunks; index += 1) {
          if (received.has(index)) continue;
          const start = index * CHUNK_SIZE;
          const blob = file.slice(start, Math.min(file.size, start + CHUNK_SIZE));
          const base64 = await blobToBase64(blob);
          await api('/api/admin/files/chunk', {
            method: 'POST',
            body: { fileId: init.fileId, index, data: base64 },
          });
          setProgress({ name: file.name, percent: Math.round(((index + 1) / totalChunks) * 100) });
        }
        await api('/api/admin/files/finish', { method: 'POST', body: { fileId: init.fileId, desc: '' } });
      }
      notifications.show({ message: `已上传 ${fileList.length} 个文件`, color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '上传失败', color: 'red' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const replaceFile = async (target: AdminFile, file: File) => {
    setBusy(true);
    try {
      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      setProgress({ name: file.name, percent: 0 });
      const init = await api<{ fileId: string }>('/api/admin/files/init', {
        method: 'POST',
        body: {
          filename: file.name,
          size: file.size,
          totalChunks,
          folderId: target.folderId || '',
          replaceId: target.id,
        },
      });
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * CHUNK_SIZE;
        const blob = file.slice(start, Math.min(file.size, start + CHUNK_SIZE));
        const base64 = await blobToBase64(blob);
        await api('/api/admin/files/chunk', {
          method: 'POST',
          body: { fileId: init.fileId, index, data: base64 },
        });
        setProgress({ name: file.name, percent: Math.round(((index + 1) / totalChunks) * 100) });
      }
      await api('/api/admin/files/finish', { method: 'POST', body: { fileId: init.fileId, desc: '' } });
      notifications.show({ message: '文件已替换（保留原下载数与取件码）', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '替换失败', color: 'red' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const download = async (file: AdminFile) => {
    try {
      const result = await api<{ url: string }>(`/api/files/${encodeURIComponent(file.id)}/download`, {
        method: 'POST',
      });
      window.location.href = result.url;
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '下载失败', color: 'red' });
    }
  };

  const createFolder = async () => {
    if (!folderName.trim()) return;
    try {
      await api('/api/admin/folders', { method: 'POST', body: { name: folderName.trim(), parentId: folderId } });
      notifications.show({ message: '文件夹已创建', color: 'green' });
      setFolderModal(false);
      setFolderName('');
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '创建失败', color: 'red' });
    }
  };

  const createTextFile = async () => {
    if (!fileForm.name.trim()) return;
    try {
      await api('/api/admin/files/new', {
        method: 'POST',
        body: { name: fileForm.name.trim(), parentId: folderId, content: fileForm.content },
      });
      notifications.show({ message: '文件已创建', color: 'green' });
      setFileModal(false);
      setFileForm({ name: '', content: '' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '创建失败', color: 'red' });
    }
  };

  const createExternal = async () => {
    try {
      await api('/api/admin/files/external', {
        method: 'POST',
        body: {
          name: externalForm.name,
          sourceUrl: externalForm.nodeId ? '' : externalForm.sourceUrl,
          desc: externalForm.desc,
          nodeId: externalForm.nodeId || undefined,
          nodePath: externalForm.nodeId ? externalForm.nodePath : undefined,
          folderId,
        },
      });
      notifications.show({ message: '外链已添加', color: 'green' });
      setExternalModal(false);
      setExternalForm({ name: '', sourceUrl: '', desc: '', nodeId: '', nodePath: '' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '添加失败', color: 'red' });
    }
  };

  const doRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await api('/api/admin/rename', {
        method: 'POST',
        body: { type: renameTarget.type, id: renameTarget.id, name: renameValue.trim() },
      });
      notifications.show({ message: '已重命名', color: 'green' });
      setRenameTarget(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '重命名失败', color: 'red' });
    }
  };

  const doMove = async () => {
    if (!moveTargets?.length) return;
    try {
      if (moveTargets.length === 1) {
        await api('/api/admin/move', {
          method: 'POST',
          body: { type: moveTargets[0].type, id: moveTargets[0].id, targetFolderId: moveDest },
        });
      } else {
        await api('/api/admin/batch-move', {
          method: 'POST',
          body: { entries: moveTargets, targetFolderId: moveDest },
        });
      }
      notifications.show({ message: '已移动', color: 'green' });
      setMoveTargets(null);
      setSelection(new Set());
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '移动失败', color: 'red' });
    }
  };

  const removeEntry = async (entry: EntryRef, name: string) => {
    if (!window.confirm(`确定删除「${name}」？${entry.type === 'folder' ? '文件夹内的全部内容也会被删除。' : ''}`)) return;
    try {
      const url =
        entry.type === 'folder'
          ? `/api/admin/folders/${encodeURIComponent(entry.id)}`
          : `/api/admin/files/${encodeURIComponent(entry.id)}`;
      await api(url, { method: 'DELETE' });
      notifications.show({ message: '已删除', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const batchDelete = async () => {
    const entries = selectedEntries();
    if (!entries.length) return;
    if (!window.confirm(`确定删除选中的 ${entries.length} 个条目？文件夹内的全部内容也会被删除。`)) return;
    try {
      const result = await api<{ removedFiles: number; removedFolders: number }>('/api/admin/batch-delete', {
        method: 'POST',
        body: { entries },
      });
      notifications.show({
        message: `已删除 ${result.removedFolders} 个文件夹、${result.removedFiles} 个文件`,
        color: 'green',
      });
      setSelection(new Set());
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '删除失败', color: 'red' });
    }
  };

  const copySelection = async (action: 'copy' | 'cut') => {
    const entries = selectedEntries();
    if (!entries.length) return;
    try {
      await api('/api/admin/clipboard', { method: 'POST', body: { action, entries } });
      setClipboard(entries);
      setSelection(new Set());
      notifications.show({ message: action === 'copy' ? '已复制到剪贴板' : '已剪切到剪贴板', color: 'green' });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '操作失败', color: 'red' });
    }
  };

  const paste = async () => {
    try {
      await api('/api/admin/paste', { method: 'POST', body: { targetFolderId: folderId } });
      notifications.show({ message: '已粘贴', color: 'green' });
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '粘贴失败', color: 'red' });
    }
  };

  const openEdit = async (file: AdminFile) => {
    setEditBusy(true);
    try {
      const result = await api<{ content: string }>(`/api/admin/files/${encodeURIComponent(file.id)}/content`);
      setEditContent(result.content);
      setEditFile(file);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '读取失败', color: 'red' });
    } finally {
      setEditBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editFile) return;
    setEditBusy(true);
    try {
      await api(`/api/admin/files/${encodeURIComponent(editFile.id)}/content`, {
        method: 'PUT',
        body: { content: editContent },
      });
      notifications.show({ message: '已保存', color: 'green' });
      setEditFile(null);
      await reload();
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '保存失败', color: 'red' });
    } finally {
      setEditBusy(false);
    }
  };

  const openShare = async (file: AdminFile) => {
    setShareFile(file);
    setShares([]);
    try {
      const result = await api<{ shares: ShareCode[] }>(`/api/admin/files/${encodeURIComponent(file.id)}/shares`);
      setShares(result.shares || []);
    } catch {
      /* 忽略列表失败，仍可生成新取件码 */
    }
  };

  const createShare = async () => {
    if (!shareFile) return;
    setShareBusy(true);
    try {
      const result = await api<{ code: string; expiresAt: string }>(
        `/api/admin/files/${encodeURIComponent(shareFile.id)}/share`,
        { method: 'POST', body: { hours: shareHours } },
      );
      notifications.show({
        message: `取件码：${result.code}（有效至 ${formatDateTime(result.expiresAt)}）`,
        color: 'green',
        autoClose: 8000,
      });
      const list = await api<{ shares: ShareCode[] }>(`/api/admin/files/${encodeURIComponent(shareFile.id)}/shares`);
      setShares(list.shares || []);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '生成失败', color: 'red' });
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (code: string) => {
    try {
      await api(`/api/admin/shares/${encodeURIComponent(code)}`, { method: 'DELETE' });
      setShares((current) => current.filter((item) => item.code !== code));
      notifications.show({ message: '取件码已撤销', color: 'green' });
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '撤销失败', color: 'red' });
    }
  };

  return (
    <div>
      <Panel>
        <div className="hz-toolbar">
          <FileButton
            multiple
            onChange={(files) => {
              if (files?.length) void uploadFiles(files);
            }}
          >
            {(props) => (
              <Button leftSection={<IconUpload size={14} />} {...props} disabled={busy}>
                上传文件
              </Button>
            )}
          </FileButton>
          <Button variant="light" leftSection={<IconFolderPlus size={14} />} onClick={() => setFolderModal(true)}>
            新建文件夹
          </Button>
          <Button variant="light" leftSection={<IconFilePlus size={14} />} onClick={() => setFileModal(true)}>
            新建文件
          </Button>
          <Button variant="subtle" leftSection={<IconLink size={14} />} onClick={() => setExternalModal(true)}>
            引用外链
          </Button>
          {clipboard.length > 0 && (
            <Button variant="subtle" leftSection={<IconCopy size={14} />} onClick={() => void paste()}>
              粘贴（{clipboard.length}）
            </Button>
          )}
          {selection.size > 0 && (
            <>
              <Badge variant="light">{selection.size} 项已选</Badge>
              <Button size="compact-sm" variant="subtle" leftSection={<IconCopy size={13} />} onClick={() => void copySelection('copy')}>
                复制
              </Button>
              <Button size="compact-sm" variant="subtle" leftSection={<IconScissors size={13} />} onClick={() => void copySelection('cut')}>
                剪切
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={() => {
                  setMoveTargets(selectedEntries());
                  setMoveDest('');
                }}
              >
                移动到…
              </Button>
              <Button size="compact-sm" variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={() => void batchDelete()}>
                删除
              </Button>
            </>
          )}
          <Text size="xs" c="dimmed" ml="auto">
            单个文件最大 200MB，文本文件（≤256KB）可在线编辑
          </Text>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          <Button size="compact-xs" variant="subtle" leftSection={<IconHome size={12} />} onClick={() => changeFolder('')}>
            根目录
          </Button>
          {breadcrumb.map((folder) => (
            <Group key={folder.id} gap={4}>
              <IconChevronRight size={12} color="var(--txt-2)" />
              <Button size="compact-xs" variant="subtle" onClick={() => changeFolder(folder.id)}>
                {folder.name}
              </Button>
            </Group>
          ))}
          {folderId && (
            <Button
              size="compact-xs"
              variant="subtle"
              ml="auto"
              leftSection={<IconFileZip size={12} />}
              onClick={() => {
                window.location.href = `/api/files/zip?folder=${encodeURIComponent(folderId)}`;
              }}
            >
              打包下载此文件夹
            </Button>
          )}
        </div>

        {progress && (
          <div style={{ marginBottom: 14 }}>
            <Group justify="space-between" mb={4}>
              <Text size="xs" className="hz-truncate">
                {progress.name}
              </Text>
              <Text size="xs" c="dimmed">
                {progress.percent}%
              </Text>
            </Group>
            <Progress value={progress.percent} size={8} radius="xl" animated={progress.percent < 100} />
          </div>
        )}

        {loading && !data ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : files.length === 0 && folders.length === 0 ? (
          <div className="hz-empty">
            <IconFolder size={40} stroke={1.5} />
            <div>这个文件夹是空的，点击上方按钮上传文件或新建文件夹吧</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {folders.map((folder) => (
              <div className="hz-file-card" key={folder.id}>
                <Checkbox
                  size="xs"
                  checked={selection.has(`folder:${folder.id}`)}
                  onChange={() => toggleSelect(`folder:${folder.id}`)}
                  aria-label={`选择文件夹 ${folder.name}`}
                />
                <button
                  type="button"
                  className="hz-file-icon"
                  style={{ border: 'none', cursor: 'pointer' }}
                  onClick={() => changeFolder(folder.id)}
                  aria-label={`打开文件夹 ${folder.name}`}
                >
                  <IconFolder size={20} />
                </button>
                <div className="hz-file-main" style={{ cursor: 'pointer' }} onClick={() => changeFolder(folder.id)}>
                  <div className="hz-file-name">{folder.name}</div>
                  <div className="hz-file-meta">文件夹</div>
                </div>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Button size="compact-xs" variant="subtle">
                      <IconDots size={14} />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<IconEdit size={13} />} onClick={() => {
                      setRenameTarget({ type: 'folder', id: folder.id });
                      setRenameValue(folder.name);
                    }}>
                      重命名
                    </Menu.Item>
                    <Menu.Item leftSection={<IconExternalLink size={13} />} onClick={() => {
                      setMoveTargets([{ type: 'folder', id: folder.id }]);
                      setMoveDest('');
                    }}>
                      移动到…
                    </Menu.Item>
                    <Menu.Item color="red" leftSection={<IconTrash size={13} />} onClick={() => void removeEntry({ type: 'folder', id: folder.id }, folder.name)}>
                      删除
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            ))}

            {files.map((file) => (
              <div className="hz-file-card" key={file.id}>
                <Checkbox
                  size="xs"
                  checked={selection.has(`file:${file.id}`)}
                  onChange={() => toggleSelect(`file:${file.id}`)}
                  aria-label={`选择文件 ${file.name}`}
                />
                <span className="hz-file-icon">
                  {isTextFile(file.name) ? <IconFileText size={20} /> : <IconFile size={20} />}
                </span>
                <div className="hz-file-main">
                  <div className="hz-file-name">
                    {file.name}
                    {file.hidden && (
                      <Badge size="xs" ml={4} variant="light" color="gray">
                        隐藏
                      </Badge>
                    )}
                    {file.sourceUrl && (
                      <Badge size="xs" ml={4} variant="light" color="blue">
                        外链
                      </Badge>
                    )}
                  </div>
                  <div className="hz-file-meta">
                    {formatBytes(file.size)} · 下载 {formatNumber(file.downloads)}
                  </div>
                  <div className="hz-file-meta">{formatDateTime(file.createdAt)}</div>
                </div>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Button size="compact-xs" variant="subtle">
                      <IconDots size={14} />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<IconDownload size={13} />} onClick={() => void download(file)}>
                      下载
                    </Menu.Item>
                    {isTextFile(file.name) && !file.sourceUrl && (
                      <Menu.Item leftSection={<IconEdit size={13} />} onClick={() => void openEdit(file)}>
                        在线编辑
                      </Menu.Item>
                    )}
                    <Menu.Item
                      leftSection={<IconEdit size={13} />}
                      onClick={() => {
                        setRenameTarget({ type: 'file', id: file.id });
                        setRenameValue(file.name);
                      }}
                    >
                      重命名
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconExternalLink size={13} />}
                      onClick={() => {
                        setMoveTargets([{ type: 'file', id: file.id }]);
                        setMoveDest('');
                      }}
                    >
                      移动到…
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconLink size={13} />}
                      onClick={() => {
                        void openShare(file);
                      }}
                    >
                      取件码
                    </Menu.Item>
                    {file.nodeId && nodes.length > 1 && (
                      <Menu.Item
                        leftSection={<IconExternalLink size={13} />}
                        onClick={() => {
                          setMigrateFile(file);
                          setMigrateNodeId('');
                          setMigratePath(file.name);
                        }}
                      >
                        迁移到节点
                      </Menu.Item>
                    )}
                    <Menu.Item
                      leftSection={<IconCopy size={13} />}
                      onClick={() => {
                        setPolicyFile(file);
                        setPolicyHidden(Boolean(file.hidden));
                        setPolicySpeed(Number(file.speedLimitMbps) || 0);
                      }}
                    >
                      文件策略
                    </Menu.Item>
                    {!file.sourceUrl && (
                      <Menu.Item
                        leftSection={<IconUpload size={13} />}
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.onchange = () => {
                            const selected = input.files?.[0];
                            if (selected) void replaceFile(file, selected);
                          };
                          input.click();
                        }}
                      >
                        替换文件
                      </Menu.Item>
                    )}
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<IconTrash size={13} />} onClick={() => void removeEntry({ type: 'file', id: file.id }, file.name)}>
                      删除
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Modal opened={folderModal} onClose={() => setFolderModal(false)} title="新建文件夹" size="sm">
        <Stack gap="sm">
          <TextInput label="文件夹名称" value={folderName} maxLength={60} onChange={(event) => setFolderName(event.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setFolderModal(false)}>取消</Button>
            <Button onClick={() => void createFolder()}>创建</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={fileModal} onClose={() => setFileModal(false)} title="新建文件" size="md">
        <Stack gap="sm">
          <TextInput
            label="文件名"
            value={fileForm.name}
            maxLength={60}
            placeholder="如：readme.md"
            onChange={(event) => setFileForm({ ...fileForm, name: event.currentTarget.value })}
          />
          <Textarea
            label="初始内容"
            minRows={6}
            value={fileForm.content}
            onChange={(event) => setFileForm({ ...fileForm, content: event.currentTarget.value })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setFileModal(false)}>取消</Button>
            <Button onClick={() => void createTextFile()}>创建</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={externalModal} onClose={() => setExternalModal(false)} title="引用外链文件" size="md">
        <Stack gap="sm">
          <TextInput
            label="文件名"
            value={externalForm.name}
            onChange={(event) => setExternalForm({ ...externalForm, name: event.currentTarget.value })}
          />
          {nodes.length > 0 && (
            <Select
              label="引用节点文件（可选）"
              placeholder="选择节点后，填写节点上的相对路径"
              clearable
              data={nodes.map((node) => ({ value: node.id, label: `${node.name}${node.online ? '' : '（离线）'}` }))}
              value={externalForm.nodeId || null}
              onChange={(value) => setExternalForm({ ...externalForm, nodeId: value || '' })}
            />
          )}
          {externalForm.nodeId ? (
            <TextInput
              label="节点文件路径"
              placeholder="如：uploads/demo.zip"
              value={externalForm.nodePath}
              onChange={(event) => setExternalForm({ ...externalForm, nodePath: event.currentTarget.value })}
            />
          ) : (
            <TextInput
              label="外链地址"
              placeholder="https://example.com/file.zip"
              value={externalForm.sourceUrl}
              onChange={(event) => setExternalForm({ ...externalForm, sourceUrl: event.currentTarget.value })}
            />
          )}
          <TextInput
            label="描述"
            value={externalForm.desc}
            onChange={(event) => setExternalForm({ ...externalForm, desc: event.currentTarget.value })}
          />
          <Text size="xs" c="dimmed">外链不会落盘，由一次性令牌代理下载；不允许指向内网或回环地址。</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setExternalModal(false)}>取消</Button>
            <Button onClick={() => void createExternal()}>添加</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title="重命名" size="sm">
        <Stack gap="sm">
          <TextInput label="新名称" value={renameValue} maxLength={60} onChange={(event) => setRenameValue(event.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button onClick={() => void doRename()}>保存</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(moveTargets)} onClose={() => setMoveTargets(null)} title="移动到文件夹" size="sm">
        <Stack gap="sm">
          <Select data={folderOptions} value={moveDest} onChange={(value) => setMoveDest(value || '')} label="目标文件夹" />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMoveTargets(null)}>取消</Button>
            <Button onClick={() => void doMove()}>移动</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(editFile)} onClose={() => setEditFile(null)} title={`在线编辑：${editFile?.name || ''}`} size="xl">
        <Stack gap="sm">
          <Textarea
            value={editContent}
            onChange={(event) => setEditContent(event.currentTarget.value)}
            minRows={18}
            autosize
            styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } }}
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">保存后文件大小将同步更新，超过 256KB 无法在线编辑。</Text>
            <Button loading={editBusy} onClick={() => void saveEdit()}>保存</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(shareFile)} onClose={() => setShareFile(null)} title={`取件码：${shareFile?.name || ''}`} size="md">
        <Stack gap="sm">
          <Group align="flex-end" gap={8}>
            <NumberInput
              label="有效期（小时）"
              value={shareHours}
              min={1}
              max={720}
              onChange={(value) => setShareHours(Number(value) || 24)}
              style={{ flex: 1 }}
            />
            <Button loading={shareBusy} leftSection={<IconLink size={13} />} onClick={() => void createShare()}>
              生成
            </Button>
          </Group>
          {shares.length === 0 ? (
            <Text size="xs" c="dimmed">暂无有效取件码</Text>
          ) : (
            <Stack gap={6}>
              {shares.map((item) => (
                <Group key={item.code} justify="space-between" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px' }}>
                  <div>
                    <Text size="sm" fw={600} className="hz-mono">
                      {item.code}
                    </Text>
                    <Text size="xs" c="dimmed">有效至 {formatDateTime(item.expiresAt)}</Text>
                  </div>
                  <Group gap={4}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => {
                        void navigator.clipboard.writeText(item.code).then(() => notifications.show({ message: '已复制取件码', color: 'green' }));
                      }}
                    >
                      复制
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void revokeShare(item.code)}>
                      撤销
                    </Button>
                  </Group>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Modal>

      <Modal opened={Boolean(migrateFile)} onClose={() => setMigrateFile(null)} title={`迁移节点：${migrateFile?.name || ''}`} size="sm">
        <Stack gap="sm">
          <Select
            label="目标节点"
            data={nodes
              .filter((node) => node.id !== migrateFile?.nodeId)
              .map((node) => ({ value: node.id, label: `${node.name}${node.online ? '' : '（离线）'}` }))}
            value={migrateNodeId}
            onChange={(value) => setMigrateNodeId(value || '')}
          />
          <TextInput
            label="目标路径"
            value={migratePath}
            onChange={(event) => setMigratePath(event.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            迁移由主站从源节点读取并转发到目标节点，两个节点都必须在线；迁移完成后文件指针自动切换。
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMigrateFile(null)}>取消</Button>
            <Button
              disabled={!migrateNodeId || !migratePath.trim()}
              onClick={() => {
                if (!migrateFile) return;
                api(`/api/admin/files/${encodeURIComponent(migrateFile.id)}/migrate-node`, {
                  method: 'POST',
                  body: { targetNodeId: migrateNodeId, targetPath: migratePath.trim() },
                })
                  .then(async () => {
                    notifications.show({ message: '文件已迁移', color: 'green' });
                    setMigrateFile(null);
                    await reload();
                  })
                  .catch((err) => notifications.show({ message: err.message, color: 'red' }));
              }}
            >
              开始迁移
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={Boolean(policyFile)} onClose={() => setPolicyFile(null)} title={`文件策略：${policyFile?.name || ''}`} size="sm">
        <Stack gap="sm">
          <Switch
            label="在前台隐藏该文件"
            checked={policyHidden}
            onChange={(event) => setPolicyHidden(event.currentTarget.checked)}
          />
          <NumberInput
            label="单文件限速（MB/s，0 表示跟随全局）"
            min={0}
            max={1000}
            value={policySpeed}
            onChange={(value) => setPolicySpeed(Number(value) || 0)}
          />
          <Text size="xs" c="dimmed">
            限速仅影响该文件的下载带宽，不改变文件内容与取件码。
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPolicyFile(null)}>取消</Button>
            <Button
              onClick={() => {
                if (!policyFile) return;
                api(`/api/admin/files/${encodeURIComponent(policyFile.id)}/policy`, {
                  method: 'PUT',
                  body: { hidden: policyHidden, speedLimitMbps: policySpeed },
                })
                  .then(async () => {
                    notifications.show({ message: '文件策略已保存', color: 'green' });
                    setPolicyFile(null);
                    await reload();
                  })
                  .catch((err) => notifications.show({ message: err.message, color: 'red' }));
              }}
            >
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Text size="xs" c="dimmed">
        提示：文件夹打包下载会以 ZIP 流式输出；替换文件会保留原下载数与取件码。
      </Text>
    </div>
  );
}

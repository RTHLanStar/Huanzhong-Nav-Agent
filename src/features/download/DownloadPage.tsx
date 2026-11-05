import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconChevronRight,
  IconCode,
  IconDownload,
  IconEye,
  IconFile,
  IconFileText,
  IconFileTypePdf,
  IconFileZip,
  IconFolder,
  IconFolderOpen,
  IconHome,
  IconMoon,
  IconMusic,
  IconPhoto,
  IconSearch,
  IconSun,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import { api, ApiError } from '../../lib/api';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { useApp } from '../../components/AppProviders';
import type { Folder, ShareFile } from '../../lib/types';

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

interface PreviewState {
  file: ShareFile;
  kind: PreviewKind | 'markdown';
  url: string;
  text?: string;
}

interface CaptchaPending {
  action: 'download' | 'zip';
  target: string;
}

function fileVisual(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg'].includes(ext)) {
    return { icon: IconPhoto, label: '图片' };
  }
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return { icon: IconVideo, label: '视频' };
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return { icon: IconMusic, label: '音频' };
  if (ext === 'pdf') return { icon: IconFileTypePdf, label: 'PDF' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: IconFileZip, label: '压缩包' };
  if (['js', 'ts', 'tsx', 'jsx', 'css', 'py', 'go', 'java', 'c', 'cpp', 'rs', 'php', 'rb', 'sh', 'sql', 'json', 'yml', 'yaml'].includes(ext)) {
    return { icon: IconCode, label: '代码' };
  }
  if (['md', 'txt', 'log', 'csv', 'xml', 'ini', 'conf'].includes(ext)) return { icon: IconFileText, label: '文本' };
  return { icon: IconFile, label: '文件' };
}

export default function DownloadPage() {
  const { colorScheme, toggleColorScheme, info } = useApp();
  const [folderId, setFolderId] = useState('');
  const [files, setFiles] = useState<ShareFile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [allFolders, setAllFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState<ShareFile[] | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [captchaId, setCaptchaId] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaError, setCaptchaError] = useState('');
  const [pending, setPending] = useState<CaptchaPending | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCode, setShareCode] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const shareInputRef = useRef<HTMLInputElement>(null);

  const loadFolder = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await api<{ files: ShareFile[]; folders: Folder[]; allFolders: Folder[] }>(
        `/api/files?folder=${encodeURIComponent(id)}`,
      );
      setFiles(data.files || []);
      setFolders(data.folders || []);
      setAllFolders(data.allFolders || []);
      setFolderId(id);
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '加载失败，请刷新重试', color: 'red' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFolder('');
  }, [loadFolder]);

  // 分享链接直达：/download?code=XXXX 自动填入取件码并提取
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    setShareCode(code.toUpperCase());
    setShareOpen(true);
    const timer = window.setTimeout(() => {
      const upper = code.toUpperCase();
      api<{ name: string; url: string }>(`/api/share/${encodeURIComponent(upper)}`)
        .then((data) => {
          notifications.show({ message: `开始下载：${data.name}`, color: 'green' });
          window.location.href = data.url;
        })
        .catch((err) => {
          notifications.show({ message: err instanceof Error ? err.message : '取件码无效或已过期', color: 'red' });
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  // 分享链接直达：/download?code=XXXX 自动填入取件码并提取
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    setShareCode(code.toUpperCase());
    setShareOpen(true);
    const timer = window.setTimeout(() => {
      const upper = code.toUpperCase();
      api<{ name: string; url: string }>(`/api/share/${encodeURIComponent(upper)}`)
        .then((data) => {
          notifications.show({ message: `开始下载：${data.name}`, color: 'green' });
          window.location.href = data.url;
        })
        .catch((err) => {
          notifications.show({ message: err instanceof Error ? err.message : '取件码无效或已过期', color: 'red' });
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, []);

  const totalStats = useMemo(() => {
    const list = allFiles || files;
    return {
      count: list.length,
      downloads: list.reduce((sum, file) => sum + (file.downloads || 0), 0),
    };
  }, [allFiles, files]);

  const searchResults = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return null;
    const list = allFiles || files;
    return list.filter(
      (file) =>
        (file.name || '').toLowerCase().includes(keyword) ||
        (file.desc || '').toLowerCase().includes(keyword),
    );
  }, [query, allFiles, files]);

  useEffect(() => {
    if (!query.trim() || allFiles) return;
    api<{ files: ShareFile[] }>('/api/files?all=1')
      .then((data) => setAllFiles(data.files || []))
      .catch(() => undefined);
  }, [query, allFiles]);

  const breadcrumb = useMemo(() => {
    const chain: Folder[] = [];
    let current = folderId;
    let guard = 0;
    while (current && guard < 50) {
      const folder = allFolders.find((item) => item.id === current);
      if (!folder) break;
      chain.unshift(folder);
      current = folder.parentId;
      guard += 1;
    }
    return chain;
  }, [folderId, allFolders]);

  const refreshCaptcha = useCallback(async () => {
    setCaptchaError('');
    try {
      const data = await api<{ captchaId: string }>('/api/captcha/new');
      if (data.captchaId) {
        setCaptchaId(data.captchaId);
        setCaptchaAnswer('');
      }
    } catch {
      setCaptchaError('验证码获取失败，请重试');
    }
  }, []);

  const openCaptcha = useCallback(
    (next: CaptchaPending, message = '') => {
      setPending(next);
      setCaptchaOpen(true);
      setCaptchaError(message);
      void refreshCaptcha();
    },
    [refreshCaptcha],
  );

  const startDownload = useCallback(
    async (fileId: string, captcha?: { id: string; answer: string }) => {
      try {
        const body = captcha ? { captchaId: captcha.id, captchaAnswer: captcha.answer } : undefined;
        const data = await api<{ url: string }>(`/api/files/${encodeURIComponent(fileId)}/download`, {
          method: 'POST',
          body,
        });
        setCaptchaOpen(false);
        setPending(null);
        window.location.href = data.url;
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        if (apiError?.data?.requireCaptcha) {
          openCaptcha(
            { action: 'download', target: fileId },
            apiError.message !== 'need_captcha' ? apiError.message : '',
          );
          return;
        }
        notifications.show({ message: err instanceof Error ? err.message : '下载失败，请重试', color: 'red' });
      }
    },
    [openCaptcha],
  );

  const startZip = useCallback(
    async (folder: string, captcha?: { id: string; answer: string }) => {
      try {
        const body: Record<string, unknown> = { folderId: folder };
        if (captcha) {
          body.captchaId = captcha.id;
          body.captchaAnswer = captcha.answer;
        }
        const data = await api<{ url: string }>('/api/files/zip-request', { method: 'POST', body });
        setCaptchaOpen(false);
        setPending(null);
        window.location.href = data.url;
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        if (apiError?.data?.requireCaptcha) {
          openCaptcha({ action: 'zip', target: folder }, apiError.message !== 'need_captcha' ? apiError.message : '');
          return;
        }
        notifications.show({ message: err instanceof Error ? err.message : '打包失败，请重试', color: 'red' });
      }
    },
    [openCaptcha],
  );

  const submitCaptcha = () => {
    if (!pending) return;
    const answer = captchaAnswer.trim();
    if (!answer) {
      setCaptchaError('请输入验证码');
      return;
    }
    if (pending.action === 'zip') void startZip(pending.target, { id: captchaId, answer });
    else void startDownload(pending.target, { id: captchaId, answer });
  };

  const openPreview = useCallback(async (file: ShareFile) => {
    setPreviewLoading(true);
    try {
      const data = await api<{
        previewable: boolean;
        kind?: PreviewKind;
        mime?: string;
        url?: string;
        reason?: string;
      }>(`/api/files/${encodeURIComponent(file.id)}/preview`);
      if (!data.previewable || !data.kind || !data.url) {
        notifications.show({ message: data.reason || '该文件不支持在线预览', color: 'yellow' });
        return;
      }
      if (data.kind === 'text') {
        const isMarkdown = /\.md$/i.test(file.name);
        const response = await fetch(data.url);
        const text = await response.text();
        setPreview({ file, kind: isMarkdown ? 'markdown' : 'text', url: data.url, text });
      } else {
        setPreview({ file, kind: data.kind, url: data.url });
      }
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '预览加载失败', color: 'red' });
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const extractShare = async () => {
    const code = shareCode.trim().toUpperCase();
    if (!code) return;
    setShareBusy(true);
    try {
      const data = await api<{ name: string; size: number; url: string }>(`/api/share/${encodeURIComponent(code)}`);
      notifications.show({ message: `开始下载：${data.name}`, color: 'green' });
      window.location.href = data.url;
      setShareOpen(false);
      setShareCode('');
    } catch (err) {
      notifications.show({ message: err instanceof Error ? err.message : '取件码无效或已过期', color: 'red' });
    } finally {
      setShareBusy(false);
    }
  };

  const renderFileCard = (file: ShareFile) => {
    const visual = fileVisual(file.name);
    const Icon = visual.icon;
    return (
      <div className="hz-file-card" key={file.id}>
        <span className="hz-file-icon">
          <Icon size={20} />
        </span>
        <div className="hz-file-main">
          <div className="hz-file-name">{file.name}</div>
          <div className="hz-file-meta">
            {formatBytes(file.size)} · 下载 {formatNumber(file.downloads)} 次
            {file.desc ? ` · ${file.desc}` : ''}
          </div>
          <div className="hz-file-meta">{formatDateTime(file.createdAt)}</div>
          <Group gap={6} mt={8}>
            <Button size="compact-xs" variant="light" leftSection={<IconDownload size={13} />} onClick={() => void startDownload(file.id)}>
              下载
            </Button>
            {!file.external && (
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconEye size={13} />}
                loading={previewLoading}
                onClick={() => void openPreview(file)}
              >
                预览
              </Button>
            )}
          </Group>
        </div>
      </div>
    );
  };

  const visibleFiles = searchResults ?? files;

  return (
    <div className="hz-shell">
      <header className="hz-header">
        <div className="hz-container hz-header-inner">
          <a className="hz-brand" href="/">
            <div className="hz-logo" style={{ fontSize: 15 }}>
              <IconFolderOpen size={20} />
            </div>
            <div>
              <div className="hz-brand-title">{info?.siteName || '幻终の导航'}</div>
              <div style={{ fontSize: 11, color: 'var(--txt-2)' }}>文件下载</div>
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

      <main className="hz-container" style={{ flex: 1, maxWidth: 1040 }}>
        <section className="hz-download-head">
          <Title order={1} style={{ fontSize: 30 }}>
            文件下载
          </Title>
          <Text size="sm" c="dimmed" mt={6}>
            共 {formatNumber(totalStats.count)} 个文件 · 累计下载 {formatNumber(totalStats.downloads)} 次
          </Text>

          <div style={{ maxWidth: 560, margin: '20px auto 0' }}>
            <div className="hz-search" style={{ margin: 0, maxWidth: 'none' }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="搜索文件名或描述…"
                aria-label="搜索文件"
              />
              <span className="hz-search-icon">
                <IconSearch size={17} />
              </span>
            </div>
            <Group justify="center" gap={8} mt={10}>
              <Button size="compact-sm" variant="light" onClick={() => setShareOpen(true)}>
                使用取件码
              </Button>
              {query && (
                <Button size="compact-sm" variant="subtle" leftSection={<IconX size={13} />} onClick={() => setQuery('')}>
                  清除搜索
                </Button>
              )}
            </Group>
          </div>
        </section>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            margin: '26px 0 16px',
            fontSize: 13,
            color: 'var(--txt-2)',
          }}
        >
          <button
            type="button"
            className="hz-engine"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => {
              setQuery('');
              void loadFolder('');
            }}
          >
            <IconHome size={13} /> 根目录
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconChevronRight size={13} />
              <button
                type="button"
                className="hz-engine"
                onClick={() => {
                  setQuery('');
                  void loadFolder(folder.id);
                }}
              >
                {folder.name}
              </button>
            </span>
          ))}
          {folderId && !query && (
            <Button
              size="compact-xs"
              variant="subtle"
              ml="auto"
              leftSection={<IconFileZip size={13} />}
              onClick={() => void startZip(folderId)}
            >
              打包此文件夹
            </Button>
          )}
        </div>

        {loading ? (
          <Stack align="center" py="xl" gap={8}>
            <Loader size="sm" />
            <Text size="xs" c="dimmed">
              正在加载文件列表…
            </Text>
          </Stack>
        ) : (
          <>
            {!query && folders.length > 0 && (
              <div className="hz-file-grid" style={{ marginBottom: 14 }}>
                {folders.map((folder) => (
                  <div
                    key={folder.id}
                    className="hz-file-card"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => void loadFolder(folder.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void loadFolder(folder.id);
                    }}
                  >
                    <span className="hz-file-icon" style={{ background: 'var(--surface-2)', color: 'var(--accent)' }}>
                      <IconFolder size={20} />
                    </span>
                    <div className="hz-file-main">
                      <div className="hz-file-name">{folder.name}</div>
                      <div className="hz-file-meta">文件夹 · 点击进入</div>
                    </div>
                    <IconChevronRight size={16} className="hz-muted" />
                  </div>
                ))}
              </div>
            )}

            {visibleFiles.length === 0 ? (
              <div className="hz-empty">
                <IconFolderOpen size={46} stroke={1.5} />
                <div>{query ? '没有找到匹配的文件' : '这个文件夹暂时是空的'}</div>
              </div>
            ) : (
              <div className="hz-file-grid">{visibleFiles.map(renderFileCard)}</div>
            )}
          </>
        )}
      </main>

      <footer className="hz-footer">
        <span>{info?.footerText || '幻终の导航 · 文件共享'}</span>
        <a href="/">返回导航</a>
      </footer>

      <Modal
        opened={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.file.name || '文件预览'}
        size="xl"
        centered
      >
        {preview && (
          <Stack gap="sm">
            {preview.kind === 'image' && (
              <img src={preview.url} alt={preview.file.name} style={{ maxWidth: '100%', borderRadius: 10 }} />
            )}
            {preview.kind === 'video' && (
              <video src={preview.url} controls style={{ width: '100%', borderRadius: 10 }} />
            )}
            {preview.kind === 'audio' && <audio src={preview.url} controls style={{ width: '100%' }} />}
            {preview.kind === 'pdf' && (
              <iframe src={preview.url} title={preview.file.name} style={{ width: '100%', height: '70vh', border: 0 }} />
            )}
            {preview.kind === 'text' && (
              <pre
                style={{
                  maxHeight: '70vh',
                  overflow: 'auto',
                  background: 'var(--surface-2)',
                  padding: 14,
                  borderRadius: 12,
                  fontSize: 12,
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {preview.text}
              </pre>
            )}
            {preview.kind === 'markdown' && (
              <div
                className="md-body"
                style={{ maxHeight: '70vh', overflow: 'auto' }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text || '') }}
              />
            )}
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {formatBytes(preview.file.size)} · {formatDateTime(preview.file.createdAt)}
              </Text>
              <Button size="xs" leftSection={<IconDownload size={14} />} onClick={() => void startDownload(preview.file.id)}>
                下载原文件
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal opened={captchaOpen} onClose={() => setCaptchaOpen(false)} title="安全验证" size="xs">
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            为防止滥用，下载前需要完成人机验证
          </Text>
          <Group gap={8} align="center">
            <img
              src={`/api/captcha/img?c=${encodeURIComponent(captchaId)}&t=${Date.now()}`}
              alt="验证码"
              title="点击刷新"
              onClick={() => void refreshCaptcha()}
              style={{ height: 40, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--line)' }}
            />
            <TextInput
              value={captchaAnswer}
              onChange={(event) => setCaptchaAnswer(event.currentTarget.value)}
              placeholder="验证码"
              maxLength={4}
              style={{ flex: 1 }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitCaptcha();
              }}
            />
          </Group>
          {captchaError && (
            <Text size="xs" c="red">
              {captchaError}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={() => setCaptchaOpen(false)}>
              取消
            </Button>
            <Button size="xs" onClick={submitCaptcha}>
              确认下载
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title="取件码下载" size="sm">
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            输入管理员提供的取件码，即可直接下载对应文件。
          </Text>
          <TextInput
            ref={shareInputRef}
            value={shareCode}
            onChange={(event) => setShareCode(event.currentTarget.value.toUpperCase())}
            placeholder="6 位取件码"
            maxLength={12}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void extractShare();
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={() => setShareOpen(false)}>
              取消
            </Button>
            <Button size="xs" loading={shareBusy} onClick={() => void extractShare()}>
              提取文件
            </Button>
          </Group>
          <Badge variant="light" size="xs" style={{ alignSelf: 'flex-start' }}>
            取件码区分大小写已自动转换
          </Badge>
        </Stack>
      </Modal>
    </div>
  );
}

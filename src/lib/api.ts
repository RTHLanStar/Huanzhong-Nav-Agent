export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

/** 统一的 JSON 请求封装：自动附带凭证、解析错误信息并抛出 ApiError。 */
export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('网络异常，请检查连接后重试', 0, {});
  }

  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }

  if (!response.ok) {
    const message = typeof data.error === 'string' && data.error ? data.error : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** 下载受保护的文件：先申请一次性令牌，再触发浏览器下载。 */
export async function downloadFile(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function uploadIcon(file: File): Promise<{ url: string; converted?: boolean }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  const result = await post<{ ok: boolean; url: string; converted?: boolean }>('/api/admin/upload', {
    data: dataUrl,
    filename: file.name,
  });
  return { url: result.url, converted: result.converted };
}

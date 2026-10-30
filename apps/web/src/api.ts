import type {
  Account,
  ApiKey,
  ApiKeyInput,
  KeyEndpoint,
  Audit,
  Candidate,
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  CreatedApiKey,
  Endpoint,
  EndpointInput,
  EndpointStatus,
  EndpointTestResult,
  Health,
  ImportJob,
  ImportJobDetail,
  ImportKind,
  ImportRunResult,
  ImportStartResult,
  LoginResult,
  Platform,
  PlatformInput,
  PlatformTestResult,
  Role,
  SecretMeta,
  Settings,
  SettingsPatch,
  Stats,
  Tool,
  ApplyUpdateResult,
  UpdateState,
} from './types.ts';

export const SESSION_KEY = 'aah_session';
export const ACCOUNT_KEY = 'aah_account';

/** 登录态：token + 当前账号 */
export type Session = { token: string; account: Account };

export function getSession(): Session | null {
  try {
    const token = localStorage.getItem(SESSION_KEY) ?? '';
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!token || !raw) return null;
    return { token, account: JSON.parse(raw) as Account };
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(ACCOUNT_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, session.token);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(session.account));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function getToken(): string {
  return getSession()?.token ?? '';
}

/** 401 时由 App 注册的回调，用于统一跳登录页 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...extra };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `${res.status} ${res.statusText || '请求失败'}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (body?.error?.code) code = body.error.code;
        if (body?.error?.message) message = body.error.message;
        else message = text.slice(0, 300);
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* 读不出 body 就用状态码兜底 */
  }
  if (res.status === 401) {
    message = '登录已失效，请重新登录';
    onUnauthorized?.();
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, 'network_error', `连不上后端：${(err as Error).message}`);
  }

  if (!res.ok) throw await toApiError(res);

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'bad_json', '响应不是合法 JSON');
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/* ────────────────────────── 认证 ────────────────────────── */

export const authApi = {
  login(username: string, password: string): Promise<LoginResult> {
    return request<LoginResult>('POST', '/api/auth/login', { username, password });
  },
  me(): Promise<{ account: Account }> {
    return request<{ account: Account }>('GET', '/api/auth/me');
  },
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', '/api/auth/logout');
  },
  changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; relogin: boolean }> {
    return request<{ ok: boolean; relogin: boolean }>('POST', '/api/auth/change-password', {
      oldPassword,
      newPassword,
    });
  },
};

export const accountsApi = {
  list(): Promise<Account[]> {
    return request<Account[]>('GET', '/api/accounts');
  },
  create(username: string, password: string, role: Role): Promise<Account> {
    return request<Account>('POST', '/api/accounts', { username, password, role });
  },
  resetPassword(id: string, password: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/accounts/${enc(id)}/password`, { password });
  },
  setEnabled(id: string, enabled: boolean): Promise<Account> {
    return request<Account>('PATCH', `/api/accounts/${enc(id)}`, { enabled });
  },
  setRole(id: string, role: Role): Promise<Account> {
    return request<Account>('PATCH', `/api/accounts/${enc(id)}`, { role });
  },
  remove(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/accounts/${enc(id)}`);
  },
};

/* ────────────────────────── 一键整理 ────────────────────────── */

export interface ImportRequest {
  text: string;
  kind?: ImportKind;
  platformSlug?: string;
  useAi?: boolean;
  autoPublish?: boolean;
  /** 是否让探测 Agent 真实请求上游（默认 true） */
  probeUpstream?: boolean;
}

export interface EndpointListQuery {
  platformId?: string;
  status?: EndpointStatus | '';
  q?: string;
}

/* ────────────────────────── SSE ────────────────────────── */

/** 从 SSE 帧里抽出 data: 行并拼成 payload */
function sseData(raw: string): string {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) continue;
    dataLines.push(trimmed.slice(5).replace(/^ /, ''));
  }
  return dataLines.join('\n');
}

/**
 * 通用的 SSE 读取器：按 \n\n 切帧，回调拿到 data 字符串。
 * 心跳帧（以 `:` 开头的注释行）会被自动跳过。
 */
async function pumpSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) throw new ApiError(res.status, 'no_stream', '服务端没有返回事件流');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flush = (raw: string) => {
    const data = sseData(raw);
    if (data) onData(data);
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      flush(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  if (buffer.trim()) flush(buffer);
}

function handleSseFrame(raw: string, onEvent: (event: ChatStreamEvent) => void): void {
  const payload = sseData(raw);
  if (!payload) return;
  if (payload === '[DONE]') {
    onEvent({ type: 'done' });
    return;
  }
  try {
    const parsed = JSON.parse(payload) as ChatStreamEvent;
    if (parsed && typeof parsed.type === 'string') {
      onEvent(parsed);
      return;
    }
  } catch {
    /* 非 JSON 帧按增量文本处理 */
  }
  onEvent({ type: 'delta', text: payload });
}

export async function streamChatMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/chat/sessions/${enc(sessionId)}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({ content }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw new ApiError(0, 'network_error', `连不上后端：${(err as Error).message}`);
  }

  if (!res.ok) throw await toApiError(res);

  try {
    await pumpSse(res, (data) => handleSseFrame(data, onEvent));
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw err;
  }
}

/* ────────────────────────── 导入任务事件流 ────────────────────────── */

export type ImportStreamEvent =
  | { type: 'snapshot'; jobs: ImportJob[] }
  | { type: 'job'; jobId: string; job: ImportJob | null; isRunning: boolean };

/**
 * 订阅导入任务事件流（SSE）。
 *
 * 服务端每完成一步就推一帧，替代前端轮询。
 * 返回的 Promise 在流断开时 resolve；调用方用 AbortSignal 主动断开。
 */
export async function streamImportJobs(
  onEvent: (event: ImportStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/import/stream', {
      method: 'GET',
      headers: authHeaders({ accept: 'text/event-stream' }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw new ApiError(0, 'network_error', `连不上后端：${(err as Error).message}`);
  }

  if (!res.ok) throw await toApiError(res);

  try {
    await pumpSse(res, (data) => {
      try {
        const parsed = JSON.parse(data) as ImportStreamEvent;
        if (parsed && typeof parsed.type === 'string') onEvent(parsed);
      } catch {
        /* 坏帧丢弃 */
      }
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw err;
  }
}

/* ────────────────────────── 实时调用流水 ────────────────────────── */

export type AuditStreamEvent =
  | { type: 'snapshot'; records: Audit[] }
  | { type: 'record'; record: Audit };

/**
 * 订阅实时调用流水（SSE）。
 * 网关每被调用一次就推一帧，概览页能看到请求实时滚进来。
 */
export async function streamAudit(
  onEvent: (event: AuditStreamEvent) => void,
  signal?: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/audit/stream', {
      method: 'GET',
      headers: authHeaders({ accept: 'text/event-stream' }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw new ApiError(0, 'network_error', `连不上后端：${(err as Error).message}`);
  }

  if (!res.ok) throw await toApiError(res);

  // 响应头到手就算连上了，不用等第一帧数据
  onOpen?.();

  try {
    await pumpSse(res, (data) => {
      try {
        const parsed = JSON.parse(data) as AuditStreamEvent;
        if (parsed && typeof parsed.type === 'string') onEvent(parsed);
      } catch {
        /* 坏帧丢弃 */
      }
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw err;
  }
}

/* ────────────────────────── 接口封装 ────────────────────────── */

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  stats: () => request<Stats>('GET', '/api/stats'),

  platforms: {
    list: () => request<Platform[]>('GET', '/api/platforms'),
    create: (input: PlatformInput) => request<Platform>('POST', '/api/platforms', input),
    get: (id: string) => request<Platform>('GET', `/api/platforms/${enc(id)}`),
    update: (id: string, patch: Partial<PlatformInput>) =>
      request<Platform>('PATCH', `/api/platforms/${enc(id)}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/platforms/${enc(id)}`),
    test: (id: string) => request<PlatformTestResult>('POST', `/api/platforms/${enc(id)}/test`, {}),
    /** 重新抓站点标题 */
    refreshTitle: (id: string, applyName?: boolean) =>
      request<{
        ok: boolean;
        title: string;
        icon: string;
        error: string | null;
        /** 最终名字是否就是站点标题 */
        appliedName: boolean;
        /** 这次是否真的改了名字 */
        renamed: boolean;
        platform: Platform;
      }>('POST', `/api/platforms/${enc(id)}/refresh-title`, applyName === undefined ? {} : { applyName }),
  },

  endpoints: {
    list: (query: EndpointListQuery = {}) =>
      request<Endpoint[]>(
        'GET',
        `/api/endpoints${qs({
          platformId: query.platformId,
          status: query.status,
          q: query.q,
        })}`,
      ),
    create: (platformId: string, input: EndpointInput) =>
      request<Endpoint>('POST', '/api/endpoints', { platformId, ...input }),
    get: (id: string) => request<Endpoint>('GET', `/api/endpoints/${enc(id)}`),
    update: (id: string, input: EndpointInput) =>
      request<Endpoint>('PUT', `/api/endpoints/${enc(id)}`, input),
    remove: (id: string) => request<void>('DELETE', `/api/endpoints/${enc(id)}`),
    publish: (id: string, note?: string) =>
      request<Endpoint>('POST', `/api/endpoints/${enc(id)}/publish`, note ? { note } : {}),
    archive: (id: string) => request<Endpoint>('POST', `/api/endpoints/${enc(id)}/archive`, {}),
    test: (id: string, args: Record<string, unknown>) =>
      request<EndpointTestResult>('POST', `/api/endpoints/${enc(id)}/test`, { args }),
  },

  tools: {
    list: () => request<Tool[]>('GET', '/api/tools'),
    update: (
      id: string,
      patch: Partial<{
        name: string;
        enabled: boolean;
        title: string;
        description: string;
        cacheTtl: number;
        namespace: string;
      }>,
    ) => request<Tool>('PATCH', `/api/tools/${enc(id)}`, patch),
    rebuild: () => request<{ rebuilt: number }>('POST', '/api/tools/rebuild', {}),
  },

  import: {
    /** 默认异步：立即返回 jobId，后台继续跑 */
    run: (body: ImportRequest) => request<ImportStartResult>('POST', '/api/import', body),
    jobs: () => request<ImportJob[]>('GET', '/api/import/jobs'),
    job: (id: string) => request<ImportJobDetail>('GET', `/api/import/jobs/${enc(id)}`),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/import/jobs/${enc(id)}`),
    accept: (candidateId: string) =>
      request<{ endpointId: string }>('POST', `/api/import/candidates/${enc(candidateId)}/accept`, {}),
    reject: (candidateId: string) =>
      request<{ ok: boolean }>('POST', `/api/import/candidates/${enc(candidateId)}/reject`, {}),
    acceptAll: (jobId: string) =>
      request<{ created: number; updated: number }>(
        'POST',
        `/api/import/jobs/${enc(jobId)}/accept-all`,
        {},
      ),
  },

  secrets: {
    list: () => request<SecretMeta[]>('GET', '/api/secrets'),
    create: (body: { name: string; value: string; hint?: string }) =>
      request<{ ok?: boolean }>('POST', '/api/secrets', body),
    remove: (name: string) => request<void>('DELETE', `/api/secrets/${enc(name)}`),
  },

  apiKeys: {
    list: () => request<ApiKey[]>('GET', '/api/api-keys'),
    create: (body: ApiKeyInput) => request<CreatedApiKey>('POST', '/api/api-keys', body),
    update: (
      id: string,
      patch: Partial<ApiKeyInput> & { enabled?: boolean; resetQuota?: boolean },
    ) => request<{ ok: boolean; key: ApiKey }>('PATCH', `/api/api-keys/${enc(id)}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/api-keys/${enc(id)}`),
    endpoints: (id: string) =>
      request<KeyEndpoint[]>('GET', `/api/api-keys/${enc(id)}/endpoints`),
  },

  audit: {
    list: (query: { limit?: number; tool?: string } = {}) =>
      request<Audit[]>(
        'GET',
        `/api/audit${qs({ limit: query.limit ?? 100, tool: query.tool })}`,
      ),
  },

  settings: {
    get: () => request<Settings>('GET', '/api/settings'),
    save: (patch: SettingsPatch) =>
      request<{ ok: boolean; llm: Settings['llm'] }>('PUT', '/api/settings', patch),
  },

  update: {
    /** 本地信息，不联网 */
    local: () => request<UpdateState>('GET', '/api/update'),
    /** 联网检查（服务端 30 秒内复用结果） */
    check: (force = false) =>
      request<UpdateState>('GET', `/api/update/check${force ? '?force=1' : ''}`),
    /** 执行更新：pull → 装依赖 → 重建前端。stash=true 时先 git stash 本地改动 */
    apply: (options: { stash?: boolean } = {}) =>
    request<ApplyUpdateResult>('POST', '/api/update/apply', { stash: options.stash === true }),
  },

  chat: {
    sessions: () => request<ChatSession[]>('GET', '/api/chat/sessions'),
    createSession: () => request<{ id: string; title: string }>('POST', '/api/chat/sessions', {}),
    messages: (id: string) =>
      request<ChatMessage[]>('GET', `/api/chat/sessions/${enc(id)}/messages`),
    deleteSession: (id: string) => request<void>('DELETE', `/api/chat/sessions/${enc(id)}`),
  },
};

/** 候选列表里后端可能少字段，这里做一次轻量归一，避免整页崩。 */
export function normalizeCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // id 可能是数字（sqlite 自增）或字符串，统一成字符串
  const id =
    typeof o.id === 'string' ? o.id : typeof o.id === 'number' ? String(o.id) : '';
  if (!id) return null;
  const payload = (o.payload && typeof o.payload === 'object' ? o.payload : {}) as Record<
    string,
    unknown
  >;
  return {
    id,
    jobId: typeof o.jobId === 'string' ? o.jobId : o.jobId === undefined ? '' : String(o.jobId),
    platformSlug: typeof o.platformSlug === 'string' ? o.platformSlug : '',
    payload: payload as unknown as EndpointInput,
    diffKind:
      o.diffKind === 'new' || o.diffKind === 'modified' || o.diffKind === 'conflict' || o.diffKind === 'duplicate'
        ? o.diffKind
        : 'new',
    targetEndpointId: typeof o.targetEndpointId === 'string' ? o.targetEndpointId : null,
    decision:
      o.decision === 'accept' || o.decision === 'reject' || o.decision === 'pending'
        ? o.decision
        : 'pending',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
  };
}

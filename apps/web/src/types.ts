/**
 * 前端契约类型副本（唯一来源：docs/api.md + packages/core/src/schema/asset.ts）。
 *
 * 刻意不 import `@aah/core`：它依赖 `node:sqlite`，在浏览器里会直接炸。
 * 后端字段有增减时，只改这个文件，别去动 packages/。
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type ParamLocation = 'path' | 'query' | 'header' | 'body' | 'cookie';
export type ParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'json';

export type AuthKind = 'none' | 'bearer' | 'header' | 'query' | 'basic';
export type EndpointStatus = 'draft' | 'published' | 'archived';
export type SideEffect = 'read' | 'write';
export type Sensitivity = 'low' | 'medium' | 'high';
export type ImportKind = 'curl' | 'har' | 'openapi' | 'text';
export type DiffKind = 'new' | 'modified' | 'conflict' | 'duplicate';
export type CandidateDecision = 'pending' | 'accept' | 'reject';
export type AuditChannel = 'rest' | 'mcp' | 'chat' | 'console';
export type Exposure = 'open' | 'restricted' | 'closed';
export type Role = 'admin' | 'member';

export const EXPOSURES: readonly Exposure[] = ['open', 'restricted', 'closed'];

export const EXPOSURE_LABEL: Record<Exposure, string> = {
  open: '公开',
  restricted: '指定令牌',
  closed: '关闭',
};

export const EXPOSURE_HINT: Record<Exposure, string> = {
  open: '任何有效 API Key 都能调用',
  restricted: '只有被勾选的 API Key 能调用',
  closed: '对外完全关闭，只能在控制台试运行',
};

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export const AUTH_KINDS: readonly AuthKind[] = ['none', 'bearer', 'header', 'query', 'basic'];
export const ENDPOINT_STATUSES: readonly EndpointStatus[] = ['draft', 'published', 'archived'];
export const PARAM_LOCATIONS: readonly ParamLocation[] = ['path', 'query', 'header', 'body', 'cookie'];
export const PARAM_TYPES: readonly ParamType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'array',
  'object',
  'json',
];
export const IMPORT_KINDS: readonly ImportKind[] = ['curl', 'har', 'openapi', 'text'];

/* ────────────────────────── 参数 / 请求体 / 响应 ────────────────────────── */

export interface Param {
  name: string;
  in: ParamLocation;
  type: ParamType;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: Array<string | number>;
  example?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: string;
  secretRef?: string;
}

export interface Body {
  contentType: string;
  encoding: 'json' | 'form' | 'multipart' | 'raw';
  required: boolean;
  schema: Record<string, unknown> | null;
  example: string | null;
  secretRef?: string;
}

export interface ResponseSpec {
  contentType: string;
  pick: string[];
  unwrap: string | null;
  transform: string | null;
  redactFields: string[];
  maxBytes: number;
}

/* ────────────────────────── 平台 ────────────────────────── */

export interface RateLimit {
  qps: number;
  daily: number;
}

export interface PlatformInput {
  slug: string;
  name: string;
  baseUrl: string;
  authKind: AuthKind;
  authConfig: Record<string, unknown>;
  defaultHeaders: Record<string, string>;
  egressAllowHosts: string[];
  rateLimit: RateLimit;
  allowPrivate: boolean;
  notes: string;
}

export interface Platform extends PlatformInput {
  id: string;
  /** 自动抓取的网站标题 */
  siteTitle?: string;
  /** 自动抓取的站点图标 */
  siteIcon?: string;
  createdAt: string;
  updatedAt: string;
}

/* ────────────────────────── 接口资产 ────────────────────────── */

export interface EndpointInput {
  slug: string;
  group: string;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  description: string;
  params: Param[];
  body: Body | null;
  response: ResponseSpec;
  sideEffect: SideEffect;
  sensitivity: Sensitivity;
  tags: string[];
  examples: Array<{ args: Record<string, unknown>; note?: string }>;
  notes: string;
  /** 对外开放策略 */
  exposure: Exposure;
  /** exposure=restricted 时允许调用的 api_key id */
  allowedKeyIds: string[];
  /** 对外名称：调用方看到的工具名，留空回退到 平台__接口 */
  publicName: string;
}

export interface Endpoint extends EndpointInput {
  id: string;
  platformId: string;
  platformSlug: string;
  status: EndpointStatus;
  version: number;
  contentHash: string;
  sourceKind: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

/* ────────────────────────── 工具 ────────────────────────── */

export interface ToolAnnotations {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

export interface Tool {
  id: string;
  name: string;
  namespace: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  cacheTtl: number;
  annotations: ToolAnnotations;
  enabled: boolean;
  platformSlug: string;
  endpointSlug: string;
  endpointId: string;
  createdAt: string;
  updatedAt: string;
}

/* ────────────────────────── 一键整理 ────────────────────────── */

export interface ImportProbeStats {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface ImportSite {
  slug: string;
  name: string;
  baseUrl: string;
  count: number;
}

export interface ImportStats {
  detected: string;
  parsed: number;
  candidates: number;
  duplicates: number;
  conflicts: number;
  aiUsed: boolean;
  aiEnriched: number;
  aiErrors: string[];
  platformsCreated: string[];
  autoPublished: number;
  /** Agent 流水线的一句话总结 */
  agentSummary?: string;
  /** 探测统计 */
  probe?: ImportProbeStats;
  /** Agent 流水线耗时（毫秒） */
  agentElapsedMs?: number;
  /** 本次涉及的站点（按 host 自动归组） */
  sites?: ImportSite[];
}

export type ImportStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ImportStep {
  key: string;
  label: string;
  status: ImportStepStatus;
  detail: string;
  startedAt?: string;
  endedAt?: string;
}

/** 异步导入的立即返回 */
export interface ImportStartResult {
  jobId: string;
  status: string;
}

export interface ImportRunResult {
  jobId: string;
  status: string;
  stats: ImportStats;
  error?: string | null;
}

export interface ImportJob {
  id: string;
  kind: string;
  status: string;
  stats?: ImportStats;
  error?: string | null;
  aiUsed?: boolean;
  steps?: ImportStep[];
  progress?: number;
  siteCount?: number;
  createdAt?: string;
  finishedAt?: string | null;
  isRunning?: boolean;
}

export interface Candidate {
  id: string;
  jobId: string;
  platformSlug: string;
  payload: EndpointInput;
  diffKind: DiffKind;
  targetEndpointId: string | null;
  decision: CandidateDecision;
  createdAt: string;
}

export interface ImportJobDetail {
  job: ImportJob;
  candidates: Candidate[];
}

/* ────────────────────────── 密钥 / API Key ────────────────────────── */

export interface SecretMeta {
  name: string;
  hint: string;
  createdAt: string;
  rotatedAt?: string | null;
}

export type QuotaPeriod = 'total' | 'daily' | 'monthly';

export const QUOTA_PERIODS: readonly QuotaPeriod[] = ['total', 'daily', 'monthly'];

export const QUOTA_PERIOD_LABEL: Record<QuotaPeriod, string> = {
  total: '总量',
  daily: '每天',
  monthly: '每月',
};

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  enabled: boolean;
  /** 归属账号 id；null 表示历史遗留的全局令牌 */
  accountId?: string | null;
  owner?: Account | null;
  /** 过期时间；null 表示永不过期 */
  expiresAt?: string | null;
  /** 额度上限；0 表示不限 */
  quotaLimit: number;
  quotaUsed: number;
  quotaPeriod: QuotaPeriod;
  quotaResetAt?: string | null;
  callCount: number;
  /** IP 白名单，支持精确 IP 与 CIDR；空数组表示不限制 */
  ipAllowlist: string[];
  notes: string;
  lastUsedAt?: string | null;
  createdAt: string;
}

/** 某个令牌可见的接口（控制台预览） */
export interface KeyEndpoint {
  id: string;
  slug: string;
  publicName: string;
  toolName: string;
  summary: string;
  notes: string;
  method: string;
  sideEffect: string;
  exposure: Exposure;
  platformSlug: string;
  callable: boolean;
}

export interface ApiKeyInput {  label: string;
  scopes?: string[];
  accountId?: string | null;
  expiresAt?: string | null;
  quotaLimit?: number;
  quotaPeriod?: QuotaPeriod;
  ipAllowlist?: string[];
  notes?: string;
}

export interface CreatedApiKey {
  id: string;
  key: string;
}

/* ────────────────────────── 账号 ────────────────────────── */

export interface Account {
  id: string;
  username: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface LoginResult {
  token: string;
  account: Account;
  expiresAt: string;
}

/* ────────────────────────── 审计 / 设置 / 指标 ────────────────────────── */

export interface Audit {
  id: string;
  ts: string;
  requestId: string;
  apiKeyId?: string | null;
  channel: AuditChannel;
  toolName: string;
  endpointId?: string | null;
  status: number;
  ok: boolean;
  latencyMs: number;
  upstreamHost: string;
  errorCode: string | null;
  reqMeta: Record<string, unknown>;
  respMeta: Record<string, unknown>;
}

export interface Stats {
  platforms: number;
  endpoints: number;
  published: number;
  tools: number;
  calls: {
    total: number;
    ok: number;
    failed: number;
    today: number;
    avgLatency: number;
  };
}

export interface Health {
  ok: boolean;
  version: string;
  llm: { enabled: boolean; model: string };
}

export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  timeoutMs?: number;
  concurrency?: number;
  /** 想开但缺 apiKey 时为 true */
  blockedByApiKey?: boolean;
}

export interface EgressSettings {
  allowPrivate: boolean;
  timeoutMs: number;
  maxBytes: number;
}

export interface Settings {
  llm: LlmSettings;
  egress: EgressSettings;
}

export interface SettingsPatch {
  llm?: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    /** 显式清除已存的 apiKey */
    clearApiKey?: boolean;
    model?: string;
    timeoutMs?: number;
    concurrency?: number;
  };
}

/* ────────────────────────── 试运行 ────────────────────────── */

export interface PlatformTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  sample: unknown;
}

export interface EndpointTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  data: unknown;
  upstreamHost: string;
}

/* ────────────────────────── 站内对话 ────────────────────────── */

export interface ChatSession {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface ChatToolCall {
  tool: string;
  args?: unknown;
  ok?: boolean;
  preview?: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  toolCalls?: ChatToolCall[];
  createdAt?: string;
  /** 后端消息体可能带额外字段（tool 名、usage 等），保留不丢。 */
  [key: string]: unknown;
}

export interface ChatStreamEvent {
  type: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  preview?: string;
  text?: string;
  messageId?: string;
  message?: string;
}

/* ────────────────── 在线更新 ────────────────── */

export interface UpdateState {
  version: string;
  isGit: boolean;
  branch: string;
  commit: string;
  shortCommit: string;
  commitSubject: string;
  commitDate: string;
  dirty: boolean;
  remote: string;
  upstream: string;
  hasUpstream: boolean;
  behind: number;
  ahead: number;
  latestCommit: string;
  latestSubject: string;
  canUpdate: boolean;
  message: string;
  checkedAt: string | null;
}

export interface UpdateStep {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface ApplyUpdateResult {
  ok: boolean;
  restarted: boolean;
  restartRequired: boolean;
  before: { commit: string; shortCommit: string };
  after: { commit: string; shortCommit: string };
  steps: UpdateStep[];
  message: string;
}

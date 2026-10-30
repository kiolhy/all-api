import { z } from 'zod';

/* ────────────────────────── 基础 ────────────────────────── */

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ParamLocationSchema = z.enum(['path', 'query', 'header', 'body', 'cookie']);
export type ParamLocation = z.infer<typeof ParamLocationSchema>;

export const ParamTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'enum',
  'array',
  'object',
  'json',
]);
export type ParamType = z.infer<typeof ParamTypeSchema>;

/** 参数。secretRef 指向 vault 中的密钥名，正文只存引用，永不落明文。 */
export const ParamSchema = z.object({
  name: z.string().min(1),
  in: ParamLocationSchema,
  type: ParamTypeSchema.default('string'),
  required: z.boolean().default(false),
  description: z.string().default(''),
  default: z.unknown().optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  example: z.unknown().optional(),
  pattern: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  items: z.string().optional(),
  secretRef: z.string().optional(),
});
export type Param = z.infer<typeof ParamSchema>;

export const BodySchema = z.object({
  contentType: z.string().default('application/json'),
  encoding: z.enum(['json', 'form', 'multipart', 'raw']).default('json'),
  required: z.boolean().default(false),
  /** JSON Schema 子集，用于给 AI 看结构 */
  schema: z.record(z.unknown()).nullable().default(null),
  /** 原始示例（可能是含 ${secret:NAME} 的字符串） */
  example: z.string().nullable().default(null),
  secretRef: z.string().optional(),
});
export type Body = z.infer<typeof BodySchema>;

export const ResponseSpecSchema = z.object({
  contentType: z.string().default('application/json'),
  /** 顶层字段白名单，空数组表示原样返回 */
  pick: z.array(z.string()).default([]),
  /** 取出某个字段作为最终结果，如 "data" 或 "data.items" */
  unwrap: z.string().nullable().default(null),
  /** 路径表达式投影，如 "data.items[].name" */
  transform: z.string().nullable().default(null),
  /** 需要脱敏的字段路径 */
  redactFields: z.array(z.string()).default([]),
  maxBytes: z.number().int().positive().default(2 * 1024 * 1024),
});
export type ResponseSpec = z.infer<typeof ResponseSpecSchema>;

/* ────────────────────────── 平台 ────────────────────────── */

export const AuthKindSchema = z.enum(['none', 'bearer', 'header', 'query', 'basic']);
export type AuthKind = z.infer<typeof AuthKindSchema>;

export const PlatformInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug 只能是小写字母、数字、下划线、连字符'),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  authKind: AuthKindSchema.default('none'),
  /** 鉴权配置，值可用 ${secret:NAME} 引用 vault */
  authConfig: z.record(z.unknown()).default({}),
  defaultHeaders: z.record(z.string()).default({}),
  /** 出网 host 白名单，空表示只允许 baseUrl 的 host */
  egressAllowHosts: z.array(z.string()).default([]),
  rateLimit: z
    .object({
      qps: z.number().positive().default(5),
      daily: z.number().int().positive().default(10000),
    })
    .default({ qps: 5, daily: 10000 }),
  allowPrivate: z.boolean().default(false),
  notes: z.string().default(''),
});
export type PlatformInput = z.infer<typeof PlatformInputSchema>;

export const PlatformRecordSchema = PlatformInputSchema.extend({
  id: z.string(),
  /** 自动抓取的网站标题 */
  siteTitle: z.string().default(''),
  /** 自动抓取的站点图标 */
  siteIcon: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlatformRecord = z.infer<typeof PlatformRecordSchema>;

/* ────────────────────────── 接口 ────────────────────────── */

/** 接口对外开放策略：open=任何有效令牌可调；restricted=仅指定令牌；closed=仅控制台试运行 */
export const ExposureSchema = z.enum(['open', 'restricted', 'closed']);
export type Exposure = z.infer<typeof ExposureSchema>;

export const EndpointInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug 只能是小写字母、数字、下划线、连字符'),
  group: z.string().default('default'),
  method: HttpMethodSchema,
  pathTemplate: z.string().startsWith('/'),
  summary: z.string().default(''),
  description: z.string().default(''),
  params: z.array(ParamSchema).default([]),
  body: BodySchema.nullable().default(null),
  response: ResponseSpecSchema.default({}),
  sideEffect: z.enum(['read', 'write']).default('read'),
  sensitivity: z.enum(['low', 'medium', 'high']).default('low'),
  tags: z.array(z.string()).default([]),
  examples: z
    .array(z.object({ args: z.record(z.unknown()), note: z.string().optional() }))
    .default([]),
  notes: z.string().default(''),
  /** 对外开放策略 */
  exposure: ExposureSchema.default('open'),
  /** exposure=restricted 时，允许调用它的 api_key id 列表 */
  allowedKeyIds: z.array(z.string()).default([]),
  /**
   * 对外名称：调用方看到的工具名。
   * 留空则回退到「平台__接口」；填了就用它，与上游路径无关，避免泄露上游结构。
   */
  publicName: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]*$/, '对外名称只能包含字母、数字、下划线、点、连字符')
    .default(''),
});
export type EndpointInput = z.infer<typeof EndpointInputSchema>;

export const EndpointStatusSchema = z.enum(['draft', 'published', 'archived']);
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

export const EndpointRecordSchema = EndpointInputSchema.extend({
  id: z.string(),
  platformId: z.string(),
  platformSlug: z.string(),
  status: EndpointStatusSchema,
  version: z.number().int(),
  contentHash: z.string(),
  sourceKind: z.string(),
  sourceRef: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EndpointRecord = z.infer<typeof EndpointRecordSchema>;

/* ────────────────────────── 工具（AI 侧视图） ────────────────────────── */

export const ToolAnnotationsSchema = z.object({
  readOnly: z.boolean().default(true),
  destructive: z.boolean().default(false),
  idempotent: z.boolean().default(true),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const ToolInputSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  title: z.string().default(''),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  cacheTtl: z.number().int().min(0).default(0),
  annotations: ToolAnnotationsSchema.default({}),
  /** 覆盖默认生成的描述前缀 */
  namespace: z.string().default(''),
});
export type ToolInput = z.infer<typeof ToolInputSchema>;

export const ToolRecordSchema = ToolInputSchema.extend({
  id: z.string(),
  endpointId: z.string(),
  platformSlug: z.string(),
  endpointSlug: z.string(),
  inputSchema: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ToolRecord = z.infer<typeof ToolRecordSchema>;

/* ────────────────────────── 导入 ────────────────────────── */

export const ImportKindSchema = z.enum(['curl', 'har', 'openapi', 'text', 'manual']);
export type ImportKind = z.infer<typeof ImportKindSchema>;

export const CandidateDecisionSchema = z.enum(['pending', 'accept', 'reject']);
export const DiffKindSchema = z.enum(['new', 'modified', 'conflict', 'duplicate']);

export const CandidateRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  platformSlug: z.string(),
  payload: EndpointInputSchema,
  diffKind: DiffKindSchema,
  targetEndpointId: z.string().nullable(),
  decision: CandidateDecisionSchema,
  createdAt: z.string(),
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

/* ────────────────────────── 审计 ────────────────────────── */

export const AuditRecordSchema = z.object({
  id: z.string(),
  ts: z.string(),
  requestId: z.string(),
  apiKeyId: z.string().nullable(),
  channel: z.enum(['rest', 'mcp', 'chat', 'console']),
  toolName: z.string(),
  endpointId: z.string().nullable(),
  status: z.number().int(),
  ok: z.boolean(),
  latencyMs: z.number().int(),
  upstreamHost: z.string(),
  errorCode: z.string().nullable(),
  /** 已认证主体：account:<id> / key:<id> / admin-token / anonymous（审计归因） */
  actor: z.string().nullable().default(null),
  reqMeta: z.record(z.unknown()),
  respMeta: z.record(z.unknown()),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/* ────────────────────────── 账号与会话 ────────────────────────── */

export const RoleSchema = z.enum(['admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

export const UsernameSchema = z
  .string()
  .min(2, '用户名至少 2 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[a-zA-Z0-9_.-]+$/, '用户名只能包含字母、数字、下划线、点、连字符');

export const AccountInputSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(6, '密码至少 6 位').max(128, '密码最多 128 位'),
  role: RoleSchema.default('member'),
});
export type AccountInput = z.infer<typeof AccountInputSchema>;

/** 对外返回的账号信息，永远不含密码哈希 */
export const AccountRecordSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: RoleSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const LoginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const ChangePasswordInputSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6, '新密码至少 6 位').max(128),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

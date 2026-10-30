import type { EndpointRecord, ToolAnnotations } from '../schema/asset.ts';
import { slugify } from '../import/normalize.ts';
import { coerceExample, paramHint, sanitizePublicText, semanticLabel } from './describe.ts';

export type CompiledTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  cacheTtl: number;
};

const MAX_NAME = 64;

export function toolName(platformSlug: string, endpointSlug: string): string {
  const clean = (s: string) => slugify(s).replace(/_+/g, '_').replace(/^_|_$/g, '');
  const head = clean(platformSlug);
  const tail = clean(endpointSlug);
  // 保留 platform__endpoint 双下划线分隔（不要被去重压缩成单个）
  let name = `${head}__${tail}`;
  if (name.length > MAX_NAME) name = `${head.slice(0, 24)}__${tail}`.slice(0, MAX_NAME);
  return name;
}

/**
 * 像域名 / IP / 带端口 / URL 的字符串。
 *
 * 平台名默认是从上游 host 推导的（`127.0.0.1:8899`、`api.github.com`），
 * 直接拿去拼工具名等于把上游地址写进对外接口名里。
 */
function looksHostish(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  return (
    /^https?:\/\//i.test(s) ||
    /^(\d{1,3}\.){3}\d{1,3}(:\d{2,5})?$/.test(s) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ||
    /:\d{2,5}$/.test(s) ||
    /^\d+$/.test(s)
  );
}

/**
 * 对外工具名。
 *
 * 优先级：
 * 1. `endpoint.publicName` —— 用户自己起的名，与上游无关
 * 2. `平台名__接口slug` —— 但平台名像 host 时改用中性前缀 `api`
 *
 * 绝不把上游 host/端口写进名字：网关把地址掩掉了，
 * 名字里再带一个 `x127_8899` 就等于白掩。
 */
export function resolveToolName(
  endpoint: EndpointRecord,
  opts: { platformName?: string } = {},
): string {
  const custom = (endpoint.publicName ?? '').trim();
  if (custom) return custom.slice(0, MAX_NAME);

  const platformName = (opts.platformName ?? '').trim();
  const head = platformName && !looksHostish(platformName) ? slugify(platformName, 'api') : 'api';
  return toolName(head, endpoint.slug);
}

function jsonTypeOf(param: EndpointRecord['params'][number]): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  switch (param.type) {
    case 'number':
      base.type = 'number';
      break;
    case 'integer':
      base.type = 'integer';
      break;
    case 'boolean':
      base.type = 'boolean';
      break;
    case 'array':
      base.type = 'array';
      base.items = { type: param.items ?? 'string' };
      break;
    case 'object':
    case 'json':
      base.type = 'object';
      break;
    case 'enum':
      base.type = typeof param.enum?.[0] === 'number' ? 'number' : 'string';
      if (param.enum?.length) base.enum = param.enum;
      break;
    default:
      base.type = 'string';
  }
  if (param.description?.trim()) {
    base.description = param.description.trim();
  } else {
    // AI 没给说明时也得让调用方看懂，不能留空
    base.description = paramHint(param);
  }
  if (param.default !== undefined && param.secretRef === undefined) base.default = param.default;
  if (param.pattern) base.pattern = param.pattern;
  if (param.minimum !== undefined) base.minimum = param.minimum;
  if (param.maximum !== undefined) base.maximum = param.maximum;
  if (param.example !== undefined) {
    const example = coerceExample(param.example, String(base.type));
    if (example !== undefined) base.examples = [example];
  }
  return base;
}

/** Endpoint → AI 可调用的工具定义 */
export function compileTool(endpoint: EndpointRecord, opts: { platformName?: string } = {}): CompiledTool {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of endpoint.params) {
    if (p.secretRef) continue; // 密钥由服务端注入，不给 AI
    // 传输层头交给网关默认值，不暴露给 AI 增加噪音
    if (p.in === 'header' && /^(accept|content-type|content-encoding|accept-encoding)$/i.test(p.name)) continue;
    const key = p.in === 'path' || p.in === 'query' || p.in === 'body' ? p.name : `${p.in}_${p.name}`;
    const schema = jsonTypeOf(p);
    if (p.in === 'header') schema.description = `[header:${p.name}] ${String(schema.description ?? '')}`.trim();
    if (p.in === 'cookie') schema.description = `[cookie:${p.name}] ${String(schema.description ?? '')}`.trim();
    props[key] = schema;
    if (p.required) required.push(key);
  }

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: props,
    additionalProperties: false,
  };
  if (required.length) inputSchema.required = required;

  // 对外文案：标题/描述一律清洗，绝不把 `GET /api/v1/orders` 递给调用方
  const label = semanticLabel(endpoint.method, endpoint.pathTemplate);
  const title = sanitizePublicText(endpoint.summary, label);
  const descParts: string[] = [];
  descParts.push(title);
  const extra = sanitizePublicText(endpoint.description, '');
  if (extra && extra !== title) descParts.push(extra);
  if (endpoint.sideEffect === 'write') descParts.push('⚠️ 该接口会修改数据');
  const secretParams = endpoint.params.filter((p) => p.secretRef);
  if (secretParams.length) descParts.push('鉴权由网关自动注入，无需传 token。');
  // 参数清单也写进描述：MCP 客户端不一定渲染 inputSchema，读文字更保险
  const visibleParams = endpoint.params.filter(
    (p) => !p.secretRef && !(p.in === 'header' && /^(accept|content-type|content-encoding|accept-encoding)$/i.test(p.name)),
  );
  if (visibleParams.length) {
    const lines = visibleParams.map((p) => {
      const hint = p.description?.trim() || paramHint(p);
      return `- ${p.name}（${p.in}${p.required ? '，必填' : ''}）：${hint}`;
    });
    descParts.push(`参数：\n${lines.join('\n')}`);
  }

  return {
    name: resolveToolName(endpoint, opts),
    title,
    description: descParts.join('\n'),
    inputSchema,
    annotations: {
      readOnly: endpoint.sideEffect === 'read',
      destructive: endpoint.method === 'DELETE',
      idempotent: endpoint.sideEffect === 'read' || endpoint.method === 'PUT',
    },
    cacheTtl: endpoint.sideEffect === 'read' ? 30 : 0,
  };
}

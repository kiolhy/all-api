import type { EndpointRecord, Param, PlatformRecord } from '../schema/asset.ts';
import { hubError } from './guard.ts';
import { resolveSecretRefs } from '../secrets/vault.ts';
import { safeJsonParse } from '../util/json.ts';

export type BuildContext = {
  platform: PlatformRecord;
  endpoint: EndpointRecord;
  args: Record<string, unknown>;
  secretValue: (name: string) => string;
};

export type BuiltRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  upstreamHost: string;
};

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function coerce(param: Param, value: unknown): unknown {
  switch (param.type) {
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) throw hubError('invalid_arg', `参数 ${param.name} 需要数字`, 400);
      return param.type === 'integer' ? Math.trunc(n) : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      throw hubError('invalid_arg', `参数 ${param.name} 需要布尔值`, 400);
    }
    case 'array':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
      return [value];
    case 'object':
    case 'json':
      if (typeof value === 'string') return safeJsonParse(value, value);
      return value;
    case 'enum':
      if (param.enum && !param.enum.some((e) => String(e) === String(value))) {
        throw hubError('invalid_arg', `参数 ${param.name} 只能是 ${param.enum.join(' / ')}`, 400);
      }
      return value;
    default:
      return asString(value);
  }
}

/** 用平台鉴权配置补齐鉴权（接口自身声明的鉴权头优先级更高） */
function applyPlatformAuth(
  platform: PlatformRecord,
  headers: Record<string, string>,
  query: URLSearchParams,
  secretValue: (name: string) => string,
): void {
  const cfg = platform.authConfig as Record<string, unknown>;
  const ref = typeof cfg.secretRef === 'string' ? cfg.secretRef : undefined;
  const template = ref ? `\${secret:${ref}}` : '';

  switch (platform.authKind) {
    case 'bearer':
      if (template) headers['Authorization'] = `Bearer ${template}`;
      break;
    case 'header': {
      const name = typeof cfg.header === 'string' ? cfg.header : 'X-API-Key';
      if (template) headers[name] = template;
      break;
    }
    case 'query': {
      const name = typeof cfg.queryParam === 'string' ? cfg.queryParam : 'key';
      if (template) query.set(name, template);
      break;
    }
    case 'basic': {
      const user = typeof cfg.username === 'string' ? cfg.username : '';
      const passRef = typeof cfg.passwordRef === 'string' ? cfg.passwordRef : '';
      if (passRef) {
        const pass = secretValue(passRef);
        headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      }
      break;
    }
    default:
      break;
  }
}

export function buildRequest(ctx: BuildContext): BuiltRequest {
  const { platform, endpoint, args } = ctx;

  const paramByName = new Map<string, Param>();
  for (const p of endpoint.params) paramByName.set(p.name, p);

  // 1. 校验入参：只允许声明过的参数
  const declared = new Set(endpoint.params.filter((p) => !p.secretRef).map((p) => p.name));
  for (const key of Object.keys(args)) {
    const bare = key.replace(/^(?:header|cookie)_/, '');
    if (!declared.has(bare)) {
      throw hubError('unknown_arg', `未声明的参数：${key}`, 400);
    }
  }

  // 2. 路径
  let path = endpoint.pathTemplate;
  for (const p of endpoint.params) {
    if (p.in !== 'path') continue;
    const raw = args[p.name];
    // 只允许用显式 default 兜底；示例值(example)绝不能当成真实入参
    let value = raw;
    if (value === undefined || value === null || value === '') value = p.default;
    if (value === undefined || value === null || value === '') {
      throw hubError('missing_arg', `缺少路径参数 ${p.name}`, 400);
    }
    const encoded = encodeURIComponent(asString(value));
    if (encoded.includes('..') || encoded.includes('%2F') || encoded.includes('/')) {
      throw hubError('invalid_arg', `路径参数 ${p.name} 含非法字符`, 400);
    }
    path = path.replace(`{${p.name}}`, encoded);
  }
  if (/\{[^}]+\}/.test(path)) throw hubError('missing_arg', `路径占位符未全部填充：${path}`, 400);

  // 3. 平台默认头 + 鉴权
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(platform.defaultHeaders)) {
    headers[k] = resolveSecretRefs(v, ctx.secretValue);
  }
  applyPlatformAuth(platform, headers, query, ctx.secretValue);

  // 4. query / header / cookie 参数
  const cookies: string[] = [];
  for (const p of endpoint.params) {
    const raw = args[p.name];
    const value = raw === undefined || raw === null || raw === '' ? undefined : coerce(p, raw);

    if (p.in === 'query') {
      if (value !== undefined) query.set(p.name, asString(value));
      continue;
    }
    if (p.in === 'header') {
      if (value !== undefined) {
        headers[p.name] = asString(value);
      } else if (p.default !== undefined) {
        headers[p.name] = resolveSecretRefs(asString(p.default), ctx.secretValue);
      } else if (p.required && !p.secretRef) {
        throw hubError('missing_arg', `缺少请求头参数 ${p.name}`, 400);
      }
      continue;
    }
    if (p.in === 'cookie') {
      const v = value ?? p.default;
      if (v !== undefined) cookies.push(`${p.name}=${asString(v)}`);
      continue;
    }
    if (p.in === 'path') continue;
  }

  // 兼容以 header_ / cookie_ 前缀传入
  for (const [k, v] of Object.entries(args)) {
    const hm = /^header_(.+)$/.exec(k);
    if (hm) headers[hm[1]] = asString(v);
    const cm = /^cookie_(.+)$/.exec(k);
    if (cm) cookies.push(`${cm[1]}=${asString(v)}`);
  }
  if (cookies.length) headers['Cookie'] = cookies.join('; ');

  // 5. body
  let body: string | null = null;
  const bodyParams = endpoint.params.filter((p) => p.in === 'body');
  if (endpoint.body) {
    const enc = endpoint.body.encoding;
    const exampleRaw = endpoint.body.example ? resolveSecretRefs(endpoint.body.example, ctx.secretValue) : null;

    if (enc === 'json') {
      let base: unknown = {};
      if (exampleRaw) {
        const parsed = safeJsonParse<unknown>(exampleRaw, undefined);
        base = parsed === undefined ? {} : parsed;
      }
      if (bodyParams.length && base && typeof base === 'object' && !Array.isArray(base)) {
        const obj = { ...(base as Record<string, unknown>) };
        for (const p of bodyParams) {
          const raw = args[p.name];
          if (raw !== undefined && raw !== null && raw !== '') obj[p.name] = coerce(p, raw);
          else if (p.default !== undefined) obj[p.name] = p.default;
        }
        base = obj;
      }
      if (base && (typeof base !== 'object' || Object.keys(base as object).length)) {
        body = JSON.stringify(base);
      }
    } else if (enc === 'form') {
      const sp = new URLSearchParams();
      if (exampleRaw) {
        for (const [k, v] of new URLSearchParams(exampleRaw)) sp.set(k, v);
      }
      for (const p of bodyParams) {
        const raw = args[p.name];
        if (raw !== undefined && raw !== null && raw !== '') sp.set(p.name, asString(coerce(p, raw)));
      }
      body = sp.toString();
    } else if (enc === 'multipart') {
      if (exampleRaw) {
        if (exampleRaw.includes('<FILE:')) {
          throw hubError('unsupported_body', '该接口需要文件上传，请在接口资产里改用 JSON 或自定义预处理器', 400);
        }
        body = exampleRaw;
      }
    } else if (exampleRaw) {
      body = exampleRaw;
    }
  }

  // 6. URL
  const base = platform.baseUrl.replace(/\/$/, '');
  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;

  // 7. 头部收尾
  if (body !== null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = endpoint.body?.contentType ?? 'application/json';
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
    headers['Accept'] = 'application/json';
  }

  // 8. 解析所有 ${secret:...}（此时才接触明文）
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resolvedHeaders[k] = resolveSecretRefs(v, ctx.secretValue);
  }
  const finalBody = body === null ? null : resolveSecretRefs(body, ctx.secretValue);

  const upstreamHost = new URL(url).host;

  return {
    url,
    method: endpoint.method,
    headers: resolvedHeaders,
    body: finalBody,
    upstreamHost,
  };
}

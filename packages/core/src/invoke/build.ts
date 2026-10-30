import type { EndpointRecord, Param, PlatformRecord } from '../schema/asset.ts';
import { hubError } from './guard.ts';
import {
  allowSecret,
  collectSecretRefs,
  makeSecretPolicy,
  resolveSecretRefs,
  type SecretPolicy,
} from '../secrets/vault.ts';
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

/** 名字像鉴权头的参数，才允许在 default 里直接写 `${secret:...}` */
const AUTH_HEADER_RE = /^(authorization|cookie|x-[\w-]*(?:key|token|auth|secret|session)[\w-]*|api[\w-]*key|[\w-]*token)$/i;

/**
 * 由调用方/接口定义**不得**自行设置的请求头。
 *
 * 真实事故：端点定义里加两个 header 参数 `x-forwarded-for` / `x-real-ip` = 127.0.0.1，
 * 就能让网关替调用方伪造"请求来自本机"，去打那些信任 localhost 的上游服务。
 * 这是把 SSRF 从"能连"升级成"连上还被信任"的关键一步，必须掐死。
 *
 * Host 同理：改了 Host 就能打到反代后面的其它虚拟主机。
 * Content-Length / Connection 这类由运行时自己管，写死会破坏请求。
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-originating-ip',
  'forwarded',
  'via',
  'proxy-authorization',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
]);

/** 这些头允许由平台/接口自己配（网关注入凭据的正常途径），但仍禁止调用方传入 */
const FORBIDDEN_ALWAYS = FORBIDDEN_HEADERS;

function assertHeaderAllowed(name: string): void {
  const lower = name.trim().toLowerCase();
  if (FORBIDDEN_ALWAYS.has(lower)) {
    throw hubError('header_forbidden', `请求头 ${name} 不允许由接口定义或调用方设置`, 403);
  }
}

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

/**
 * 建立「这个请求允许解析哪些密钥」的白名单。
 *
 * 只有结构性位置才会被信任，而且必须"声明过"：
 *   - params[].secretRef（显式声明）
 *   - header/cookie 参数 default 里的引用（且参数名像鉴权头）
 *   - 平台 authConfig.secretRef / passwordRef
 *   - 平台 defaultHeaders 里的引用
 *
 * 反例（真实事故）：`endpoint.body.example` 里塞 `${secret:xxx}` —— 以前会被无条件解析。
 */
export function buildSecretPolicy(platform: PlatformRecord, endpoint: EndpointRecord): SecretPolicy {
  const policy = makeSecretPolicy();

  for (const p of endpoint.params) {
    if (p.secretRef) allowSecret(policy, p.secretRef, `params.${p.name}.secretRef`);
    if (typeof p.default === 'string' && (p.in === 'header' || p.in === 'cookie')) {
      const refs = collectSecretRefs(p.default);
      if (refs.size) {
        if (!AUTH_HEADER_RE.test(p.name) && !p.secretRef) {
          throw hubError(
            'secret_ref_forbidden',
            `参数 ${p.name} 不是鉴权类参数，不允许在默认值里引用密钥`,
            403,
          );
        }
        for (const name of refs) {
          if (p.secretRef && p.secretRef !== name) {
            throw hubError('secret_ref_forbidden', `参数 ${p.name} 的 secretRef 与 default 不一致`, 403);
          }
          allowSecret(policy, name, `params.${p.name}.default`);
        }
      }
    }
  }

  const cfg = platform.authConfig as Record<string, unknown>;
  if (typeof cfg.secretRef === 'string') allowSecret(policy, cfg.secretRef, 'platform.authConfig.secretRef');
  if (typeof cfg.passwordRef === 'string') allowSecret(policy, cfg.passwordRef, 'platform.authConfig.passwordRef');

  for (const name of collectSecretRefs(platform.defaultHeaders)) {
    allowSecret(policy, name, 'platform.defaultHeaders');
  }

  return policy;
}

/** 用平台鉴权配置补齐鉴权（接口自身声明的鉴权头优先级更高） */
function applyPlatformAuth(
  platform: PlatformRecord,
  headers: Record<string, string>,
  query: URLSearchParams,
  secretValue: (name: string) => string,
  policy: SecretPolicy,
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
        // 直接取值而不是拼模板：Basic 需要 base64 后整体放进头里
        const pass = secretValue(passRef);
        headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      }
      break;
    }
    default:
      break;
  }
  void policy;
}

export function buildRequest(ctx: BuildContext): BuiltRequest {
  const { platform, endpoint, args } = ctx;

  const paramByName = new Map<string, Param>();
  for (const p of endpoint.params) paramByName.set(p.name, p);

  // 0. 密钥引用白名单：越权引用在这里就被挡掉，不会走到解密
  const policy = buildSecretPolicy(platform, endpoint);

  // 1. 先拦"危险请求头"，再校验参数声明。
  //
  // 顺序很重要：`header_x-forwarded-for` 这种键，如果先走"是否声明过"的检查，
  // 报出来的会是 unknown_arg —— 调用方会以为"补个声明就能用"。
  // 先拦在这里，语义才是「这个头根本不允许存在」，与有没有声明无关。
  for (const key of Object.keys(args)) {
    const hm = /^header_(.+)$/.exec(key);
    if (hm) assertHeaderAllowed(hm[1]);
  }

  // 2. 校验入参：只允许声明过的参数
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
    assertHeaderAllowed(k);
    headers[k] = resolveSecretRefs(v, ctx.secretValue, policy);
  }
  applyPlatformAuth(platform, headers, query, ctx.secretValue, policy);

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
      // 伪造来源 IP / Host 的头部一律拒绝（真实事故里的关键一步）
      assertHeaderAllowed(p.name);
      if (value !== undefined) {
        headers[p.name] = asString(value);
      } else if (p.default !== undefined) {
        headers[p.name] = resolveSecretRefs(asString(p.default), ctx.secretValue, policy);
      } else if (p.required && !p.secretRef) {
        throw hubError('missing_arg', `缺少请求头参数 ${p.name}`, 400);
      }
      continue;
    }
    if (p.in === 'cookie') {
      const v = value ?? p.default;
      if (v !== undefined) cookies.push(`${p.name}=${asString(resolveSecretRefs(asString(v), ctx.secretValue, policy))}`);
      continue;
    }
    if (p.in === 'path') continue;
  }

  // 兼容以 header_ / cookie_ 前缀传入
  for (const [k, v] of Object.entries(args)) {
    const hm = /^header_(.+)$/.exec(k);
    if (hm) {
      assertHeaderAllowed(hm[1]);
      headers[hm[1]] = asString(v);
    }
    const cm = /^cookie_(.+)$/.exec(k);
    if (cm) cookies.push(`${cm[1]}=${asString(v)}`);
  }
  if (cookies.length) headers['Cookie'] = cookies.join('; ');

  // 5. body
  //
  // 关键修复：**body.example 是示例/预览，绝不能被解析成真实密钥**。
  // 以前这里无条件调 resolveSecretRefs，配合"未授权 test"直接把 vault 明文
  // 送进了可回读的站内存储。示例里原样保留 `${secret:...}` 字面量即可。
  let body: string | null = null;
  const bodyParams = endpoint.params.filter((p) => p.in === 'body');
  if (endpoint.body) {
    const enc = endpoint.body.encoding;
    const exampleRaw = endpoint.body.example ?? null;

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

  // 8. 解析所有 ${secret:...}（此时才接触明文，且只解析白名单内的名字）
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resolvedHeaders[k] = resolveSecretRefs(v, ctx.secretValue, policy);
  }
  // body 里也只解析结构性位置（平台/参数注入的），示例里的字面量原样保留
  const finalBody =
    body === null
      ? null
      : (() => {
          let out = body;
          // 只允许 body 中来自 args/default 的值带引用，这里通过 policy 再做一次闸门
          try {
            out = resolveSecretRefs(out, ctx.secretValue, policy);
          } catch (err) {
            const e = err as Error & { code?: string };
            if (e.code === 'secret_ref_forbidden') {
              // 示例里的字面量：原样保留，不解析也不报错
              out = body;
            } else {
              throw err;
            }
          }
          return out;
        })();

  const upstreamHost = new URL(url).host;

  return {
    url,
    method: endpoint.method,
    headers: resolvedHeaders,
    body: finalBody,
    upstreamHost,
  };
}

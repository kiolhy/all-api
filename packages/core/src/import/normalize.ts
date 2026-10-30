import type { Body, EndpointInput, HttpMethod, Param, ParamType } from '../schema/asset.ts';
import type { NormalizedDraft, PendingSecret, RequestSpec } from './types.ts';
import { SECRET_REF_RE } from '../secrets/vault.ts';
import { safeJsonParse } from '../util/json.ts';
import { semanticLabel } from '../tools/describe.ts';

/* ────────────────────────── slug 工具 ────────────────────────── */

export function slugify(input: string, fallback = 'item'): string {
  const s = input
    .replace(/https?:\/\//g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const cleaned = s.replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `x${cleaned}` : cleaned;
}

/** api.github.com → github；open.example.co.uk → example */
export function platformSlugFromHost(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  const stripped = labels.filter((l) => !['api', 'www', 'open', 'gateway', 'gw', 'rest', 'openapi', 'dev'].includes(l));
  const pool = stripped.length ? stripped : labels;
  if (pool.length >= 2) {
    const tld = pool[pool.length - 1];
    if (['com', 'net', 'org', 'io', 'cn', 'co', 'dev', 'app'].includes(tld) && pool.length >= 2) {
      return slugify(pool[pool.length - 2] ?? 'api');
    }
    return slugify(pool[0] ?? 'api');
  }
  return slugify(pool[0] ?? 'api');
}

/**
 * 站点标识：host + 非默认端口。
 *
 * `127.0.0.1:8899` 和 `127.0.0.1:8898` 是两个不同的服务，
 * 只用 hostname 会把它们错并成一个站点（连标题都串了）。
 * 标准端口（80/443）不写进 slug，保持干净。
 */
export function siteKeyFromUrl(url: URL): string {
  const base = platformSlugFromHost(url.hostname);
  const port = url.port;
  if (!port || port === '80' || port === '443') return base;
  return slugify(`${base}_${port}`);
}

/* ────────────────────────── 备注兜底 ────────────────────────── */

/**
 * 方法 + 路径 → 一句话备注。
 *
 * 这是 **AI 未启用时的兜底**：以前 notes 直接是空串，用户整理完什么都看不到。
 * 现在至少给出「查询 orders 列表」这种可读说明，并明确标注未经 AI 分析。
 * AI 分析成功时 applyAnalysis 会整段覆盖，不会和这里打架。
 *
 * 注意：**不再把 `（GET /api/v1/orders）` 拼进去**。notes 会经 /gw/v1/me
 * 递给调用方，带上路径等于把上游结构送出去。
 */
export function fallbackNotes(method: string, pathTemplate: string): string {
  return `${semanticLabel(method, pathTemplate)}\n（规则生成，未经 AI 分析）`;
}

/* ────────────────────────── 噪声头 ────────────────────────── */

const NOISE_HEADERS = new Set(
  [
    'host',
    'content-length',
    'connection',
    'accept-encoding',
    'user-agent',
    'referer',
    'origin',
    'cache-control',
    'pragma',
    'upgrade-insecure-requests',
    'accept-language',
    'dnt',
    'priority',
    'te',
    'if-none-match',
    'if-modified-since',
    'content-md5',
    'expect',
    'x-requested-with',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
  ].map((h) => h.toLowerCase()),
);

const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'private-token',
  'x-token',
  'token',
  'x-signature',
  'x-sign',
  'x-csrf-token',
  'x-xsrf-token',
  'cookie',
]);

const SECRET_VALUE_RE = /^(?:bearer|token|basic)\s+\S{8,}$/i;
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_\-.]{24,}$/;

export function isLikelySecretValue(v: string): boolean {
  if (SECRET_VALUE_RE.test(v)) return true;
  if (HIGH_ENTROPY_RE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return true;
  if (/^(?:sk|pk|ghp|glpat|xoxb)-/i.test(v)) return true;
  return false;
}

/* ────────────────────────── 路径模板 ────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX24_RE = /^[0-9a-f]{16,}$/i;

function isDynamicSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (UUID_RE.test(seg)) return true;
  if (HEX24_RE.test(seg)) return true;
  if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return true;
  return false;
}

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

export function buildPathTemplate(pathname: string): { template: string; pathParams: Array<{ name: string; example: string }> } {
  // new URL() 会把 {id} 编码成 %7Bid%7D。{id} 是路径参数占位符，
  // 不还原的话会被当成字面量段，导致「按 ID 查详情」识别不出来、工具名里还带一串 7_bid_7_d。
  const decoded = pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  const segs = decoded.split('/');
  const pathParams: Array<{ name: string; example: string }> = [];
  const used = new Set<string>();

  const uniqueName = (raw: string): string => {
    let name = raw;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}${i}`)) i++;
      name = `${name}${i}`;
    }
    used.add(name);
    return name;
  };

  const out = segs.map((seg, idx) => {
    if (!seg) return seg;

    // 已经是占位符写法：{id} / {order_id} / :id —— 直接用名字
    const placeholder = /^\{([A-Za-z_][\w-]*)\}$/.exec(seg) ?? /^:([A-Za-z_][\w-]*)$/.exec(seg);
    if (placeholder) {
      const name = uniqueName(placeholder[1]!);
      // 占位符不是真实值，example 留空，避免探测拿 "{id}" 去请求上游
      pathParams.push({ name, example: '' });
      return `{${name}}`;
    }

    if (!isDynamicSegment(seg)) return seg;
    const prev = segs[idx - 1] ?? '';
    const base = prev ? singular(prev).replace(/[^A-Za-z0-9]/g, '') : 'id';
    const camel = base ? `${base.charAt(0).toLowerCase()}${base.slice(1)}` : 'id';
    const candidate = /id$/i.test(camel) ? camel : `${camel}Id`;
    const name = uniqueName(candidate);
    pathParams.push({ name, example: seg });
    return `{${name}}`;
  });
  return { template: out.join('/') || '/', pathParams };
}

/* ────────────────────────── 类型推断 ────────────────────────── */

function inferType(value: unknown): ParamType {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

function looksNumeric(v: string): boolean {
  return v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(?:\.\d+)?$/.test(v);
}

/* ────────────────────────── 主流程 ────────────────────────── */

export type NormalizeOptions = {
  platformSlug?: string;
  platformName?: string;
  /** 已有平台则不需要重复建 */
  existingPlatformSlugs?: string[];
};

export function specToDraft(spec: RequestSpec, opts: NormalizeOptions = {}): NormalizedDraft | null {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return null;
  }

  const platformSlug = opts.platformSlug ?? siteKeyFromUrl(url);
  const platformBaseUrl = url.origin;
  // 用 host（含端口）作为兜底名，端口不同才是不同服务
  const platformName = opts.platformName ?? url.host.replace(/^api\./, '');

  const secrets: PendingSecret[] = [];
  const params: Param[] = [];
  const seen = new Set<string>();

  const addParam = (p: Param) => {
    const key = `${p.in}:${p.name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    params.push(p);
  };

  // ── 路径 ──
  const { template, pathParams } = buildPathTemplate(url.pathname);
  for (const pp of pathParams) {
    addParam({
      name: pp.name,
      in: 'path',
      type: 'string',
      required: true,
      description: pp.example ? `路径参数，示例值 ${pp.example}` : '路径参数，需调用方提供',
      ...(pp.example ? { example: pp.example } : {}),
    });
  }

  // ── query ──
  for (const [k, v] of Object.entries(spec.query)) {
    addParam({
      name: k,
      in: 'query',
      type: looksNumeric(v) ? 'number' : 'string',
      required: false,
      description: '',
      example: v,
    });
  }

  // ── header ──
  for (const [k, v] of Object.entries(spec.headers)) {
    const lower = k.toLowerCase();
    if (NOISE_HEADERS.has(lower)) continue;
    if (lower.startsWith('sec-') || lower.startsWith('x-forwarded-')) continue;

    if (SECRET_HEADER_NAMES.has(lower) || isLikelySecretValue(v)) {
      const secretName = `${platformSlug}_${lower.replace(/[^a-z0-9]+/g, '_')}`;
      let templateValue = v;
      if (SECRET_REF_RE.test(v)) {
        SECRET_REF_RE.lastIndex = 0;
        templateValue = v;
      } else {
        const bearer = /^(bearer)\s+(.+)$/i.exec(v);
        if (bearer) {
          templateValue = `${bearer[1]} \${secret:${secretName}}`;
          secrets.push({ name: secretName, value: bearer[2] ?? v, hint: `${url.hostname} ${k} (Bearer)` });
        } else {
          templateValue = `\${secret:${secretName}}`;
          secrets.push({ name: secretName, value: v, hint: `${url.hostname} ${k}` });
        }
      }
      addParam({
        name: k,
        in: 'header',
        type: 'string',
        required: true,
        description: '鉴权头，由密钥库自动注入，调用方无需填写',
        default: templateValue,
        secretRef: secretName,
      });
      continue;
    }

    addParam({
      name: k,
      in: 'header',
      type: 'string',
      required: false,
      description: '',
      ...(v ? { default: v, example: v } : {}),
    });
  }

  // ── body ──
  let body: Body | null = null;
  if (spec.bodyRaw && spec.bodyRaw.length) {
    const ct = spec.bodyContentType ?? 'application/json';
    const isJson = /json/i.test(ct) || /^\s*[[{]/.test(spec.bodyRaw);

    if (isJson) {
      const parsed = safeJsonParse<unknown>(spec.bodyRaw, undefined);
      const exampleObj = scrubBodySecrets(parsed, platformSlug, secrets);
      if (exampleObj && typeof exampleObj === 'object' && !Array.isArray(exampleObj)) {
        for (const [k, v] of Object.entries(exampleObj as Record<string, unknown>)) {
          addParam({
            name: k,
            in: 'body',
            type: inferType(v),
            required: false,
            description: '',
            example: typeof v === 'object' ? undefined : v,
          });
        }
      }
      body = {
        contentType: ct,
        encoding: 'json',
        required: true,
        schema: jsonShape(exampleObj),
        example: typeof exampleObj === 'string' ? exampleObj : JSON.stringify(exampleObj, null, 2),
      };
    } else if (/x-www-form-urlencoded/i.test(ct)) {
      const sp = new URLSearchParams(spec.bodyRaw);
      for (const [k, v] of sp) {
        addParam({
          name: k,
          in: 'body',
          type: looksNumeric(v) ? 'number' : 'string',
          required: false,
          description: '',
          example: v,
        });
      }
      body = {
        contentType: 'application/x-www-form-urlencoded',
        encoding: 'form',
        required: true,
        schema: null,
        example: spec.bodyRaw,
      };
    } else {
      body = {
        contentType: ct,
        encoding: 'multipart',
        required: true,
        schema: null,
        example: spec.bodyRaw,
      };
    }
  }

  const method = spec.method;
  const slug = buildEndpointSlug(method, template);

  const endpoint: EndpointInput = {
    slug,
    group: (template.split('/').filter(Boolean)[0] ?? 'default').replace(/[^a-z0-9_-]/gi, '') || 'default',
    method,
    pathTemplate: template,
    summary: `${method} ${template}`,
    description: '',
    params,
    body,
    response: {
      contentType: 'application/json',
      pick: [],
      unwrap: null,
      transform: null,
      redactFields: [],
      maxBytes: 2 * 1024 * 1024,
    },
    sideEffect: method === 'GET' || method === 'HEAD' ? 'read' : 'write',
    sensitivity: method === 'DELETE' ? 'high' : method === 'GET' ? 'low' : 'medium',
    tags: [spec.source],
    examples: [],
    notes: fallbackNotes(method, template),
    exposure: 'open',
      publicName: '',
    allowedKeyIds: [],
  };

  return { platformSlug, platformBaseUrl, platformName, endpoint, secrets };
}

function buildEndpointSlug(method: HttpMethod, template: string): string {
  const segs = template
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_'));
  const base = segs.join('_') || 'root';
  return slugify(`${method.toLowerCase()}_${base}`);
}

/** 把 body 里的字面密钥替换成 ${secret:NAME} */
function scrubBodySecrets(value: unknown, platformSlug: string, secrets: PendingSecret[]): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubBodySecrets(v, platformSlug, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && /token|secret|password|passwd|apikey|api_key|key/i.test(k) && isLikelySecretValue(v)) {
        const name = `${platformSlug}_body_${k.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
        secrets.push({ name, value: v, hint: `请求体字段 ${k}` });
        out[k] = `\${secret:${name}}`;
      } else {
        out[k] = scrubBodySecrets(v, platformSlug, secrets);
      }
    }
    return out;
  }
  return value;
}

/** 从示例推断 JSON Schema 形状（给 AI 看，不求精确） */
function jsonShape(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? (jsonShape(value[0], depth + 1) ?? {}) : {} };
  }
  if (value && typeof value === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      props[k] = jsonShape(v, depth + 1) ?? { type: 'string' };
    }
    return { type: 'object', properties: props };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (value === null) return { type: 'null' };
  return { type: 'string' };
}

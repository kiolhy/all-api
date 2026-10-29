/**
 * 脱敏：保证上游 host、密钥明文、敏感字段不会出现在响应 / 日志 / 审计里。
 */

const MASK = '***';

/** 已解析出来的密钥明文值，全部替换掉 */
export function scrubSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (!v || v.length < 4) continue;
    out = out.split(v).join(MASK);
  }
  return out;
}

/** 通用密钥模式（用于兜底，避免漏网） */
const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/\b(sk|pk|ak|rk)-[A-Za-z0-9]{12,}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, MASK],
  [/((?:api[-_]?key|apikey|access[-_]?token|secret|password|passwd|token)["'\s:=]{1,4})[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
];

export function scrubPatterns(text: string): string {
  let out = text;
  for (const [re, rep] of GENERIC_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function scrubAll(text: string, secretValues: string[] = []): string {
  return scrubPatterns(scrubSecrets(text, secretValues));
}

function pathParts(path: string): string[] {
  return path.split('.').filter(Boolean);
}

/** 按字段路径脱敏对象（原地拷贝） */
export function redactPaths(value: unknown, paths: string[]): unknown {
  if (!paths.length) return value;
  const clone = structuredClone(value) as unknown;
  for (const p of paths) {
    maskPath(clone, pathParts(p));
  }
  return clone;
}

function maskPath(node: unknown, parts: string[]): void {
  if (!node || typeof node !== 'object' || parts.length === 0) return;
  const [head, ...rest] = parts;
  if (Array.isArray(node)) {
    for (const item of node) maskPath(item, parts);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (head === '*') {
    for (const k of Object.keys(obj)) {
      if (rest.length === 0) obj[k] = MASK;
      else maskPath(obj[k], rest);
    }
    return;
  }
  if (!(head in obj)) return;
  if (rest.length === 0) obj[head] = MASK;
  else maskPath(obj[head], rest);
}

/** 递归脱敏：命中字段名（大小写不敏感）即打码 */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'refresh_token',
  'token',
  'secret',
  'password',
  'passwd',
  'session',
  'sessionid',
  'private_key',
  'client_secret',
]);

/**
 * 字段名里包含这些片段就脱敏。
 * 精确匹配抓不住 userPhone / idCardNo / bankAccount 这类组合词，
 * 所以再补一层子串规则。
 */
const SENSITIVE_PATTERNS = [
  'phone',
  'mobile',
  'tel',
  'email',
  'mail',
  'idcard',
  'id_card',
  'identity',
  'passport',
  'ssn',
  'bankcard',
  'bank_card',
  'cardno',
  'card_no',
  'account_no',
  'accountno',
  'address',
  'realname',
  'real_name',
  'birthday',
  'birthdate',
];

function isSensitiveKey(key: string, extra: Set<string>): boolean {
  const lower = key.toLowerCase();
  if (extra.has(lower)) return true;
  if (SENSITIVE_KEYS.has(lower)) return true;
  const compact = lower.replace(/[_-]/g, '');
  return SENSITIVE_PATTERNS.some((p) => compact.includes(p.replace(/[_-]/g, '')));
}

export function redactByKeyName(value: unknown, extraKeys: string[] = []): unknown {
  const extra = new Set(extraKeys.map((k) => k.toLowerCase()));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = isSensitiveKey(k, extra) ? MASK : walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

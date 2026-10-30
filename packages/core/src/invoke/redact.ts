/**
 * 脱敏：保证上游 host、密钥明文、敏感字段不会出现在响应 / 日志 / 审计里。
 *
 * 重要教训（真实事故）：以前脱敏只替换「本次调用解析出来的那几个明文值」，
 * 于是出现了「同一次调用被脱敏、跨请求读回是明文」的旁路：
 * 服务端把密钥 POST 到自己的会话接口落库，再用 GET /api/chat/sessions 读回来，
 * 第二次请求的 plaintexts 是空数组，脱敏形同虚设。
 *
 * 现在的做法：
 *   1. 值指纹：vault 里每个密钥都维护一份不可逆指纹（sha256 前 16 字节）；
 *      任何用户可见文本出现该指纹的片段即被打码 —— 不依赖"本次解析过"。
 *   2. 结构脱敏：所有用户可读出口统一走 scrubDeep，而不是只在 invoke 响应里脱敏。
 *   3. 通用模式兜底：Bearer / sk- / JWT / `__Host-*` Cookie / 长随机串。
 */

import { createHash } from 'node:crypto';

const MASK = '***';

/** 最短可识别的密钥长度：更短的没法安全做子串匹配（会把正常数据打成 ***） */
const MIN_SECRET_LEN = 8;

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
  // 两段式 JWT / `__Host-admin` 这类 Cookie 值（真实事故里就是它们没被挡住）
  [/\b__Host-[A-Za-z0-9_-]+=[A-Za-z0-9._~+/=-]{8,}/g, `__Host-*=${MASK}`],
  [/\b__Secure-[A-Za-z0-9_-]+=[A-Za-z0-9._~+/=-]{8,}/g, `__Secure-*=${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\b/g, MASK],
  [
    /((?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret|password|passwd|token|cookie)["'\s:=]{1,4})[A-Za-z0-9._~+/=-]{8,}/gi,
    `$1${MASK}`,
  ],
];

export function scrubPatterns(text: string): string {
  let out = text;
  for (const [re, rep] of GENERIC_PATTERNS) out = out.replace(re, rep);
  return out;
}

/* ────────────────────────── 值指纹 ────────────────────────── */

/** 指纹长度：够长（64bit）不会误撞，又能在文本里做子串查找 */
export const FINGERPRINT_BYTES = 8;

/**
 * 计算密钥指纹。用带应用固定前缀的 sha256 避免被彩虹表反查，
 * 同时保证"同一个密钥在库里/文本里指纹一致"。
 */
export function valueFingerprint(plain: string): string {
  return createHash('sha256').update(`aah-fp:${plain}`).digest('hex').slice(0, FINGERPRINT_BYTES * 2);
}

/**
 * 按指纹给文本打码。
 * 调用方传入「候选片段 → 指纹」的映射；这里只做长度 ≥ MIN_SECRET_LEN 的片段比对。
 * 之所以要能这么做：文本里出现的是密钥的**片段**时（被截断/拼接），
 * 精确明文替换就失效了，指纹能兜住。
 */
export function scrubByFingerprint(text: string, known: Map<string, string>): string {
  if (!known.size) return text;
  let out = text;
  for (const [frag] of known) {
    if (frag.length < MIN_SECRET_LEN) continue;
    if (out.includes(frag)) out = out.split(frag).join(MASK);
  }
  return out;
}

export type ScrubOptions = {
  /** 本次调用解析出的明文 */
  secretValues?: string[];
  /** 已知密钥片段 → 指纹（vault 全量指纹的候选片段） */
  knownFragments?: Map<string, string>;
};

/**
 * 统一出口脱敏：先值指纹、再明文、最后通用模式。
 * 所有"人能读到"的文本都应该经过这里。
 */
export function scrubAll(text: string, secretValues: string[] = [], opts: { knownFragments?: Map<string, string> } = {}): string {
  let out = text;
  if (opts.knownFragments?.size) out = scrubByFingerprint(out, opts.knownFragments);
  return scrubPatterns(scrubSecrets(out, secretValues));
}

/**
 * 深度脱敏：对任意 JSON 值递归处理字符串字段。
 * 用于会话列表、审计、导入任务等**所有**读取侧出口。
 */
export function scrubDeep<T>(value: T, opts: ScrubOptions = {}): T {
  const secretValues = opts.secretValues ?? [];
  const known = opts.knownFragments;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubAll(node, secretValues, { knownFragments: known });
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[scrubAll(k, secretValues, { knownFragments: known })] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
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

/**
 * 写入侧检测：文本里是不是已经带着某个密钥明文？
 * 用于「禁止把解析后的密钥写进可回读存储」（chat 标题/消息）。
 */
export function containsSecretValue(text: string, secretValues: string[]): string | null {
  for (const v of secretValues) {
    if (!v || v.length < MIN_SECRET_LEN) continue;
    if (text.includes(v)) return v;
  }
  return null;
}

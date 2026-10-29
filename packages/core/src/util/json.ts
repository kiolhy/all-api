import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${id.slice(0, 20)}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 稳定序列化：键排序，用于内容哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 32);
}

export function safeJsonParse<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function clampString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max}B]` : s;
}

/** 只保留需要的键，丢弃 undefined（node:sqlite 不接受 undefined） */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

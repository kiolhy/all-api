import type { ResponseSpec } from '../schema/asset.ts';

/**
 * 轻量路径表达式：
 *   "data"            → obj.data
 *   "data.items"      → obj.data.items
 *   "data.items[].id" → obj.data.items.map(i => i.id)
 *   "data[]"          → obj.data（数组原样）
 */
export function applyProjection(value: unknown, path: string): unknown {
  if (!path) return value;
  const segments = path.split('.').filter(Boolean);
  let cur: unknown = value;

  for (const seg of segments) {
    if (cur === null || cur === undefined) return null;
    const isArray = seg.endsWith('[]');
    const key = isArray ? seg.slice(0, -2) : seg;

    if (key) {
      if (Array.isArray(cur)) {
        cur = cur.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined));
      } else if (typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        return null;
      }
    }
    if (isArray) {
      if (!Array.isArray(cur)) return null;
      cur = cur.map((item) => item);
    }
  }
  return cur ?? null;
}

export function applyPick(value: unknown, pick: string[]): unknown {
  if (!pick.length || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of pick) {
    if (key in (value as Record<string, unknown>)) out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

/** 统一响应整形：unwrap → transform → pick */
export function shapeResponse(value: unknown, spec: ResponseSpec): unknown {
  let out = value;
  if (spec.unwrap) out = applyProjection(out, spec.unwrap);
  if (spec.transform) out = applyProjection(out, spec.transform);
  out = applyPick(out, spec.pick);
  return out;
}

export function previewOf(value: unknown, max = 800): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

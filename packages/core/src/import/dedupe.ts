import type { EndpointInput, EndpointRecord } from '../schema/asset.ts';
import { endpoints } from '../db/repos.ts';
import { contentHash } from '../util/json.ts';

export function normalizedPath(pathTemplate: string): string {
  return pathTemplate
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '') || '/';
}

/** 同一平台内判定「同一个接口」的键：方法 + 归一化路径 + 参数集合 */
export function dedupeKey(input: EndpointInput): string {
  const params = input.params
    .filter((p) => p.in !== 'header')
    .map((p) => `${p.in}:${p.name.toLowerCase()}`)
    .sort()
    .join(',');
  return `${input.method.toUpperCase()} ${normalizedPath(input.pathTemplate)} ?${params}`;
}

export type Classification = {
  diffKind: 'new' | 'modified' | 'conflict' | 'duplicate';
  targetEndpointId: string | null;
  reason: string;
};

export function classify(platformId: string, input: EndpointInput, batchSeen: Map<string, string>): Classification {
  const key = dedupeKey(input);
  const hash = contentHash(input);

  const existing = endpoints.list({ platformId });

  const bySlug = existing.find((e) => e.slug === input.slug);
  if (bySlug) {
    if (bySlug.contentHash === hash) {
      return { diffKind: 'duplicate', targetEndpointId: bySlug.id, reason: '内容完全一致' };
    }
    return { diffKind: 'modified', targetEndpointId: bySlug.id, reason: '同 slug，内容有变化' };
  }

  const sameKey = existing.find((e) => dedupeKey(e) === key);
  if (sameKey) {
    if (sameKey.contentHash === hash) {
      return { diffKind: 'duplicate', targetEndpointId: sameKey.id, reason: '方法+路径+参数一致' };
    }
    return { diffKind: 'modified', targetEndpointId: sameKey.id, reason: '方法+路径一致，定义有变化' };
  }

  if (batchSeen.has(key)) {
    return { diffKind: 'conflict', targetEndpointId: null, reason: `与本次批次中的 ${batchSeen.get(key)} 重复` };
  }

  return { diffKind: 'new', targetEndpointId: null, reason: '' };
}

/** slug 去重：同平台内保证唯一 */
export function uniqueSlug(platformId: string, desired: string, ignoreEndpointId?: string): string {
  const existing = endpoints.list({ platformId }).filter((e) => e.id !== ignoreEndpointId);
  const used = new Set(existing.map((e) => e.slug));
  if (!used.has(desired)) return desired;
  let i = 2;
  while (used.has(`${desired}_${i}`)) i++;
  return `${desired}_${i}`;
}

export function describeEndpoint(e: EndpointRecord): string {
  return `${e.method} ${e.pathTemplate}`;
}

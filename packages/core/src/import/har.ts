import type { RequestSpec } from './types.ts';
import { safeJsonParse } from '../util/json.ts';

type HarHeader = { name?: string; value?: string };
type HarEntry = {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    queryString?: HarHeader[];
    postData?: { mimeType?: string; text?: string; params?: Array<{ name?: string; value?: string }> };
  };
  response?: { status?: number; content?: { mimeType?: string; size?: number } };
  _resourceType?: string;
};

const STATIC_MIME = /^(?:image\/|font\/|text\/css|text\/html|application\/javascript|text\/javascript|application\/font)/i;
const STATIC_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|avif)(?:$|\?)/i;

export function looksLikeHar(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  return t.includes('"log"') && t.includes('"entries"');
}

export function parseHar(text: string): RequestSpec[] {
  const doc = safeJsonParse<{ log?: { entries?: HarEntry[] } }>(text, {});
  const entries = doc.log?.entries ?? [];
  const out: RequestSpec[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const req = entry.request;
    if (!req?.url) continue;
    const mime = entry.response?.content?.mimeType ?? '';
    const resType = entry._resourceType ?? '';
    if (STATIC_MIME.test(mime) && !/json/i.test(mime)) continue;
    if (STATIC_EXT.test(req.url) && !/json/i.test(mime)) continue;
    if (resType && !['xhr', 'fetch', 'document', 'other'].includes(resType)) continue;

    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      continue;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const h of req.headers ?? []) {
      if (!h.name) continue;
      headers[h.name] = h.value ?? '';
    }
    const query: Record<string, string> = {};
    for (const q of req.queryString ?? []) {
      if (q.name) query[q.name] = q.value ?? '';
    }
    if (!Object.keys(query).length) {
      for (const [k, v] of parsed.searchParams) query[k] = v;
    }

    const key = `${method} ${parsed.origin}${parsed.pathname} ${Object.keys(query).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      method: method as RequestSpec['method'],
      url: `${parsed.origin}${parsed.pathname}`,
      headers,
      query,
      bodyRaw: req.postData?.text ?? null,
      bodyContentType: req.postData?.mimeType ?? headers['Content-Type'] ?? null,
      source: 'har',
    });
  }
  return out;
}

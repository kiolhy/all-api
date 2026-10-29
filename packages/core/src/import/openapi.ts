import { parse as parseYaml } from 'yaml';
import type { EndpointInput, HttpMethod, Param } from '../schema/asset.ts';
import type { NormalizedDraft } from './types.ts';
import { slugify } from './normalize.ts';

type AnyObj = Record<string, unknown>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export function looksLikeOpenapi(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('{') && (t.includes('"openapi"') || t.includes('"swagger"'))) return true;
  if (/^\s*openapi\s*:/m.test(t) || /^\s*swagger\s*:/m.test(t)) return true;
  return false;
}

export function parseOpenapi(text: string, opts: { platformSlug?: string; platformName?: string } = {}): NormalizedDraft[] {
  const doc = parseYaml(text) as AnyObj | null;
  if (!doc || typeof doc !== 'object') return [];
  const info = (doc.info ?? {}) as AnyObj;
  const title = String(info.title ?? 'openapi');

  const serverUrl = pickServerUrl(doc);
  let origin = 'http://localhost';
  let prefix = '';
  try {
    const u = new URL(serverUrl);
    origin = u.origin;
    prefix = u.pathname.replace(/\/$/, '');
  } catch {
    prefix = serverUrl.replace(/\/$/, '');
  }

  const platformSlug = opts.platformSlug ?? slugify(hostSlug(origin));
  const platformName = opts.platformName ?? title;

  const resolver = makeResolver(doc);
  const paths = (doc.paths ?? {}) as Record<string, AnyObj>;
  const drafts: NormalizedDraft[] = [];

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? (pathItem.parameters as AnyObj[]) : [];

    for (const m of METHODS) {
      const op = pathItem[m] as AnyObj | undefined;
      if (!op || typeof op !== 'object') continue;

      const params: Param[] = [];
      const opParams = Array.isArray(op.parameters) ? (op.parameters as AnyObj[]) : [];
      for (const p of [...sharedParams, ...opParams]) {
        const resolved = resolver(p) as AnyObj;
        const loc = String(resolved.in ?? 'query');
        if (!['path', 'query', 'header', 'cookie'].includes(loc)) continue;
        if (loc === 'header' && /^(authorization|x-api-key|api-key|token)$/i.test(String(resolved.name))) continue;
        const schema = (resolver(resolved.schema ?? {}) ?? {}) as AnyObj;
        params.push({
          name: String(resolved.name ?? ''),
          in: loc as Param['in'],
          type: mapType(schema),
          required: Boolean(resolved.required ?? loc === 'path'),
          description: String(resolved.description ?? schema.description ?? ''),
          ...(Array.isArray(schema.enum) ? { enum: schema.enum as Array<string | number> } : {}),
          ...(schema.default !== undefined ? { default: schema.default } : {}),
          ...(typeof schema.pattern === 'string' ? { pattern: schema.pattern } : {}),
          ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
          ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
          ...(schema.items ? { items: mapType(schema.items as AnyObj) } : {}),
        });
      }

      // 路径里出现但未声明的占位符
      for (const seg of rawPath.matchAll(/\{([^}]+)\}/g)) {
        const name = seg[1];
        if (!params.some((p) => p.in === 'path' && p.name === name)) {
          params.push({
            name,
            in: 'path',
            type: 'string',
            required: true,
            description: '',
          });
        }
      }

      let body: EndpointInput['body'] = null;
      const rb = op.requestBody ? (resolver(op.requestBody) as AnyObj) : null;
      if (rb) {
        const content = (rb.content ?? {}) as Record<string, AnyObj>;
        const ct = Object.keys(content)[0] ?? 'application/json';
        const media = content[ct] ?? {};
        body = {
          contentType: ct,
          encoding: ct.includes('json') ? 'json' : ct.includes('x-www-form-urlencoded') ? 'form' : ct.includes('multipart') ? 'multipart' : 'raw',
          required: Boolean(rb.required),
          schema: (media.schema as Record<string, unknown>) ?? null,
          example: null,
        };
      }

      const responses = (op.responses ?? {}) as Record<string, AnyObj>;
      const okCode = Object.keys(responses).find((c) => c.startsWith('2')) ?? '200';
      const okRes = resolver(responses[okCode] ?? {}) as AnyObj;
      const resContent = (okRes.content ?? {}) as Record<string, AnyObj>;
      const resCt = Object.keys(resContent)[0] ?? 'application/json';

      const operationId = op.operationId ? String(op.operationId) : '';
      const tags = Array.isArray(op.tags) ? (op.tags as string[]) : [];
      const slug = uniqueSlug(
        drafts,
        slugify(operationId || `${m}_${rawPath}`),
      );

      drafts.push({
        platformSlug,
        platformBaseUrl: origin,
        platformName,
        secrets: [],
        endpoint: {
          slug,
          group: tags[0] ? slugify(tags[0]) : 'default',
          method: m.toUpperCase() as HttpMethod,
          pathTemplate: `${prefix}${rawPath}`.replace(/\/{2,}/g, '/'),
          summary: String(op.summary ?? ''),
          description: String(op.description ?? ''),
          params,
          body,
          response: {
            contentType: resCt,
            pick: [],
            unwrap: null,
            transform: null,
            redactFields: [],
            maxBytes: 2 * 1024 * 1024,
          },
          sideEffect: m === 'get' || m === 'head' ? 'read' : 'write',
          sensitivity: m === 'delete' ? 'high' : m === 'get' ? 'low' : 'medium',
          tags,
          examples: [],
          notes: `来自 OpenAPI：${title}`,
          exposure: 'open',
      publicName: '',
          allowedKeyIds: [],
        },
      });
    }
  }
  return drafts;
}

function pickServerUrl(doc: AnyObj): string {
  const servers = Array.isArray(doc.servers) ? (doc.servers as AnyObj[]) : [];
  const raw = servers[0]?.url;
  if (typeof raw === 'string' && raw) {
    const vars = (servers[0]?.variables ?? {}) as Record<string, AnyObj>;
    return raw.replace(/\{([^}]+)\}/g, (_m, name: string) => String(vars[name]?.default ?? name));
  }
  if (typeof doc.host === 'string') {
    const scheme = Array.isArray(doc.schemes) ? String((doc.schemes as unknown[])[0] ?? 'https') : 'https';
    const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
    return `${scheme}://${doc.host}${basePath}`;
  }
  return 'http://localhost';
}

function hostSlug(origin: string): string {
  try {
    const host = new URL(origin).hostname;
    return host.split('.').filter(Boolean)[0] ?? 'api';
  } catch {
    return 'api';
  }
}

function mapType(schema: AnyObj): Param['type'] {
  const t = schema.type;
  if (Array.isArray(schema.enum)) return 'enum';
  if (t === 'integer') return 'integer';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'array';
  if (t === 'object') return 'object';
  return 'string';
}

function uniqueSlug(existing: NormalizedDraft[], base: string): string {
  const used = new Set(existing.map((d) => d.endpoint.slug));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** 浅层 $ref 解析（最多 4 层，防环） */
function makeResolver(root: AnyObj) {
  const cache = new Map<string, unknown>();
  const resolveRef = (ref: string, depth: number): unknown => {
    if (depth > 4) return {};
    if (cache.has(ref)) return cache.get(ref);
    const parts = ref.replace(/^#\//, '').split('/');
    let node: unknown = root;
    for (const p of parts) {
      if (!node || typeof node !== 'object') return {};
      node = (node as AnyObj)[p.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (node && typeof node === 'object') {
      const resolved = resolveNode(node as AnyObj, depth + 1);
      cache.set(ref, resolved);
      return resolved;
    }
    return node ?? {};
  };
  const resolveNode = (node: AnyObj, depth: number): AnyObj => {
    if (node && typeof node === 'object' && typeof node.$ref === 'string') {
      return resolveRef(node.$ref, depth) as AnyObj;
    }
    return node;
  };
  return (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    return resolveNode(node as AnyObj, 0);
  };
}

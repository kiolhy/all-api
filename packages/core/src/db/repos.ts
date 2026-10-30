import { getDb, b } from './client.ts';
import {
  type AccountRecord,
  type AuditRecord,
  type CandidateRecord,
  type EndpointInput,
  type EndpointRecord,
  type EndpointStatus,
  type PlatformInput,
  type PlatformRecord,
  type ToolRecord,
} from '../schema/asset.ts';
import { contentHash, newId, nowIso, safeJsonParse, toJson } from '../util/json.ts';

/* ────────────────────────── row → record ────────────────────────── */

type Row = Record<string, unknown>;

const s = (v: unknown, d = ''): string => (v === null || v === undefined ? d : String(v));
const n = (v: unknown, d = 0): number => (v === null || v === undefined ? d : Number(v));

function rowToPlatform(r: Row): PlatformRecord {
  return {
    id: s(r.id),
    slug: s(r.slug),
    name: s(r.name),
    baseUrl: s(r.base_url),
    authKind: s(r.auth_kind, 'none') as PlatformRecord['authKind'],
    authConfig: safeJsonParse(s(r.auth_config, '{}'), {}),
    defaultHeaders: safeJsonParse(s(r.default_headers, '{}'), {}),
    egressAllowHosts: safeJsonParse(s(r.egress_allow_hosts, '[]'), []),
    rateLimit: safeJsonParse(s(r.rate_limit, '{}'), { qps: 5, daily: 10000 }),
    allowPrivate: n(r.allow_private) === 1,
    notes: s(r.notes),
    siteTitle: s(r.site_title, ''),
    siteIcon: s(r.site_icon, ''),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

const DEFAULT_RESPONSE = {
  contentType: 'application/json',
  pick: [] as string[],
  unwrap: null as string | null,
  transform: null as string | null,
  redactFields: [] as string[],
  maxBytes: 2 * 1024 * 1024,
};

function rowToEndpoint(r: Row): EndpointRecord {
  return {
    id: s(r.id),
    platformId: s(r.platform_id),
    platformSlug: s(r.platform_slug),
    slug: s(r.slug),
    group: s(r.grp, 'default'),
    method: s(r.method, 'GET') as EndpointRecord['method'],
    pathTemplate: s(r.path_template, '/'),
    summary: s(r.summary),
    description: s(r.description),
    params: safeJsonParse(s(r.params, '[]'), []),
    body: safeJsonParse(s(r.body ?? 'null'), null),
    response: safeJsonParse(s(r.response, '{}'), DEFAULT_RESPONSE),
    sideEffect: s(r.side_effect, 'read') as EndpointRecord['sideEffect'],
    sensitivity: s(r.sensitivity, 'low') as EndpointRecord['sensitivity'],
    tags: safeJsonParse(s(r.tags, '[]'), []),
    examples: safeJsonParse(s(r.examples, '[]'), []),
    notes: s(r.notes),
    exposure: s(r.exposure, 'open') as EndpointRecord['exposure'],
    allowedKeyIds: safeJsonParse(s(r.allowed_key_ids, '[]'), []),
    publicName: s(r.public_name),
    status: s(r.status, 'draft') as EndpointStatus,
    version: n(r.version),
    contentHash: s(r.content_hash),
    sourceKind: s(r.source_kind, 'manual'),
    sourceRef: s(r.source_ref),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

function rowToTool(r: Row): ToolRecord {
  return {
    id: s(r.id),
    endpointId: s(r.endpoint_id),
    name: s(r.name),
    namespace: s(r.namespace),
    title: s(r.title),
    description: s(r.description),
    inputSchema: safeJsonParse(s(r.input_schema, '{}'), {}),
    cacheTtl: n(r.cache_ttl),
    annotations: safeJsonParse(s(r.annotations, '{}'), {
      readOnly: true,
      destructive: false,
      idempotent: true,
    }),
    enabled: n(r.enabled) === 1,
    platformSlug: s(r.platform_slug),
    endpointSlug: s(r.endpoint_slug),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

/* ────────────────────────── platform ────────────────────────── */

export const platforms = {
  list(): PlatformRecord[] {
    const rows = getDb().prepare('select * from platform order by name').all() as Row[];
    return rows.map(rowToPlatform);
  },
  get(id: string): PlatformRecord | null {
    const r = getDb().prepare('select * from platform where id = ?').get(id) as Row | undefined;
    return r ? rowToPlatform(r) : null;
  },
  bySlug(slug: string): PlatformRecord | null {
    const r = getDb().prepare('select * from platform where slug = ?').get(slug) as Row | undefined;
    return r ? rowToPlatform(r) : null;
  },
  create(input: PlatformInput): PlatformRecord {
    const id = newId('pf');
    const ts = nowIso();
    getDb()
      .prepare(
        `insert into platform (id, slug, name, base_url, auth_kind, auth_config, default_headers,
          egress_allow_hosts, rate_limit, allow_private, notes, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.slug,
        input.name,
        input.baseUrl,
        input.authKind,
        toJson(input.authConfig),
        toJson(input.defaultHeaders),
        toJson(input.egressAllowHosts),
        toJson(input.rateLimit),
        b(input.allowPrivate),
        input.notes,
        ts,
        ts,
      );
    return this.get(id)!;
  },
  update(id: string, patch: Partial<PlatformInput>): PlatformRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    getDb()
      .prepare(
        `update platform set slug=?, name=?, base_url=?, auth_kind=?, auth_config=?, default_headers=?,
           egress_allow_hosts=?, rate_limit=?, allow_private=?, notes=?, updated_at=? where id=?`,
      )
      .run(
        next.slug,
        next.name,
        next.baseUrl,
        next.authKind,
        toJson(next.authConfig),
        toJson(next.defaultHeaders),
        toJson(next.egressAllowHosts),
        toJson(next.rateLimit),
        b(next.allowPrivate),
        next.notes,
        nowIso(),
        id,
      );
    return this.get(id);
  },
  /** 写入自动抓取的站点标题/图标 */
  setSiteInfo(id: string, siteTitle: string, siteIcon: string): void {
    getDb()
      .prepare('update platform set site_title=?, site_icon=?, updated_at=? where id=?')
      .run(siteTitle.slice(0, 200), siteIcon.slice(0, 500), nowIso(), id);
  },
  remove(id: string): void {
    getDb().prepare('delete from platform where id = ?').run(id);
  },
};

/* ────────────────────────── endpoint ────────────────────────── */

const ENDPOINT_SELECT = `select e.*, p.slug as platform_slug from endpoint e join platform p on p.id = e.platform_id`;

export const endpoints = {
  list(opts: { platformId?: string; status?: string; q?: string } = {}): EndpointRecord[] {
    const where: string[] = [];
    const args: Array<string> = [];
    if (opts.platformId) {
      where.push('e.platform_id = ?');
      args.push(opts.platformId);
    }
    if (opts.status) {
      where.push('e.status = ?');
      args.push(opts.status);
    }
    if (opts.q) {
      where.push('(e.slug like ? or e.summary like ? or e.path_template like ?)');
      const like = `%${opts.q}%`;
      args.push(like, like, like);
    }
    const sql = `${ENDPOINT_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by p.slug, e.grp, e.slug`;
    const rows = getDb().prepare(sql).all(...args) as Row[];
    return rows.map(rowToEndpoint);
  },
  get(id: string): EndpointRecord | null {
    const r = getDb().prepare(`${ENDPOINT_SELECT} where e.id = ?`).get(id) as Row | undefined;
    return r ? rowToEndpoint(r) : null;
  },
  bySlug(platformId: string, slug: string): EndpointRecord | null {
    const r = getDb()
      .prepare(`${ENDPOINT_SELECT} where e.platform_id = ? and e.slug = ?`)
      .get(platformId, slug) as Row | undefined;
    return r ? rowToEndpoint(r) : null;
  },
  create(
    platformId: string,
    input: EndpointInput,
    meta: { status?: EndpointStatus; sourceKind?: string; sourceRef?: string } = {},
  ): EndpointRecord {
    const id = newId('ep');
    const ts = nowIso();
    getDb()
      .prepare(
        `insert into endpoint (id, platform_id, slug, grp, method, path_template, summary, description,
          params, body, response, side_effect, sensitivity, tags, examples, notes, exposure, allowed_key_ids,
          public_name, status, version, content_hash, source_kind, source_ref, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        platformId,
        input.slug,
        input.group,
        input.method,
        input.pathTemplate,
        input.summary,
        input.description,
        toJson(input.params),
        input.body ? toJson(input.body) : null,
        toJson(input.response),
        input.sideEffect,
        input.sensitivity,
        toJson(input.tags),
        toJson(input.examples),
        input.notes,
        input.exposure,
        toJson(input.allowedKeyIds),
        input.publicName,
        meta.status ?? 'draft',
        0,
        contentHash(input),
        meta.sourceKind ?? 'manual',
        meta.sourceRef ?? '',
        ts,
        ts,
      );
    return this.get(id)!;
  },
  update(id: string, input: EndpointInput): EndpointRecord | null {
    getDb()
      .prepare(
        `update endpoint set slug=?, grp=?, method=?, path_template=?, summary=?, description=?, params=?,
           body=?, response=?, side_effect=?, sensitivity=?, tags=?, examples=?, notes=?,
           exposure=?, allowed_key_ids=?, public_name=?, content_hash=?, updated_at=? where id=?`,
      )
      .run(
        input.slug,
        input.group,
        input.method,
        input.pathTemplate,
        input.summary,
        input.description,
        toJson(input.params),
        input.body ? toJson(input.body) : null,
        toJson(input.response),
        input.sideEffect,
        input.sensitivity,
        toJson(input.tags),
        toJson(input.examples),
        input.notes,
        input.exposure,
        toJson(input.allowedKeyIds),
        input.publicName,
        contentHash(input),
        nowIso(),
        id,
      );
    return this.get(id);
  },
  setStatus(id: string, status: EndpointStatus): void {
    getDb().prepare('update endpoint set status=?, updated_at=? where id=?').run(status, nowIso(), id);
  },
  /** 发布：版本号 +1 并写入不可变快照 */
  publish(id: string, note = ''): EndpointRecord | null {
    const ep = this.get(id);
    if (!ep) return null;
    const db = getDb();
    const nextVersion = ep.version + 1;
    db.exec('BEGIN');
    try {
      db.prepare('update endpoint set status=?, version=?, updated_at=? where id=?').run(
        'published',
        nextVersion,
        nowIso(),
        id,
      );
      db.prepare(
        'insert into endpoint_version (id, endpoint_id, version, snapshot, note, created_at) values (?,?,?,?,?,?)',
      ).run(newId('ev'), id, nextVersion, toJson(ep), note, nowIso());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return this.get(id);
  },
  snapshot(endpointId: string, version?: number): EndpointRecord | null {
    if (!version) return this.get(endpointId);
    const r = getDb()
      .prepare('select snapshot from endpoint_version where endpoint_id = ? and version = ?')
      .get(endpointId, version) as Row | undefined;
    if (!r) return this.get(endpointId);
    const snap = safeJsonParse<EndpointRecord | null>(s(r.snapshot), null);
    return snap;
  },
  remove(id: string): void {
    getDb().prepare('delete from endpoint where id = ?').run(id);
  },
};

/* ────────────────────────── tool ────────────────────────── */

const TOOL_SELECT = `select t.*, p.slug as platform_slug, e.slug as endpoint_slug
  from tool t join endpoint e on e.id = t.endpoint_id join platform p on p.id = e.platform_id`;

export const tools = {
  list(opts: { enabledOnly?: boolean } = {}): ToolRecord[] {
    const sql = `${TOOL_SELECT} ${opts.enabledOnly ? 'where t.enabled = 1' : ''} order by t.name`;
    return (getDb().prepare(sql).all() as Row[]).map(rowToTool);
  },
  get(id: string): ToolRecord | null {
    const r = getDb().prepare(`${TOOL_SELECT} where t.id = ?`).get(id) as Row | undefined;
    return r ? rowToTool(r) : null;
  },
  byName(name: string): ToolRecord | null {
    const r = getDb().prepare(`${TOOL_SELECT} where t.name = ?`).get(name) as Row | undefined;
    return r ? rowToTool(r) : null;
  },
  byEndpoint(endpointId: string): ToolRecord | null {
    const r = getDb().prepare(`${TOOL_SELECT} where t.endpoint_id = ?`).get(endpointId) as Row | undefined;
    return r ? rowToTool(r) : null;
  },
  upsert(input: {
    endpointId: string;
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    cacheTtl?: number;
    annotations?: ToolRecord['annotations'];
    enabled?: boolean;
    namespace?: string;
  }): ToolRecord {
    const existing = this.byEndpoint(input.endpointId);
    const ts = nowIso();
    if (existing) {
      getDb()
        .prepare(
          `update tool set name=?, namespace=?, title=?, description=?, input_schema=?, cache_ttl=?,
             annotations=?, enabled=?, updated_at=? where id=?`,
        )
        .run(
          input.name,
          input.namespace ?? existing.namespace,
          input.title ?? existing.title,
          input.description ?? existing.description,
          toJson(input.inputSchema),
          input.cacheTtl ?? existing.cacheTtl,
          toJson(input.annotations ?? existing.annotations),
          b(input.enabled ?? existing.enabled),
          ts,
          existing.id,
        );
      return this.get(existing.id)!;
    }
    const id = newId('tl');
    getDb()
      .prepare(
        `insert into tool (id, endpoint_id, name, namespace, title, description, input_schema,
           cache_ttl, annotations, enabled, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.endpointId,
        input.name,
        input.namespace ?? '',
        input.title ?? '',
        input.description ?? '',
        toJson(input.inputSchema),
        input.cacheTtl ?? 0,
        toJson(input.annotations ?? { readOnly: true, destructive: false, idempotent: true }),
        b(input.enabled ?? true),
        ts,
        ts,
      );
    return this.get(id)!;
  },
  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('update tool set enabled=?, updated_at=? where id=?').run(b(enabled), nowIso(), id);
  },
  remove(id: string): void {
    getDb().prepare('delete from tool where id = ?').run(id);
  },
};

/* ────────────────────────── secret ────────────────────────── */

export const secrets = {
  list(): Array<{ name: string; hint: string; createdAt: string; rotatedAt: string | null }> {
    const rows = getDb().prepare('select name, hint, created_at, rotated_at from secret order by name').all() as Row[];
    return rows.map((r) => ({
      name: s(r.name),
      hint: s(r.hint),
      createdAt: s(r.created_at),
      rotatedAt: r.rotated_at ? s(r.rotated_at) : null,
    }));
  },
  put(name: string, ciphertext: string, hint = ''): void {
    const ts = nowIso();
    getDb()
      .prepare(
        `insert into secret (name, ciphertext, hint, created_at) values (?,?,?,?)
         on conflict(name) do update set ciphertext=excluded.ciphertext, hint=excluded.hint, rotated_at=?`,
      )
      .run(name, ciphertext, hint, ts, ts);
  },
  getCipher(name: string): string | null {
    const r = getDb().prepare('select ciphertext from secret where name = ?').get(name) as Row | undefined;
    return r ? s(r.ciphertext) : null;
  },
  remove(name: string): void {
    getDb().prepare('delete from secret where name = ?').run(name);
  },
};

/* ────────────────────────── api key ────────────────────────── */

export type QuotaPeriod = 'total' | 'daily' | 'monthly';

export type ApiKeyRecord = {
  id: string;
  label: string;
  prefix: string;
  scopes: { platforms?: string[]; tools?: string[] };
  enabled: boolean;
  /** 归属账号；null 表示历史遗留的全局令牌 */
  accountId: string | null;
  /** 过期时间 ISO；null 表示永不过期 */
  expiresAt: string | null;
  /** 额度上限；0 表示不限 */
  quotaLimit: number;
  /** 已用额度 */
  quotaUsed: number;
  /** 额度周期 */
  quotaPeriod: QuotaPeriod;
  /** 本周期开始时间 */
  quotaResetAt: string | null;
  /** 累计调用次数 */
  callCount: number;
  /** IP 白名单，支持精确 IP 与 CIDR；空数组表示不限制 */
  ipAllowlist: string[];
  notes: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function rowToApiKey(r: Row): ApiKeyRecord {
  return {
    id: s(r.id),
    label: s(r.label),
    prefix: s(r.prefix),
    scopes: safeJsonParse(s(r.scopes, '{}'), {}),
    enabled: n(r.enabled) === 1,
    accountId: r.account_id ? s(r.account_id) : null,
    expiresAt: r.expires_at ? s(r.expires_at) : null,
    quotaLimit: n(r.quota_limit),
    quotaUsed: n(r.quota_used),
    quotaPeriod: s(r.quota_period, 'total') as QuotaPeriod,
    quotaResetAt: r.quota_reset_at ? s(r.quota_reset_at) : null,
    callCount: n(r.call_count),
    ipAllowlist: safeJsonParse(s(r.ip_allowlist, '[]'), []),
    notes: s(r.notes),
    lastUsedAt: r.last_used_at ? s(r.last_used_at) : null,
    createdAt: s(r.created_at),
  };
}

function nextResetAt(period: QuotaPeriod, from = new Date()): string | null {
  if (period === 'total') return null;
  const d = new Date(from);
  if (period === 'daily') {
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  } else {
    d.setMonth(d.getMonth() + 1, 1);
    d.setHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

export const apiKeys = {
  list(): ApiKeyRecord[] {
    return (getDb().prepare('select * from api_key order by created_at desc').all() as Row[]).map(rowToApiKey);
  },
  listByAccount(accountId: string): ApiKeyRecord[] {
    return (
      getDb()
        .prepare('select * from api_key where account_id = ? order by created_at desc')
        .all(accountId) as Row[]
    ).map(rowToApiKey);
  },
  get(id: string): ApiKeyRecord | null {
    const r = getDb().prepare('select * from api_key where id = ?').get(id) as Row | undefined;
    return r ? rowToApiKey(r) : null;
  },
  create(input: {
    label: string;
    prefix: string;
    keyHash: string;
    scopes: ApiKeyRecord['scopes'];
    accountId: string | null;
    expiresAt?: string | null;
    quotaLimit?: number;
    quotaPeriod?: QuotaPeriod;
    ipAllowlist?: string[];
    notes?: string;
  }): string {
    const id = newId('ak');
    const period = input.quotaPeriod ?? 'total';
    getDb()
      .prepare(
        `insert into api_key (id, label, prefix, key_hash, scopes, enabled, account_id, expires_at,
           quota_limit, quota_used, quota_period, quota_reset_at, call_count, ip_allowlist, notes, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.label,
        input.prefix,
        input.keyHash,
        toJson(input.scopes),
        1,
        input.accountId,
        input.expiresAt ?? null,
        input.quotaLimit ?? 0,
        0,
        period,
        nextResetAt(period),
        0,
        toJson(input.ipAllowlist ?? []),
        input.notes ?? '',
        nowIso(),
      );
    return id;
  },
  byHash(keyHash: string): ApiKeyRecord | null {
    const r = getDb().prepare('select * from api_key where key_hash = ?').get(keyHash) as Row | undefined;
    return r ? rowToApiKey(r) : null;
  },
  touch(id: string): void {
    getDb().prepare('update api_key set last_used_at=? where id=?').run(nowIso(), id);
  },
  /** 记一次调用：累计次数 +1，额度 +1 */
  recordCall(id: string): void {
    getDb()
      .prepare('update api_key set last_used_at=?, call_count = call_count + 1, quota_used = quota_used + 1 where id=?')
      .run(nowIso(), id);
  },
  /** 周期到了就把已用额度清零 */
  rollQuotaIfDue(id: string): void {
    const key = this.get(id);
    if (!key || key.quotaPeriod === 'total') return;
    const due = key.quotaResetAt ? Date.parse(key.quotaResetAt) : 0;
    if (Number.isFinite(due) && due > Date.now()) return;
    getDb()
      .prepare('update api_key set quota_used=0, quota_reset_at=? where id=?')
      .run(nextResetAt(key.quotaPeriod), id);
  },
  /** 手动重置额度 */
  resetQuota(id: string): void {
    const key = this.get(id);
    if (!key) return;
    getDb()
      .prepare('update api_key set quota_used=0, quota_reset_at=? where id=?')
      .run(nextResetAt(key.quotaPeriod), id);
  },
  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('update api_key set enabled=? where id=?').run(b(enabled), id);
  },
  update(
    id: string,
    patch: {
      label?: string;
      scopes?: ApiKeyRecord['scopes'];
      expiresAt?: string | null;
      quotaLimit?: number;
      quotaPeriod?: QuotaPeriod;
      ipAllowlist?: string[];
      notes?: string;
    },
  ): ApiKeyRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    const period = patch.quotaPeriod ?? cur.quotaPeriod;
    const periodChanged = period !== cur.quotaPeriod;
    getDb()
      .prepare(
        `update api_key set label=?, scopes=?, expires_at=?, quota_limit=?, quota_period=?, ip_allowlist=?,
           notes=?, quota_reset_at=? where id=?`,
      )
      .run(
        patch.label ?? cur.label,
        toJson(patch.scopes ?? cur.scopes),
        patch.expiresAt === undefined ? cur.expiresAt : patch.expiresAt,
        patch.quotaLimit ?? cur.quotaLimit,
        period,
        toJson(patch.ipAllowlist ?? cur.ipAllowlist),
        patch.notes ?? cur.notes,
        periodChanged ? nextResetAt(period) : cur.quotaResetAt,
        id,
      );
    return this.get(id);
  },
  remove(id: string): void {
    getDb().prepare('delete from api_key where id = ?').run(id);
  },
  removeByAccount(accountId: string): void {
    getDb().prepare('delete from api_key where account_id = ?').run(accountId);
  },
  countByAccount(accountId: string): number {
    const r = getDb()
      .prepare('select count(*) as c from api_key where account_id = ?')
      .get(accountId) as Row;
    return n(r.c);
  },
};

/**
 * 令牌可用性检查。返回 null 表示可用，否则返回错误码与说明。
 * 顺带处理周期额度重置。
 */
export function apiKeyProblem(key: ApiKeyRecord): { code: string; message: string } | null {
  if (!key.enabled) return { code: 'invalid_key', message: 'API Key 已禁用' };
  if (key.expiresAt) {
    const t = Date.parse(key.expiresAt);
    if (Number.isFinite(t) && t < Date.now()) {
      return { code: 'key_expired', message: 'API Key 已过期' };
    }
  }
  if (key.quotaLimit > 0 && key.quotaUsed >= key.quotaLimit) {
    return {
      code: 'quota_exceeded',
      message: `API Key 额度已用尽（${key.quotaUsed}/${key.quotaLimit}）`,
    };
  }
  return null;
}

/* ────────────────────────── account / session ────────────────────────── */

export type AccountRow = AccountRecord & { passwordHash: string };

function rowToAccount(r: Row): AccountRow {
  return {
    id: s(r.id),
    username: s(r.username),
    passwordHash: s(r.password_hash),
    role: s(r.role, 'member') as AccountRecord['role'],
    enabled: n(r.enabled) === 1,
    createdAt: s(r.created_at),
    lastLoginAt: r.last_login_at ? s(r.last_login_at) : null,
  };
}

/** 去掉密码哈希，用于对外返回 */
export function publicAccount(a: AccountRow): AccountRecord {
  const { passwordHash: _drop, ...rest } = a;
  return rest;
}

export const accounts = {
  list(): AccountRecord[] {
    const rows = getDb().prepare('select * from account order by created_at').all() as Row[];
    return rows.map((r) => publicAccount(rowToAccount(r)));
  },
  count(): number {
    const r = getDb().prepare('select count(*) as c from account').get() as Row;
    return n(r.c);
  },
  byUsername(username: string): AccountRow | null {
    const r = getDb()
      .prepare('select * from account where lower(username) = lower(?)')
      .get(username) as Row | undefined;
    return r ? rowToAccount(r) : null;
  },
  get(id: string): AccountRecord | null {
    const r = getDb().prepare('select * from account where id = ?').get(id) as Row | undefined;
    return r ? publicAccount(rowToAccount(r)) : null;
  },
  create(username: string, passwordHash: string, role: AccountRecord['role']): AccountRecord {
    const id = newId('acc');
    getDb()
      .prepare('insert into account (id, username, password_hash, role, enabled, created_at) values (?,?,?,?,?,?)')
      .run(id, username, passwordHash, role, 1, nowIso());
    return this.get(id)!;
  },
  setPassword(id: string, passwordHash: string): void {
    getDb().prepare('update account set password_hash=? where id=?').run(passwordHash, id);
  },
  setEnabled(id: string, enabled: boolean): void {
    getDb().prepare('update account set enabled=? where id=?').run(b(enabled), id);
  },
  setRole(id: string, role: AccountRecord['role']): void {
    getDb().prepare('update account set role=? where id=?').run(role, id);
  },
  touchLogin(id: string): void {
    getDb().prepare('update account set last_login_at=? where id=?').run(nowIso(), id);
  },
  remove(id: string): void {
    getDb().prepare('delete from account where id = ?').run(id);
  },
  /** 至少保留一个启用的管理员 */
  adminCount(): number {
    const r = getDb()
      .prepare("select count(*) as c from account where role = 'admin' and enabled = 1")
      .get() as Row;
    return n(r.c);
  },
};

export const sessions = {
  create(tokenHash: string, accountId: string, ttlMs: number): void {
    const now = Date.now();
    getDb()
      .prepare('insert into session (token_hash, account_id, created_at, expires_at, last_seen_at) values (?,?,?,?,?)')
      .run(tokenHash, accountId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), new Date(now).toISOString());
  },
  /** 返回会话对应的账号；过期或禁用则返回 null 并顺手清理 */
  resolve(tokenHash: string): AccountRecord | null {
    const r = getDb().prepare('select * from session where token_hash = ?').get(tokenHash) as Row | undefined;
    if (!r) return null;
    const expiresAt = Date.parse(s(r.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      this.remove(tokenHash);
      return null;
    }
    const acc = accounts.get(s(r.account_id));
    if (!acc || !acc.enabled) {
      this.remove(tokenHash);
      return null;
    }
    getDb().prepare('update session set last_seen_at=? where token_hash=?').run(nowIso(), tokenHash);
    return acc;
  },
  remove(tokenHash: string): void {
    getDb().prepare('delete from session where token_hash = ?').run(tokenHash);
  },
  removeByAccount(accountId: string): void {
    getDb().prepare('delete from session where account_id = ?').run(accountId);
  },
  purgeExpired(): void {
    getDb().prepare('delete from session where expires_at < ?').run(nowIso());
  },
};

/* ────────────────────────── import ────────────────────────── */

export type ImportStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type ImportStep = {
  key: string;
  label: string;
  status: ImportStepStatus;
  /** 这一步的说明，如「解析出 12 个接口」 */
  detail: string;
  startedAt?: string;
  endedAt?: string;
};

export type ImportJobRecord = {
  id: string;
  kind: string;
  inputRef: string;
  status: string;
  stats: Record<string, unknown>;
  error: string | null;
  aiUsed: boolean;
  /** 进度步骤，前端据此显示流水线 */
  steps: ImportStep[];
  /** 0-100 */
  progress: number;
  /** 本次涉及几个站点 */
  siteCount: number;
  createdAt: string;
  finishedAt: string | null;
};

function rowToJob(r: Row): ImportJobRecord {
  return {
    id: s(r.id),
    kind: s(r.kind),
    inputRef: s(r.input_ref),
    status: s(r.status, 'pending'),
    stats: safeJsonParse(s(r.stats, '{}'), {}),
    error: r.error ? s(r.error) : null,
    aiUsed: n(r.ai_used) === 1,
    steps: safeJsonParse<ImportStep[]>(s(r.steps, '[]'), []),
    progress: n(r.progress, 0),
    siteCount: n(r.site_count, 0),
    createdAt: s(r.created_at),
    finishedAt: r.finished_at ? s(r.finished_at) : null,
  };
}

export const importJobs = {
  create(kind: string, inputRef = '', steps: ImportStep[] = []): ImportJobRecord {
    const id = newId('ij');
    getDb()
      .prepare(
        'insert into import_job (id, kind, input_ref, status, steps, progress, created_at) values (?,?,?,?,?,?,?)',
      )
      .run(id, kind, inputRef, 'queued', toJson(steps), 0, nowIso());
    return this.get(id)!;
  },
  get(id: string): ImportJobRecord | null {
    const r = getDb().prepare('select * from import_job where id = ?').get(id) as Row | undefined;
    return r ? rowToJob(r) : null;
  },
  list(limit = 30): ImportJobRecord[] {
    return (getDb().prepare('select * from import_job order by created_at desc limit ?').all(limit) as Row[]).map(
      rowToJob,
    );
  },
  /** 更新单步状态 */
  setStep(id: string, key: string, patch: Partial<ImportStep>): void {
    const job = this.get(id);
    if (!job) return;
    const steps = job.steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
    const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    const progress = steps.length ? Math.round((done / steps.length) * 100) : 0;
    getDb()
      .prepare('update import_job set steps=?, progress=? where id=?')
      .run(toJson(steps), progress, id);
  },
  /** 一次性写入全部步骤（用于初始化） */
  setSteps(id: string, steps: ImportStep[]): void {
    const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    const progress = steps.length ? Math.round((done / steps.length) * 100) : 0;
    getDb().prepare('update import_job set steps=?, progress=? where id=?').run(toJson(steps), progress, id);
  },
  setStatus(id: string, status: string): void {
    getDb().prepare('update import_job set status=? where id=?').run(status, id);
  },
  setSiteCount(id: string, count: number): void {
    getDb().prepare('update import_job set site_count=? where id=?').run(count, id);
  },
  /** 服务重启后，把卡在 running/queued 的任务标为中断 */
  markInterrupted(): number {
    const r = getDb()
      .prepare(
        `update import_job set status='interrupted', error='服务重启，任务中断', finished_at=?
         where status in ('queued','running')`,
      )
      .run(nowIso());
    return Number(r.changes ?? 0);
  },
  remove(id: string): void {
    getDb().prepare('delete from import_candidate where job_id = ?').run(id);
    getDb().prepare('delete from import_job where id = ?').run(id);
  },
  finish(id: string, status: string, stats: Record<string, unknown>, error: string | null, aiUsed: boolean): void {
    // 收尾时把没跑完的步骤落定，别让「已完成」的任务里还挂着 running/pending，
    // 也别让 done 的任务停在 0% —— 之前就是这样出现的「完成却 0%」。
    const job = this.get(id);
    let steps = job?.steps ?? [];
    if (steps.length > 0) {
      steps = steps.map((s) =>
        s.status === 'running' || s.status === 'pending'
          ? {
              ...s,
              status: status === 'done' ? 'skipped' : 'failed',
              detail: s.detail || (status === 'done' ? '未执行（已跳过）' : '任务未完成'),
            }
          : s,
      );
    }
    const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    const progress = status === 'done' ? 100 : steps.length ? Math.round((done / steps.length) * 100) : 0;
    getDb()
      .prepare(
        'update import_job set status=?, stats=?, error=?, ai_used=?, finished_at=?, steps=?, progress=? where id=?',
      )
      .run(status, toJson(stats), error, b(aiUsed), nowIso(), toJson(steps), progress, id);
  },
  addCandidate(input: {
    jobId: string;
    platformSlug: string;
    payload: EndpointInput;
    diffKind: string;
    targetEndpointId?: string | null;
  }): string {
    const id = newId('cd');
    getDb()
      .prepare(
        `insert into import_candidate (id, job_id, platform_slug, payload, diff_kind, target_endpoint_id, decision, created_at)
         values (?,?,?,?,?,?,'pending',?)`,
      )
      .run(id, input.jobId, input.platformSlug, toJson(input.payload), input.diffKind, input.targetEndpointId ?? null, nowIso());
    return id;
  },
  listCandidates(jobId: string): CandidateRecord[] {
    const rows = getDb()
      .prepare('select * from import_candidate where job_id = ? order by created_at')
      .all(jobId) as Row[];
    return rows.map((r) => ({
      id: s(r.id),
      jobId: s(r.job_id),
      platformSlug: s(r.platform_slug),
      payload: safeJsonParse(s(r.payload, '{}'), {} as EndpointInput),
      diffKind: s(r.diff_kind, 'new') as CandidateRecord['diffKind'],
      targetEndpointId: r.target_endpoint_id ? s(r.target_endpoint_id) : null,
      decision: s(r.decision, 'pending') as CandidateRecord['decision'],
      createdAt: s(r.created_at),
    }));
  },
  getCandidate(id: string): CandidateRecord | null {
    const r = getDb().prepare('select * from import_candidate where id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: s(r.id),
      jobId: s(r.job_id),
      platformSlug: s(r.platform_slug),
      payload: safeJsonParse(s(r.payload, '{}'), {} as EndpointInput),
      diffKind: s(r.diff_kind, 'new') as CandidateRecord['diffKind'],
      targetEndpointId: r.target_endpoint_id ? s(r.target_endpoint_id) : null,
      decision: s(r.decision, 'pending') as CandidateRecord['decision'],
      createdAt: s(r.created_at),
    };
  },
  setCandidateDecision(id: string, decision: string): void {
    getDb().prepare('update import_candidate set decision=? where id=?').run(decision, id);
  },
};

/* ────────────────────────── audit ────────────────────────── */

/** 审计写入的订阅者：网关每调用一次就通知一次，用于实时流水 */
const auditListeners = new Set<(rec: AuditRecord) => void>();

export const audit = {
  append(rec: Omit<AuditRecord, 'id'>): void {
    const id = newId('au');
    getDb()
      .prepare(
        `insert into audit_log (id, ts, request_id, api_key_id, channel, actor, tool_name, endpoint_id, status,
           ok, latency_ms, upstream_host, error_code, req_meta, resp_meta)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        rec.ts,
        rec.requestId,
        rec.apiKeyId ?? null,
        rec.channel,
        rec.actor ?? null,
        rec.toolName,
        rec.endpointId ?? null,
        rec.status,
        b(rec.ok),
        rec.latencyMs,
        rec.upstreamHost,
        rec.errorCode ?? null,
        toJson(rec.reqMeta),
        toJson(rec.respMeta),
      );

    // 广播给订阅者（实时流水）。单个订阅者抛错不能影响调用本身。
    if (auditListeners.size) {
      const full: AuditRecord = { id, ...rec };
      for (const fn of auditListeners) {
        try {
          fn(full);
        } catch {
          /* 忽略订阅者异常 */
        }
      }
    }
  },
  /** 订阅新的审计记录，返回取消订阅函数 */
  subscribe(fn: (rec: AuditRecord) => void): () => void {
    auditListeners.add(fn);
    return () => {
      auditListeners.delete(fn);
    };
  },
  list(opts: { limit?: number; tool?: string; okOnly?: boolean } = {}): AuditRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.tool) {
      where.push('tool_name = ?');
      args.push(opts.tool);
    }
    if (opts.okOnly) where.push('ok = 1');
    const sql = `select * from audit_log ${where.length ? `where ${where.join(' and ')}` : ''} order by ts desc limit ?`;
    args.push(opts.limit ?? 100);
    return (getDb().prepare(sql).all(...args) as Row[]).map((r) => ({
      id: s(r.id),
      ts: s(r.ts),
      requestId: s(r.request_id),
      apiKeyId: r.api_key_id ? s(r.api_key_id) : null,
      channel: s(r.channel, 'rest') as AuditRecord['channel'],
      actor: r.actor ? s(r.actor) : null,
      toolName: s(r.tool_name),
      endpointId: r.endpoint_id ? s(r.endpoint_id) : null,
      status: n(r.status),
      ok: n(r.ok) === 1,
      latencyMs: n(r.latency_ms),
      upstreamHost: s(r.upstream_host),
      errorCode: r.error_code ? s(r.error_code) : null,
      reqMeta: safeJsonParse(s(r.req_meta, '{}'), {}),
      respMeta: safeJsonParse(s(r.resp_meta, '{}'), {}),
    }));
  },
  stats(): { total: number; ok: number; failed: number; today: number; avgLatency: number } {
    const row = getDb()
      .prepare(
        `select count(*) as total,
                sum(case when ok = 1 then 1 else 0 end) as ok,
                sum(case when ok = 0 then 1 else 0 end) as failed,
                sum(case when substr(ts,1,10) = ? then 1 else 0 end) as today,
                avg(latency_ms) as avg_latency
         from audit_log`,
      )
      .get(new Date().toISOString().slice(0, 10)) as Row;
    return {
      total: n(row.total),
      ok: n(row.ok),
      failed: n(row.failed),
      today: n(row.today),
      avgLatency: Math.round(n(row.avg_latency)),
    };
  },
};

/* ────────────────────────── chat ────────────────────────── */

export type ChatMessageRecord = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls: unknown;
  toolResult: unknown;
  createdAt: string;
};

export const chats = {
  createSession(title = '新会话'): { id: string; title: string; createdAt: string } {
    const id = newId('cs');
    const ts = nowIso();
    getDb().prepare('insert into chat_session (id, title, created_at, updated_at) values (?,?,?,?)').run(id, title, ts, ts);
    return { id, title, createdAt: ts };
  },
  listSessions(): Array<{ id: string; title: string; updatedAt: string }> {
    return (getDb().prepare('select * from chat_session order by updated_at desc').all() as Row[]).map((r) => ({
      id: s(r.id),
      title: s(r.title),
      updatedAt: s(r.updated_at),
    }));
  },
  getSession(id: string): { id: string; title: string } | null {
    const r = getDb().prepare('select id, title from chat_session where id = ?').get(id) as Row | undefined;
    return r ? { id: s(r.id), title: s(r.title) } : null;
  },
  renameSession(id: string, title: string): void {
    getDb().prepare('update chat_session set title=?, updated_at=? where id=?').run(title, nowIso(), id);
  },
  addMessage(m: {
    sessionId: string;
    role: ChatMessageRecord['role'];
    content: string;
    toolCalls?: unknown;
    toolResult?: unknown;
  }): string {
    const id = newId('cm');
    getDb()
      .prepare(
        'insert into chat_message (id, session_id, role, content, tool_calls, tool_result, created_at) values (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        m.sessionId,
        m.role,
        m.content,
        m.toolCalls === undefined ? null : toJson(m.toolCalls),
        m.toolResult === undefined ? null : toJson(m.toolResult),
        nowIso(),
      );
    getDb().prepare('update chat_session set updated_at=? where id=?').run(nowIso(), m.sessionId);
    return id;
  },
  listMessages(sessionId: string, limit = 200): ChatMessageRecord[] {
    return (
      getDb()
        .prepare('select * from chat_message where session_id = ? order by created_at limit ?')
        .all(sessionId, limit) as Row[]
    ).map((r) => ({
      id: s(r.id),
      sessionId: s(r.session_id),
      role: s(r.role, 'user') as ChatMessageRecord['role'],
      content: s(r.content),
      toolCalls: safeJsonParse(s(r.tool_calls ?? 'null'), null),
      toolResult: safeJsonParse(s(r.tool_result ?? 'null'), null),
      createdAt: s(r.created_at),
    }));
  },
  removeSession(id: string): void {
    getDb().prepare('delete from chat_session where id = ?').run(id);
  },
};

/* ────────────────────────── settings ────────────────────────── */

export const settings = {
  get<T>(key: string, fallback: T): T {
    const r = getDb().prepare('select value from setting where key = ?').get(key) as Row | undefined;
    if (!r) return fallback;
    return safeJsonParse<T>(s(r.value), fallback);
  },
  set(key: string, value: unknown): void {
    getDb()
      .prepare('insert into setting (key, value) values (?,?) on conflict(key) do update set value=excluded.value')
      .run(key, toJson(value));
  },
  all(): Record<string, unknown> {
    const rows = getDb().prepare('select key, value from setting').all() as Row[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[s(r.key)] = safeJsonParse(s(r.value), null);
    return out;
  },
};

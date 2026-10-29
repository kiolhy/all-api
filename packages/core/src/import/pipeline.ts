import type { EndpointInput, EndpointRecord, ImportKind } from '../schema/asset.ts';
import { importJobs, endpoints, platforms, tools, secrets } from '../db/repos.ts';
import type { ImportStep } from '../db/repos.ts';
import { loadConfig } from '../config.ts';
import { encryptSecret } from '../secrets/vault.ts';
import type { NormalizedDraft } from './types.ts';
import { looksLikeCurl, parseCurl } from './curl.ts';
import { looksLikeHar, parseHar } from './har.ts';
import { looksLikeOpenapi, parseOpenapi } from './openapi.ts';
import { specToDraft, slugify } from './normalize.ts';
import { extractDraftsFromText } from './enrich.ts';
import { runAgents } from '../agents/index.ts';
import type { StepPatch } from '../agents/index.ts';
import { fetchSiteInfo, hostToName } from './site.ts';
import { classify, uniqueSlug } from './dedupe.ts';
import { compileTool } from '../tools/compile.ts';

export type ImportOptions = {
  text: string;
  kind?: ImportKind | 'auto';
  platformSlug?: string;
  platformName?: string;
  useAi?: boolean;
  autoPublish?: boolean;
  /** 是否让探测 Agent 真实请求上游（默认 true） */
  probeUpstream?: boolean;
  /** 单次最多探测几个接口 */
  maxProbes?: number;
  /** 复用已有任务（后台异步导入时由调用方先建好） */
  jobId?: string;
  /** 步骤进度回调 */
  onStep?: (key: string, patch: StepPatch) => void;
};

/** 导入流水线的标准步骤 */
export const IMPORT_STEPS: Array<{ key: string; label: string }> = [
  { key: 'detect', label: '识别格式' },
  { key: 'parse', label: '解析接口' },
  { key: 'site', label: '识别站点' },
  { key: 'probe', label: '探测上游' },
  { key: 'analyze', label: 'AI 分析用途' },
  { key: 'naming', label: 'AI 生成对外名' },
  { key: 'dedupe', label: '去重入库' },
  { key: 'publish', label: '自动发布' },
];

export function makeSteps(): ImportStep[] {
  return IMPORT_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    status: 'pending' as const,
    detail: '',
  }));
}

export type ImportStats = {
  detected: ImportKind;
  parsed: number;
  candidates: number;
  duplicates: number;
  conflicts: number;
  aiUsed: boolean;
  aiEnriched: number;
  aiErrors: string[];
  platformsCreated: string[];
  autoPublished: number;
  /** Agent 流水线的一句话总结 */
  agentSummary: string;
  /** 探测统计 */
  probe: { attempted: number; succeeded: number; failed: number; skipped: number };
  /** Agent 流水线耗时（毫秒），用来判断慢在哪 */
  agentElapsedMs: number;
  /** 本次涉及的站点（按 host 自动归组） */
  sites: Array<{ slug: string; name: string; baseUrl: string; count: number }>;
};

export type ImportOutcome = {
  jobId: string;
  status: string;
  stats: ImportStats;
  error?: string;
};

export function detectKind(text: string): ImportKind {
  const t = text.trim();
  if (!t) return 'text';
  if (looksLikeHar(t)) return 'har';
  if (looksLikeOpenapi(t)) return 'openapi';
  if (looksLikeCurl(t)) return 'curl';
  return 'text';
}

export async function runImport(opts: ImportOptions): Promise<ImportOutcome> {
  const cfg = loadConfig();
  const step = (key: string, patch: StepPatch): void => {
    if (opts.jobId) importJobs.setStep(opts.jobId, key, patch);
    opts.onStep?.(key, patch);
  };

  const kind = !opts.kind || opts.kind === 'auto' ? detectKind(opts.text) : opts.kind;
  const job = opts.jobId
    ? importJobs.get(opts.jobId)!
    : importJobs.create(kind, `${opts.text.length}B`, makeSteps());

  if (opts.jobId) importJobs.setStatus(opts.jobId, 'running');

  const stats: ImportStats = {
    detected: kind,
    parsed: 0,
    candidates: 0,
    duplicates: 0,
    conflicts: 0,
    aiUsed: false,
    aiEnriched: 0,
    aiErrors: [],
    platformsCreated: [],
    autoPublished: 0,
    agentSummary: '',
    probe: { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    agentElapsedMs: 0,
    sites: [],
  };

  step('detect', { status: 'done', detail: `识别为 ${kind}` });

  try {
    let drafts: NormalizedDraft[] = [];

    if (kind === 'curl') {
      const specs = parseCurl(opts.text);
      stats.parsed = specs.length;
      drafts = specs
        .map((s) => specToDraft(s, { platformSlug: opts.platformSlug, platformName: opts.platformName }))
        .filter((d): d is NormalizedDraft => d !== null);
    } else if (kind === 'har') {
      const specs = parseHar(opts.text);
      stats.parsed = specs.length;
      drafts = specs
        .map((s) => specToDraft(s, { platformSlug: opts.platformSlug, platformName: opts.platformName }))
        .filter((d): d is NormalizedDraft => d !== null);
    } else if (kind === 'openapi') {
      drafts = parseOpenapi(opts.text, { platformSlug: opts.platformSlug, platformName: opts.platformName });
      stats.parsed = drafts.length;
    } else {
      const baseUrl = guessBaseUrl(opts.text);
      if (!baseUrl) {
        throw new Error('纯文本整理需要能识别到至少一个域名（或指定平台），例如 https://api.example.com');
      }
      const extracted = await extractDraftsFromText(cfg.llm, opts.text, {
        platformSlug: opts.platformSlug,
        platformName: opts.platformName,
        baseUrl,
      });
      if (extracted.error) stats.aiErrors.push(extracted.error);
      const slug = opts.platformSlug ?? slugify(new URL(baseUrl).hostname.split('.')[0] ?? 'api');
      drafts = extracted.drafts.map((d) => textDraftToNormalized(d, slug, baseUrl, opts.platformName ?? slug));
      stats.parsed = drafts.length;
    }

    if (!drafts.length) {
      throw new Error('没有解析出任何接口，请检查输入格式');
    }

    // ── 按站点归组 ──
    // 同一个 host 的接口自动归到同一个平台；不同 host 各成一个站点。
    const siteKeys = [...new Set(drafts.map((d) => d.platformSlug))];
    stats.sites = siteKeys.map((slug) => {
      const d = drafts.find((x) => x.platformSlug === slug)!;
      return { slug, name: d.platformName, baseUrl: d.platformBaseUrl, count: 0 };
    });
    for (const d of drafts) {
      const site = stats.sites.find((s) => s.slug === d.platformSlug);
      if (site) site.count += 1;
    }
    if (opts.jobId) importJobs.setSiteCount(opts.jobId, siteKeys.length);

    step('parse', {
      status: 'done',
      detail: `解析出 ${drafts.length} 个接口，分属 ${siteKeys.length} 个站点`,
    });

    // ── 平台落地（先落地，探测 Agent 需要 baseUrl 和出网配置）──
    const platformIdBySlug = new Map<string, string>();
    step('site', { status: 'running', detail: '正在获取站点标题' });

    // 先把所有站点的标题并行抓回来，避免逐个等 5 秒超时
    const needFetch = siteKeys.filter((slug) => {
      const existing = platforms.bySlug(slug);
      return !existing || !existing.siteTitle;
    });
    const siteInfoBySlug = new Map<string, Awaited<ReturnType<typeof fetchSiteInfo>>>();
    if (needFetch.length) {
      step('site', { status: 'running', detail: `正在获取 ${needFetch.length} 个站点的标题` });
      const results = await Promise.all(
        needFetch.map(async (slug) => {
          const d = drafts.find((x) => x.platformSlug === slug)!;
          const existing = platforms.bySlug(slug);
          const baseUrl = existing?.baseUrl ?? d.platformBaseUrl;
          return [slug, await fetchSiteInfo(baseUrl)] as const;
        }),
      );
      for (const [slug, info] of results) siteInfoBySlug.set(slug, info);
    }

    for (const d of drafts) {
      if (platformIdBySlug.has(d.platformSlug)) continue;
      const existing = platforms.bySlug(d.platformSlug);
      if (existing) {
        platformIdBySlug.set(d.platformSlug, existing.id);
        // 老平台没标题的补抓一次
        const info = siteInfoBySlug.get(d.platformSlug);
        if (info?.title && !existing.siteTitle) {
          platforms.setSiteInfo(existing.id, info.title, info.icon);
        }
        const site = stats.sites.find((s) => s.slug === d.platformSlug);
        if (site && existing.name) site.name = existing.name;
        continue;
      }

      // 用抓到的站点标题作为平台名
      const info = siteInfoBySlug.get(d.platformSlug);
      const displayName =
        (info?.title || '').trim() || d.platformName || hostToName(d.platformBaseUrl);

      const created = platforms.create({
        slug: d.platformSlug,
        name: displayName,
        baseUrl: d.platformBaseUrl,
        authKind: 'none',
        authConfig: {},
        defaultHeaders: {},
        egressAllowHosts: [safeHost(d.platformBaseUrl)],
        rateLimit: { qps: 5, daily: 10000 },
        allowPrivate: isLocalHost(safeHost(d.platformBaseUrl)),
        notes: '自动创建于一键整理',
      });
      if (info?.title || info?.icon) platforms.setSiteInfo(created.id, info.title, info.icon);
      platformIdBySlug.set(d.platformSlug, created.id);
      stats.platformsCreated.push(d.platformSlug);
      const site = stats.sites.find((s) => s.slug === d.platformSlug);
      if (site) site.name = displayName;
    }

    // 汇总标题：新抓到的 + 老平台已有的
    const knownTitles = siteKeys
      .map((slug) => {
        const fresh = siteInfoBySlug.get(slug)?.title;
        const old = platforms.bySlug(slug)?.siteTitle;
        const t = (fresh || old || '').trim();
        return t ? `${slug} → ${t}` : '';
      })
      .filter(Boolean);

    step('site', {
      status: 'done',
      detail: knownTitles.length
        ? `识别 ${siteKeys.length} 个站点，标题：${knownTitles.slice(0, 3).join('；')}${knownTitles.length > 3 ? ' 等' : ''}`
        : `识别 ${siteKeys.length} 个站点（首页没有标题，用域名代替）`,
    });

    // ── 密钥落地（探测需要密钥才能请求成功）──
    for (const d of drafts) {
      for (const s of d.secrets) {
        if (secrets.getCipher(s.name)) continue;
        secrets.put(s.name, encryptSecret(s.value), s.hint);
      }
    }

    // ── Agent 流水线：探测 → 分析 → 命名 ──
    if (opts.useAi !== false) {
      const report = await runAgents(
        cfg.llm,
        drafts,
        (d: NormalizedDraft) => {
          const id = platformIdBySlug.get(d.platformSlug);
          return id ? platforms.get(id) : null;
        },
        {
          probe: opts.probeUpstream !== false,
          analyze: true,
          naming: true,
          maxProbes: opts.maxProbes,
          onStep: step,
        },
      );
      stats.aiUsed = report.analyze.aiUsed || report.naming.aiUsed;
      stats.aiEnriched = report.analyze.analyzed;
      stats.aiErrors.push(...report.analyze.errors, ...report.naming.errors);
      stats.agentSummary = report.summary;
      stats.agentElapsedMs = report.elapsedMs;
      stats.probe = {
        attempted: report.probe.attempted,
        succeeded: report.probe.succeeded,
        failed: report.probe.failed,
        skipped: report.probe.skipped,
      };
    } else {
      step('probe', { status: 'skipped', detail: '已关闭 AI' });
      step('analyze', { status: 'skipped', detail: '已关闭 AI' });
      step('naming', { status: 'skipped', detail: '已关闭 AI' });
    }

    step('dedupe', { status: 'running', detail: '正在去重' });

    // ── 候选去重 ──
    const batchSeen = new Map<string, string>();
    const acceptedIds: string[] = [];

    for (const d of drafts) {
      const platformId = platformIdBySlug.get(d.platformSlug)!;
      const input: EndpointInput = { ...d.endpoint };

      // 先按草稿 slug 分类，再决定要不要去重。
      // 以前这里先 uniqueSlug 再 classify，导致重复导入同一份文档时
      // 自己的 slug 被当成冲突 → 顶成 _2，下次 _3，工具名跟着一路漂。
      const cls = classify(platformId, input, batchSeen);

      if (cls.diffKind === 'modified' && cls.targetEndpointId) {
        // 更新已有接口：slug 按草稿来，但排除自己再判重。
        // 这样重复导入保持稳定，历史上被顶成 _2 的也能修回原名。
        input.slug = uniqueSlug(platformId, input.slug, cls.targetEndpointId);
      } else if (cls.diffKind === 'new') {
        input.slug = uniqueSlug(platformId, input.slug);
      }

      batchSeen.set(`${input.method} ${input.pathTemplate}`, input.slug);

      if (cls.diffKind === 'duplicate') {
        stats.duplicates += 1;
        continue;
      }
      if (cls.diffKind === 'conflict') stats.conflicts += 1;

      const candidateId = importJobs.addCandidate({
        jobId: job.id,
        platformSlug: d.platformSlug,
        payload: input,
        diffKind: cls.diffKind,
        targetEndpointId: cls.targetEndpointId,
      });
      stats.candidates += 1;
      acceptedIds.push(candidateId);
    }

    step('dedupe', {
      status: 'done',
      detail: `候选 ${stats.candidates} 个，重复 ${stats.duplicates} 个，冲突 ${stats.conflicts} 个`,
    });

    // ── 自动发布 ──
    if (opts.autoPublish) {
      step('publish', { status: 'running', detail: '正在发布' });
      for (const id of acceptedIds) {
        const cand = importJobs.getCandidate(id);
        if (!cand) continue;
        if (cand.diffKind === 'conflict') continue;
        const res = acceptCandidate(id);
        if (res) stats.autoPublished += 1;
      }
      step('publish', { status: 'done', detail: `已发布 ${stats.autoPublished} 个` });
    } else {
      step('publish', { status: 'skipped', detail: '未开启自动发布，可在「整理记录」页发布' });
    }

    importJobs.finish(job.id, 'done', stats as unknown as Record<string, unknown>, null, stats.aiUsed);
    return { jobId: job.id, status: 'done', stats };
  } catch (err) {
    const message = (err as Error).message;
    // 把当前还在 running 的步骤标成失败，前端能看出断在哪
    const cur = importJobs.get(job.id);
    if (cur) {
      for (const s of cur.steps) {
        if (s.status === 'running' || s.status === 'pending') {
          step(s.key, { status: 'failed', detail: message.slice(0, 200) });
        }
      }
    }
    importJobs.finish(job.id, 'failed', stats as unknown as Record<string, unknown>, message, stats.aiUsed);
    return { jobId: job.id, status: 'failed', stats, error: message };
  }
}

/** 采纳一个候选：创建或更新接口 → 发布 → 编译工具 */
export function acceptCandidate(candidateId: string): { endpointId: string; created: boolean } | null {
  const cand = importJobs.getCandidate(candidateId);
  if (!cand) return null;
  const platform = platforms.bySlug(cand.platformSlug);
  if (!platform) return null;

  let endpointId: string;
  let created = false;

  if (cand.targetEndpointId) {
    const updated = endpoints.update(cand.targetEndpointId, cand.payload);
    endpointId = updated?.id ?? cand.targetEndpointId;
  } else {
    const slug = uniqueSlug(platform.id, cand.payload.slug);
    const ep = endpoints.create(
      platform.id,
      { ...cand.payload, slug },
      { sourceKind: 'import', sourceRef: cand.jobId },
    );
    endpointId = ep.id;
    created = true;
  }

  publishAndCompile(endpointId);
  importJobs.setCandidateDecision(candidateId, 'accept');
  return { endpointId, created };
}

export function rejectCandidate(candidateId: string): void {
  importJobs.setCandidateDecision(candidateId, 'reject');
}

export function publishAndCompile(endpointId: string): EndpointRecord | null {
  const published = endpoints.publish(endpointId, '一键整理发布');
  if (!published) return null;
  const platform = platforms.get(published.platformId);
  const compiled = compileTool(published, { platformName: platform?.name });
  const name = ensureToolName(compiled.name, published.id);
  tools.upsert({
    endpointId: published.id,
    name,
    title: compiled.title,
    description: compiled.description,
    inputSchema: compiled.inputSchema,
    cacheTtl: compiled.cacheTtl,
    annotations: compiled.annotations,
    enabled: true,
  });
  return published;
}

function ensureToolName(desired: string, endpointId: string): string {
  const existing = tools.byName(desired);
  if (!existing || existing.endpointId === endpointId) return desired;
  let i = 2;
  let name = `${desired}_${i}`;
  while (tools.byName(name)) {
    i += 1;
    name = `${desired}_${i}`;
  }
  return name.slice(0, 64);
}

/* ────────────────────────── 辅助 ────────────────────────── */

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function guessBaseUrl(text: string): string | null {
  const m = /https?:\/\/[A-Za-z0-9._-]+(?::\d+)?/.exec(text);
  return m ? m[0] : null;
}

function textDraftToNormalized(
  d: { method: string; path: string; summary: string; params: Array<{ name: string; in: string; required: boolean; description: string }> },
  platformSlug: string,
  baseUrl: string,
  platformName: string,
): NormalizedDraft {
  const params = d.params
    .filter((p) => ['path', 'query', 'header', 'body'].includes(p.in))
    .map((p) => ({
      name: p.name,
      in: p.in as 'path' | 'query' | 'header' | 'body',
      type: 'string' as const,
      required: p.required,
      description: p.description,
    }));

  for (const m of d.path.matchAll(/\{([^}]+)\}/g)) {
    if (!params.some((p) => p.in === 'path' && p.name === m[1])) {
      params.push({ name: m[1], in: 'path', type: 'string', required: true, description: '' });
    }
  }

  const method = d.method.toUpperCase() as EndpointInput['method'];
  return {
    platformSlug,
    platformBaseUrl: baseUrl,
    platformName,
    secrets: [],
    endpoint: {
      slug: slugify(`${d.method}_${d.path}`),
      group: (d.path.split('/').filter(Boolean)[0] ?? 'default').replace(/[^a-z0-9_-]/gi, '') || 'default',
      method,
      pathTemplate: d.path.startsWith('/') ? d.path : `/${d.path}`,
      summary: d.summary,
      description: '',
      params,
      body: null,
      response: {
        contentType: 'application/json',
        pick: [],
        unwrap: null,
        transform: null,
        redactFields: [],
        maxBytes: 2 * 1024 * 1024,
      },
      sideEffect: method === 'GET' ? 'read' : 'write',
      sensitivity: 'medium',
      tags: ['text'],
      examples: [],
      notes: '来自文档文本抽取',
      exposure: 'open',
      publicName: '',
      allowedKeyIds: [],
    },
  };
}

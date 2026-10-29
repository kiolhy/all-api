import type { PlatformRecord } from '../schema/asset.ts';

export type HubError = Error & { code: string; status: number };

export function hubError(code: string, message: string, status = 400): HubError {
  const e = new Error(message) as HubError;
  e.code = code;
  e.status = status;
  return e;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((re) => re.test(h));
  return false;
}

/** 出网前校验：host 白名单 + 私网策略 */
export function assertEgressAllowed(platform: PlatformRecord, target: URL, allowPrivateGlobal: boolean): void {
  const baseHost = (() => {
    try {
      return new URL(platform.baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const declared = platform.egressAllowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  // 显式声明了白名单就严格按白名单收窄；没声明才回落到 baseUrl 的 host
  const allow = new Set(declared.length ? declared : [baseHost].filter(Boolean));
  const host = target.hostname.toLowerCase();

  if (!allow.has(host)) {
    throw hubError(
      'egress_host_blocked',
      `目标主机 ${host} 不在平台 ${platform.slug} 的出网白名单内（允许：${[...allow].join(', ') || '无'}）`,
      403,
    );
  }
  const privateOk = allowPrivateGlobal || platform.allowPrivate;
  if (!privateOk && isPrivateHost(host)) {
    throw hubError('egress_private_blocked', `禁止访问私网地址 ${host}`, 403);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw hubError('egress_protocol_blocked', `不支持的协议 ${target.protocol}`, 403);
  }
}

/** 路径穿越 / 注入防护 */
export function assertSafePath(pathname: string): void {
  if (pathname.includes('..')) throw hubError('path_traversal', '路径包含 ..', 400);
  if (/^[a-z]+:/i.test(pathname)) throw hubError('path_scheme', '路径包含协议前缀', 400);
  if (pathname.includes('\n') || pathname.includes('\r')) throw hubError('path_injection', '路径含控制字符', 400);
  if (pathname.includes('//')) throw hubError('path_double_slash', '路径含连续斜杠', 400);
}

/* ────────────────────────── 限流 ────────────────────────── */

type Bucket = { tokens: number; updated: number };

const buckets = new Map<string, Bucket>();
const dailyCounts = new Map<string, { day: string; count: number }>();

export function consumeRate(key: string, qps: number, daily: number): void {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: qps, updated: now };
  const elapsed = (now - bucket.updated) / 1000;
  bucket.tokens = Math.min(qps, bucket.tokens + elapsed * qps);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    throw hubError('rate_limited', `触发限流：${qps} QPS`, 429);
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);

  const day = new Date().toISOString().slice(0, 10);
  const dc = dailyCounts.get(key);
  if (!dc || dc.day !== day) {
    dailyCounts.set(key, { day, count: 1 });
    return;
  }
  dc.count += 1;
  if (dc.count > daily) throw hubError('daily_quota_exceeded', `超出每日配额 ${daily}`, 429);
}

/* ────────────────────────── 熔断 ────────────────────────── */

const breakers = new Map<string, { failures: number; openUntil: number }>();

export function assertBreaker(key: string): void {
  const b = breakers.get(key);
  if (b && b.openUntil > Date.now()) {
    throw hubError('circuit_open', '上游连续失败，熔断中，请稍后重试', 503);
  }
}

export function recordBreaker(key: string, ok: boolean): void {
  const b = breakers.get(key) ?? { failures: 0, openUntil: 0 };
  if (ok) {
    b.failures = 0;
    b.openUntil = 0;
  } else {
    b.failures += 1;
    if (b.failures >= 5) {
      b.openUntil = Date.now() + 60_000;
      b.failures = 0;
    }
  }
  breakers.set(key, b);
}

export function resetGuardState(): void {
  buckets.clear();
  dailyCounts.clear();
  breakers.clear();
}

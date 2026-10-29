/**
 * IP 白名单匹配。支持：
 * - 精确 IPv4 / IPv6：`1.2.3.4`、`::1`
 * - IPv4 CIDR：`10.0.0.0/8`、`192.168.1.0/24`
 * - 通配：`10.0.0.*`
 * - `*` 或空列表：不限制
 */

function normalizeIp(raw: string): string {
  let ip = (raw || '').trim();
  if (!ip) return '';
  // Express/Fastify 可能给 ::ffff:1.2.3.4
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  // 去掉 IPv6 的方括号与端口
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  // 去掉 IPv4 的端口
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0]!;
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function matchCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0);
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

function matchWildcard(ip: string, pattern: string): boolean {
  const ipParts = ip.split('.');
  const patParts = pattern.split('.');
  if (ipParts.length !== 4 || patParts.length !== 4) return false;
  return patParts.every((part, i) => part === '*' || part === ipParts[i]);
}

/** 判断某个 IP 是否命中白名单。白名单为空或含 `*` 视为不限制。 */
export function ipAllowed(ip: string, allowlist: string[] | undefined | null): boolean {
  const list = (allowlist ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  if (list.includes('*')) return true;

  const target = normalizeIp(ip);
  if (!target) return false;

  for (const entry of list) {
    const item = normalizeIp(entry);
    if (!item) continue;
    if (item === target) return true;
    if (item.includes('/') && matchCidr(target, item)) return true;
    if (item.includes('*') && matchWildcard(target, item)) return true;
  }
  return false;
}

/** 校验白名单条目格式，返回错误说明；合法返回 null */
export function ipAllowlistProblem(entry: string): string | null {
  const item = entry.trim();
  if (!item) return '空的条目';
  if (item === '*') return null;
  if (item.includes('/')) {
    const [base, bitsRaw] = item.split('/');
    const bits = Number(bitsRaw);
    if (ipv4ToInt(base ?? '') === null) return `CIDR 网段不合法：${item}`;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return `CIDR 掩码不合法：${item}`;
    return null;
  }
  if (item.includes('*')) {
    const parts = item.split('.');
    if (parts.length !== 4 || !parts.every((p) => p === '*' || /^\d{1,3}$/.test(p))) {
      return `通配格式不合法：${item}`;
    }
    return null;
  }
  if (ipv4ToInt(item) !== null) return null;
  // 简单 IPv6 校验：包含冒号即认为是 IPv6
  if (item.includes(':')) return null;
  return `IP 格式不合法：${item}`;
}

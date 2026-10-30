/**
 * SSRF 出网守卫（DNS 级）
 *
 * 之前的 `assertEgressAllowed` 只看**字面量 hostname**：
 * `isPrivateHost('127.0.0.1')` 能拦，但下面这些都拦不住：
 *   - 域名解析到内网（`internal.example.com → 10.0.0.5`）
 *   - 十进制/八进制/十六进制 IP（`2130706433`、`0177.0.0.1`、`0x7f.1`）
 *   - IPv4 映射的 IPv6（`::ffff:127.0.0.1`）
 *   - 尾点写法（`127.0.0.1.`）
 *   - URL 里带 userinfo 混淆（`http://evil.com@127.0.0.1/`）
 *
 * 所以真正的判定必须在 **DNS 解析之后**、**连上去之前**做：
 * 先 `lookup` 出实际要连的地址，逐个校验，再决定是否放行。
 *
 * 这和「只启动时校验一次」的区别很关键：DNS rebinding 攻击
 * （第一次解析给公网、第二次给内网）只有"每次连接前都解析并校验"才能挡住。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hubError } from '../invoke/guard.ts';

/** 明确的保留/内网网段（IPv4） */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // 运营商级 NAT（含阿里云元数据 100.100.100.200）
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档用
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档用
  ['203.0.113.0', 24], // 文档用
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255）
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** IPv4 是否落在被禁止的网段 */
export function isBlockedV4(ip: string): boolean {
  const v = v4ToInt(ip);
  if (v === null) return true;
  return BLOCKED_V4.some(([base, bits]) => {
    const b = v4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) >>> 0 === (b & mask) >>> 0;
  });
}

/**
 * 把各种奇怪写法的 IPv4 归一化（浏览器/Node 都认这些）：
 *   `2130706433`      → 127.0.0.1
 *   `0x7f.1`          → 127.0.0.1
 *   `0177.0.0.1`      → 127.0.0.1
 *   `127.1`           → 127.0.0.1
 * 无法归一化则返回 null。
 */
export function normalizeObscureIpv4(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;

  // 纯数字（整数形式）
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
  }

  const parts = h.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (/^0x[0-9a-f]+$/.test(p)) nums.push(Number.parseInt(p.slice(2), 16));
    else if (/^0[0-7]+$/.test(p)) nums.push(Number.parseInt(p.slice(1), 8));
    else if (/^\d+$/.test(p)) nums.push(Number(p));
    else return null;
  }
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  // a.b.c.d / a.b.c / a.b / a 的短写规则：最后一段补齐剩余字节
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  const remainingBytes = 4 - head.length;
  const maxLast = 256 ** remainingBytes;
  if (last >= maxLast) return null;
  const bytes = [...head];
  for (let i = remainingBytes - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  if (bytes.length !== 4 || bytes.some((b) => b > 255)) return null;
  return bytes.join('.');
}

/** IPv6 是否落在禁止范围（回环 / 链路本地 / 唯一本地 / 映射到 IPv4 的内网） */
export function isBlockedV6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (h === '::' || h === '::1') return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 链路本地
  if (/^ff/.test(h)) return true; // 组播
  // ::ffff:a.b.c.d / ::ffff:7f00:1 这类映射地址要按 IPv4 规则判
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return isBlockedV4(tail);
    // 十六进制两段写法
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isBlockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
  }
  // 6to4 / Teredo 里嵌的 IPv4 也判一下
  if (h.startsWith('2002:')) {
    const seg = h.split(':')[1] ?? '';
    if (/^[0-9a-f]{4}$/.test(seg)) {
      const hi = Number.parseInt(seg.slice(0, 2), 16);
      const lo = Number.parseInt(seg.slice(2), 16);
      return isBlockedV4(`${hi}.${lo}.0.0`);
    }
  }
  return false;
}

/** 一个已解析的地址是否禁止访问 */
export function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isBlockedV4(addr);
  if (family === 6) return isBlockedV6(addr);
  return true;
}

/** 特殊/本地主机名（这类名字必须解析后判定，不能只比字符串） */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.intranet'];

export type EgressTarget = {
  url: URL;
  /** 解析出的地址（已逐个校验） */
  addresses: string[];
};

export type EgressDecision = {
  /** 私网/回环是否允许（由服务端策略决定，不看请求体） */
  allowPrivate: boolean;
  /**
   * 允许的主机白名单。空数组 = 只信任 baseUrl 的 host。
   * 这只约束"能不能去别的主机"，不构成 SSRF 防护 —— 真正的防护是地址级判定。
   */
  allowHosts?: string[];
} & Record<string, never>;

/**
 * 解析目标并校验。
 *
 * 关键点：**先解析，再判定，最后交给 fetch（用解析结果锁定的地址）**。
 * 只校验 hostname 字面量会被 DNS rebinding 和多写法 IP 绕过。
 */
export async function resolveAndCheckTarget(
  url: URL,
  opts: { allowPrivate: boolean; allowHosts?: string[] },
): Promise<EgressTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw hubError('egress_protocol_blocked', `不支持的协议 ${url.protocol}`, 403);
  }
  if (url.username || url.password) {
    // userinfo 混淆：`http://user@host/` 会让日志与判定看到的 host 不一致
    throw hubError('egress_userinfo_blocked', 'URL 不允许携带用户名/密码', 403);
  }

  let host = url.hostname.toLowerCase();
  if (!host) throw hubError('egress_bad_host', 'URL 缺少主机名', 400);
  // 尾点：`127.0.0.1.` 与 `127.0.0.1` 是同一台机器
  host = host.replace(/\.+$/, '');
  const bare = host.replace(/^\[|\]$/g, '');

  // 白名单先看（这是"允许去哪些主机"，与"能不能进内网"是两件事）
  if (opts.allowHosts?.length) {
    const allowed = new Set(opts.allowHosts.map((h) => h.trim().toLowerCase().replace(/\.+$/, '')));
    if (!allowed.has(host) && !allowed.has(bare)) {
      throw hubError(
        'egress_host_blocked',
        `目标主机 ${host} 不在出网白名单内（允许：${[...allowed].join(', ') || '无'}）`,
        403,
      );
    }
  }

  // 字面量就是 IP：先归一化再判
  const literalV4 = normalizeObscureIpv4(bare);
  if (isIP(bare) === 6) {
    if (!opts.allowPrivate && isBlockedV6(bare)) {
      throw hubError('egress_private_blocked', `禁止访问内网/保留地址 ${bare}`, 403);
    }
    return { url, addresses: [bare] };
  }
  if (isIP(bare) === 4 || literalV4) {
    const ip = literalV4 ?? bare;
    if (!opts.allowPrivate && isBlockedV4(ip)) {
      throw hubError(
        'egress_private_blocked',
        `禁止访问内网/保留地址 ${ip}${ip !== bare ? `（由 ${bare} 解释而来）` : ''}`,
        403,
      );
    }
    return { url, addresses: [ip] };
  }

  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || host === 'localhost') {
    if (!opts.allowPrivate) {
      throw hubError('egress_private_blocked', `禁止访问本地域名 ${host}`, 403);
    }
  }

  // 域名：解析出真实地址再判（这一步同时挡掉 DNS rebinding 的第一跳）
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(bare, { all: true, verbatim: true });
  } catch {
    throw hubError('egress_dns_failed', `无法解析目标主机 ${host}`, 502);
  }
  if (!addrs.length) throw hubError('egress_dns_failed', `目标主机 ${host} 没有可用地址`, 502);

  const blocked = addrs.filter((a) => isBlockedAddress(a.address));
  if (blocked.length && !opts.allowPrivate) {
    throw hubError(
      'egress_private_blocked',
      `目标主机 ${host} 解析到内网/保留地址（${blocked.map((b) => b.address).join(', ')}），已拒绝`,
      403,
    );
  }
  // 解析结果里有任何一个达标地址就拒：否则"多 A 记录"里挑一条内网的就绕过去了
  if (blocked.length && opts.allowPrivate) {
    return { url, addresses: addrs.map((a) => a.address) };
  }

  return { url, addresses: addrs.map((a) => a.address) };
}

/**
 * 便捷判定：这个地址是否"公网可访问"。
 * 用于在控制台给管理员提示，不用于放行决策。
 */
export function isPublicAddress(addr: string): boolean {
  return !isBlockedAddress(addr);
}

/**
 * 路由级访问控制
 *
 * 设计原则：**默认拒绝**。
 * 以前整站的安全假设压在「全局 preHandler 用原始 URL 前缀判断」上，
 * 一旦这个判断对 `%61` 之类的编码不一致，所有写接口就裸奔了。
 *
 * 现在改成：
 *   1. 鉴权规则按「已注册路由（pattern）是否登记为公开」判定，而不是猜路径前缀
 *   2. 未登记的路由默认要求登录；写操作默认要求管理员
 *   3. 每个通过鉴权的请求都会被解析出 actor（账号 id），供审计归因
 */

import type { AccountRecord } from '../schema/asset.ts';
import type { NormalizedPath } from './path-normalize.ts';
import { pathStartsWith } from './path-normalize.ts';

/** 请求上挂的身份上下文 */
export type AuthContext = {
  account: AccountRecord | null;
  /** 已认证主体标识：`account:<id>` / `key:<apiKeyId>` / `admin-token` / `anonymous` */
  actor: string;
  /** 是否已通过管理员校验（console 通道唯一合法凭据） */
  admin: boolean;
};

type Rule = {
  match: (n: NormalizedPath) => boolean;
  /** 免登录 */
  public?: boolean;
  /** 只允许管理员 */
  admin?: boolean;
  /** 备注，报错时方便定位 */
  label?: string;
};

/**
 * 公开路由（不需要登录）。
 * 只放真正必须匿名的：健康检查、登录、网关对外调用面。
 * 新增任何 `/api` 路由都默认需要登录，写操作默认需要管理员。
 */
const PUBLIC_RULES: Rule[] = [
  { match: (n) => n.path === '/api/health', public: true, label: 'health' },
  { match: (n) => n.path === '/api/auth/login', public: true, label: 'login' },
  { match: (n) => pathStartsWith(n.path, '/gw/'), public: true, label: 'gateway(自带 x-api-key 校验)' },
];

/** 必须管理员的路由（高风险动作：密钥、平台、端点、工具目录、LLM 配置、账号） */
const ADMIN_RULES: Rule[] = [
  { match: (n) => pathStartsWith(n.path, '/api/secrets'), admin: true, label: 'secrets' },
  { match: (n) => pathStartsWith(n.path, '/api/platforms'), admin: true, label: 'platforms' },
  { match: (n) => pathStartsWith(n.path, '/api/endpoints'), admin: true, label: 'endpoints' },
  { match: (n) => pathStartsWith(n.path, '/api/tools'), admin: true, label: 'tools' },
  { match: (n) => pathStartsWith(n.path, '/api/settings'), admin: true, label: 'settings' },
  { match: (n) => pathStartsWith(n.path, '/api/accounts'), admin: true, label: 'accounts' },
  { match: (n) => pathStartsWith(n.path, '/api/update'), admin: true, label: 'update' },
  { match: (n) => pathStartsWith(n.path, '/api/import'), admin: true, label: 'import' },
  { match: (n) => pathStartsWith(n.path, '/api/audit'), admin: true, label: 'audit' },
  { match: (n) => pathStartsWith(n.path, '/api/stats'), admin: true, label: 'stats' },
];

/** 需要登录即可（不属于高危写面，也不需要管理员） */
const MEMBER_RULES: Rule[] = [
  { match: (n) => pathStartsWith(n.path, '/api/chat'), admin: false, label: 'chat' },
  { match: (n) => pathStartsWith(n.path, '/api/api-keys'), admin: false, label: 'api-keys' },
  { match: (n) => pathStartsWith(n.path, '/api/auth'), admin: false, label: 'auth' },
];

export type AccessDecision =
  | { kind: 'public'; rule: string }
  | { kind: 'admin'; rule: string }
  | { kind: 'member'; rule: string }
  | { kind: 'deny'; reason: string };

/**
 * 决定一个已规范化的路径需要什么级别的鉴权。
 *
 * 注意：这里只回答"要什么级别"，是否满足由调用方结合身份判断。
 */
export function decideAccess(n: NormalizedPath): AccessDecision {
  for (const r of PUBLIC_RULES) {
    if (r.match(n)) return { kind: 'public', rule: r.label ?? 'public' };
  }
  // `/api/*` 之外的一切（静态资源、SPA 回退、`/`）都走公开分支：
  // 它们不返回任何服务端数据，由后面的静态处理器决定。
  if (!pathStartsWith(n.path, '/api')) return { kind: 'public', rule: 'non-api' };

  for (const r of ADMIN_RULES) {
    if (r.match(n)) return { kind: 'admin', rule: r.label ?? 'admin' };
  }
  for (const r of MEMBER_RULES) {
    if (r.match(n)) return { kind: 'member', rule: r.label ?? 'member' };
  }

  // 默认拒绝：`/api` 下任何没登记的路径都要求管理员，避免新路由裸奔
  return { kind: 'admin', rule: 'default-deny' };
}

export function actorOf(account: AccountRecord | null, keyId?: string | null, adminToken = false): string {
  if (adminToken) return 'admin-token';
  if (account) return `account:${account.id}`;
  if (keyId) return `key:${keyId}`;
  return 'anonymous';
}

/** 允许公网/IP 直连时额外信任的本机来源（用于本机运维脚本） */
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

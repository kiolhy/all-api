/**
 * 请求身份读取工具。
 *
 * 服务端路由里判断"谁在调用"必须走这一层，而不是各写各的：
 *   - app.ts 的 preHandler 会把 AuthContext 挂到 req.auth / req.account 上
 *   - 网关路由（/gw/*）不在账号鉴权作用域内，所以这里还要能主动解析会话
 */

import type { FastifyRequest } from 'fastify';
import { resolveSession } from '@aah/core';
import type { AccountRecord } from '@aah/core';
import { bearerToken } from './auth.ts';

export type AuthenticatedRequest = FastifyRequest & {
  account?: AccountRecord | null;
  auth?: { account: AccountRecord | null; actor: string; admin: boolean };
};

/** 取当前登录账号（优先用 preHandler 挂上的，没有再自行解析一次） */
export function accountOf(req: FastifyRequest): AccountRecord | null {
  const r = req as AuthenticatedRequest;
  if (r.account) return r.account;
  if (r.auth?.account) return r.auth.account;
  return resolveSession(bearerToken(req));
}

/** 是否管理员会话 */
export function isAdminRequest(req: FastifyRequest): boolean {
  const acc = accountOf(req);
  return Boolean(acc && acc.role === 'admin');
}

/** 审计用的主体标识 */
export function actorOfRequest(req: FastifyRequest): string {
  const r = req as AuthenticatedRequest;
  if (r.auth?.actor) return r.auth.actor;
  const acc = accountOf(req);
  return acc ? `account:${acc.id}` : 'anonymous';
}

import { hubError } from '../invoke/guard.ts';
import { accounts, apiKeys, publicAccount, sessions, type AccountRow } from '../db/repos.ts';
import type { AccountRecord, Role } from '../schema/asset.ts';
import { hashPassword, hashToken, newSessionToken, passwordProblem, verifyPassword } from './password.ts';

/** 会话有效期：7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LoginResult = { token: string; account: AccountRecord; expiresAt: string };

/**
 * 首次启动播种管理员账号。
 * 用户名/密码取自 ADMIN_USERNAME / ADMIN_PASSWORD，缺省 admin / admin123456。
 * 已有账号时什么都不做。
 */
export function seedAdminAccount(): { created: boolean; username: string; usedDefaultPassword: boolean } {
  if (accounts.count() > 0) {
    return { created: false, username: '', usedDefaultPassword: false };
  }
  const username = (process.env.ADMIN_USERNAME ?? 'admin').trim() || 'admin';
  const envPassword = process.env.ADMIN_PASSWORD;
  const usedDefaultPassword = !envPassword;
  const password = envPassword ?? 'admin123456';
  accounts.create(username, hashPassword(password), 'admin');
  return { created: true, username, usedDefaultPassword };
}

export function login(username: string, password: string): LoginResult {
  const acc = accounts.byUsername(username.trim());
  // 统一错误文案，避免暴露"用户名是否存在"
  const fail = () => hubError('login_failed', '用户名或密码不正确', 401);
  if (!acc) throw fail();
  if (!acc.enabled) throw hubError('account_disabled', '该账号已被停用', 403);
  if (!verifyPassword(password, acc.passwordHash)) throw fail();

  const token = newSessionToken();
  sessions.create(hashToken(token), acc.id, SESSION_TTL_MS);
  accounts.touchLogin(acc.id);
  const fresh = accounts.get(acc.id)!;
  return {
    token,
    account: fresh,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
}

export function logout(token: string): void {
  sessions.remove(hashToken(token));
}

export function resolveSession(token: string): AccountRecord | null {
  if (!token) return null;
  return sessions.resolve(hashToken(token));
}

export function changePassword(accountId: string, oldPassword: string, newPassword: string): void {
  const row = accounts.get(accountId);
  if (!row) throw hubError('not_found', '账号不存在', 404);
  const full = accounts.byUsername(row.username) as AccountRow | null;
  if (!full) throw hubError('not_found', '账号不存在', 404);
  if (!verifyPassword(oldPassword, full.passwordHash)) {
    throw hubError('bad_password', '原密码不正确', 400);
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw hubError('weak_password', problem, 400);
  accounts.setPassword(accountId, hashPassword(newPassword));
  // 改密后踢掉其它会话，但保留当前这条由调用方重新登录
  sessions.removeByAccount(accountId);
}

export function createAccount(username: string, password: string, role: Role): AccountRecord {
  if (accounts.byUsername(username)) {
    throw hubError('username_taken', '用户名已存在', 409);
  }
  const problem = passwordProblem(password);
  if (problem) throw hubError('weak_password', problem, 400);
  return accounts.create(username, hashPassword(password), role);
}

export function resetAccountPassword(accountId: string, newPassword: string): void {
  const problem = passwordProblem(newPassword);
  if (problem) throw hubError('weak_password', problem, 400);
  if (!accounts.get(accountId)) throw hubError('not_found', '账号不存在', 404);
  accounts.setPassword(accountId, hashPassword(newPassword));
  sessions.removeByAccount(accountId);
}

export function setAccountEnabled(accountId: string, enabled: boolean): AccountRecord {
  const acc = accounts.get(accountId);
  if (!acc) throw hubError('not_found', '账号不存在', 404);
  if (!enabled && acc.role === 'admin' && accounts.adminCount() <= 1) {
    throw hubError('last_admin', '至少要保留一个启用的管理员', 400);
  }
  accounts.setEnabled(accountId, enabled);
  if (!enabled) sessions.removeByAccount(accountId);
  return accounts.get(accountId)!;
}

export function removeAccount(accountId: string, currentId: string): void {
  const acc = accounts.get(accountId);
  if (!acc) throw hubError('not_found', '账号不存在', 404);
  if (accountId === currentId) throw hubError('self_delete', '不能删除当前登录的账号', 400);
  if (acc.role === 'admin' && accounts.adminCount() <= 1) {
    throw hubError('last_admin', '至少要保留一个启用的管理员', 400);
  }
  sessions.removeByAccount(accountId);
  // 连带吊销该账号名下的令牌，避免留下无主凭证
  apiKeys.removeByAccount(accountId);
  accounts.remove(accountId);
}

export { publicAccount };

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountInputSchema,
  ChangePasswordInputSchema,
  LoginInputSchema,
  type AccountRecord,
} from '@aah/core';
import {
  accounts,
  changePassword,
  createAccount,
  login,
  logout,
  removeAccount,
  resetAccountPassword,
  resolveSession,
  setAccountEnabled,
} from '@aah/core';

/** 从 Authorization: Bearer xxx 或 x-session-token 取会话令牌 */
export function bearerToken(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const alt = req.headers['x-session-token'];
  return typeof alt === 'string' ? alt.trim() : '';
}

function currentAccount(req: FastifyRequest): AccountRecord | null {
  const fromReq = (req as FastifyRequest & { account?: AccountRecord | null }).account;
  if (fromReq) return fromReq;
  return resolveSession(bearerToken(req));
}

function requireAdmin(req: FastifyRequest): AccountRecord {
  const acc = currentAccount(req);
  if (!acc) throw Object.assign(new Error('未登录'), { statusCode: 401, code: 'unauthorized' });
  if (acc.role !== 'admin') {
    throw Object.assign(new Error('需要管理员权限'), { statusCode: 403, code: 'forbidden' });
  }
  return acc;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  /* ── 登录 / 登出 / 当前身份 ── */

  app.post('/api/auth/login', async (req) => {
    const parsed = LoginInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw Object.assign(new Error('请填写用户名和密码'), { statusCode: 400, code: 'bad_request' });
    }
    const result = login(parsed.data.username, parsed.data.password);
    return { token: result.token, account: result.account, expiresAt: result.expiresAt };
  });

  app.post('/api/auth/logout', async (req) => {
    logout(bearerToken(req));
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const acc = currentAccount(req);
    if (!acc) {
      throw Object.assign(new Error('未登录'), { statusCode: 401, code: 'unauthorized' });
    }
    return { account: acc };
  });

  app.post('/api/auth/change-password', async (req) => {
    const acc = currentAccount(req);
    if (!acc) throw Object.assign(new Error('未登录'), { statusCode: 401, code: 'unauthorized' });
    const parsed = ChangePasswordInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.issues[0]?.message ?? '参数不合法'), {
        statusCode: 400,
        code: 'bad_request',
      });
    }
    changePassword(acc.id, parsed.data.oldPassword, parsed.data.newPassword);
    return { ok: true, relogin: true };
  });

  /* ── 账号管理（仅管理员） ── */

  app.get('/api/accounts', async (req) => {
    requireAdmin(req);
    return accounts.list();
  });

  app.post('/api/accounts', async (req) => {
    requireAdmin(req);
    const parsed = AccountInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.issues[0]?.message ?? '参数不合法'), {
        statusCode: 400,
        code: 'bad_request',
      });
    }
    return createAccount(parsed.data.username, parsed.data.password, parsed.data.role);
  });

  app.post('/api/accounts/:id/password', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as { password?: string };
    if (!body?.password) {
      throw Object.assign(new Error('缺少新密码'), { statusCode: 400, code: 'bad_request' });
    }
    resetAccountPassword(id, body.password);
    return { ok: true };
  });

  app.patch('/api/accounts/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as { enabled?: boolean; role?: 'admin' | 'member' };
    if (typeof body?.enabled === 'boolean') return setAccountEnabled(id, body.enabled);
    if (body?.role === 'admin' || body?.role === 'member') {
      accounts.setRole(id, body.role);
      return accounts.get(id);
    }
    throw Object.assign(new Error('没有可更新的字段'), { statusCode: 400, code: 'bad_request' });
  });

  app.delete('/api/accounts/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = req.params as { id: string };
    removeAccount(id, me.id);
    return { ok: true };
  });
}

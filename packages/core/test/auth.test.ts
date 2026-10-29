import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { resetDbForTests, closeDb, getDb } = await import('../src/db/client.ts');
const { accounts, sessions } = await import('../src/db/repos.ts');
const {
  seedAdminAccount,
  login,
  logout,
  resolveSession,
  changePassword,
  createAccount,
  setAccountEnabled,
  removeAccount,
} = await import('../src/auth/service.ts');
const { hashPassword, verifyPassword, passwordProblem, hashToken } = await import('../src/auth/password.ts');

before(() => {
  resetDbForTests();
});

after(() => {
  closeDb();
});

test('密码哈希可校验且不可逆', () => {
  const h = hashPassword('secret123');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('secret123', h), true);
  assert.equal(verifyPassword('secret124', h), false);
  assert.equal(h.includes('secret123'), false);
  // 同一密码两次哈希不同（随机盐）
  assert.notEqual(h, hashPassword('secret123'));
});

test('弱密码被拒', () => {
  assert.ok(passwordProblem('123'));
  assert.ok(passwordProblem('1234567890'));
  assert.equal(passwordProblem('abc12345'), null);
});

test('首次播种管理员，且只播种一次', () => {
  const first = seedAdminAccount();
  assert.equal(first.created, true);
  assert.equal(first.username, 'admin');
  const second = seedAdminAccount();
  assert.equal(second.created, false);
  assert.equal(accounts.count(), 1);
});

test('登录成功返回会话令牌，错误密码被拒', () => {
  const result = login('admin', 'admin123456');
  assert.match(result.token, /^sess_/);
  assert.equal(result.account.username, 'admin');
  assert.equal(result.account.role, 'admin');

  assert.throws(() => login('admin', 'wrong'), /用户名或密码不正确/);
  assert.throws(() => login('nobody', 'admin123456'), /用户名或密码不正确/);
});

test('会话可解析、登出后失效', () => {
  const { token } = login('admin', 'admin123456');
  const acc = resolveSession(token);
  assert.equal(acc?.username, 'admin');
  logout(token);
  assert.equal(resolveSession(token), null);
});

test('停用账号后会话立即失效且无法登录', () => {
  const created = createAccount('temp1', 'pass1234', 'member');
  const { token } = login('temp1', 'pass1234');
  assert.ok(resolveSession(token));

  setAccountEnabled(created.id, false);
  assert.equal(resolveSession(token), null, '停用后旧会话应失效');
  assert.throws(() => login('temp1', 'pass1234'), /已被停用/);
});

test('改密后旧密码失效', () => {
  const created = createAccount('temp2', 'pass1234', 'member');
  changePassword(created.id, 'pass1234', 'newpass99');
  assert.throws(() => login('temp2', 'pass1234'), /用户名或密码不正确/);
  const ok = login('temp2', 'newpass99');
  assert.equal(ok.account.username, 'temp2');
});

test('不能删除最后一个管理员', () => {
  const admin = accounts.byUsername('admin')!;
  assert.throws(() => removeAccount(admin.id, 'other'), /至少要保留一个启用的管理员/);
});

test('不能删除当前登录账号', () => {
  const created = createAccount('temp3', 'pass1234', 'admin');
  assert.throws(() => removeAccount(created.id, created.id), /不能删除当前登录的账号/);
});

test('用户名重复被拒', () => {
  createAccount('dup', 'pass1234', 'member');
  assert.throws(() => createAccount('dup', 'pass1234', 'member'), /用户名已存在/);
});

test('过期会话被清理', () => {
  const { token } = login('admin', 'admin123456');
  // 直接把过期时间改到过去
  const db = getDb();
  db.prepare('update session set expires_at=? where token_hash=?').run(
    new Date(Date.now() - 1000).toISOString(),
    hashToken(token),
  );
  assert.equal(resolveSession(token), null);
  sessions.purgeExpired();
  const left = db.prepare('select count(*) as c from session where token_hash=?').get(hashToken(token)) as {
    c: number;
  };
  assert.equal(Number(left.c), 0);
});

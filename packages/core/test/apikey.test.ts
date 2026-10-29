import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { resetDbForTests, closeDb, getDb } = await import('../src/db/client.ts');
const { apiKeys, apiKeyProblem, accounts } = await import('../src/db/repos.ts');
const { createAccount, removeAccount } = await import('../src/auth/service.ts');
const { hashPassword } = await import('../src/auth/password.ts');

function makeKey(
  over: {
    accountId?: string | null;
    expiresAt?: string | null;
    quotaLimit?: number;
    quotaPeriod?: 'total' | 'daily' | 'monthly';
  } = {},
): string {
  return apiKeys.create({
    label: 'test',
    prefix: 'hub_live_test',
    keyHash: `hash_${Math.random().toString(36).slice(2)}`,
    scopes: {},
    accountId: over.accountId ?? null,
    expiresAt: over.expiresAt ?? null,
    quotaLimit: over.quotaLimit ?? 0,
    quotaPeriod: over.quotaPeriod ?? 'total',
  });
}

before(() => {
  resetDbForTests();
});

after(() => {
  closeDb();
});

test('新令牌默认不限额度、不过期', () => {
  const id = makeKey();
  const key = apiKeys.get(id)!;
  assert.equal(key.quotaLimit, 0);
  assert.equal(key.quotaUsed, 0);
  assert.equal(key.expiresAt, null);
  assert.equal(key.quotaPeriod, 'total');
  assert.equal(apiKeyProblem(key), null);
});

test('禁用后不可用', () => {
  const id = makeKey();
  apiKeys.setEnabled(id, false);
  const problem = apiKeyProblem(apiKeys.get(id)!);
  assert.equal(problem?.code, 'invalid_key');
});

test('过期后不可用', () => {
  const id = makeKey({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const problem = apiKeyProblem(apiKeys.get(id)!);
  assert.equal(problem?.code, 'key_expired');
});

test('额度用尽后不可用，调用会累加', () => {
  const id = makeKey({ quotaLimit: 2 });
  assert.equal(apiKeyProblem(apiKeys.get(id)!), null);

  apiKeys.recordCall(id);
  assert.equal(apiKeys.get(id)!.quotaUsed, 1);
  assert.equal(apiKeyProblem(apiKeys.get(id)!), null);

  apiKeys.recordCall(id);
  assert.equal(apiKeys.get(id)!.quotaUsed, 2);
  const problem = apiKeyProblem(apiKeys.get(id)!);
  assert.equal(problem?.code, 'quota_exceeded');
  assert.match(problem!.message, /2\/2/);
});

test('调用次数与额度分开统计', () => {
  const id = makeKey({ quotaLimit: 100 });
  apiKeys.recordCall(id);
  apiKeys.recordCall(id);
  apiKeys.recordCall(id);
  const key = apiKeys.get(id)!;
  assert.equal(key.callCount, 3);
  assert.equal(key.quotaUsed, 3);
});

test('手动重置额度', () => {
  const id = makeKey({ quotaLimit: 1 });
  apiKeys.recordCall(id);
  assert.equal(apiKeyProblem(apiKeys.get(id)!)?.code, 'quota_exceeded');
  apiKeys.resetQuota(id);
  assert.equal(apiKeys.get(id)!.quotaUsed, 0);
  assert.equal(apiKeyProblem(apiKeys.get(id)!), null);
});

test('周期额度到点自动清零', () => {
  const id = makeKey({ quotaLimit: 1, quotaPeriod: 'daily' });
  apiKeys.recordCall(id);
  assert.equal(apiKeyProblem(apiKeys.get(id)!)?.code, 'quota_exceeded');

  // 把重置时间改到过去，模拟跨天
  getDb()
    .prepare('update api_key set quota_reset_at=? where id=?')
    .run(new Date(Date.now() - 1000).toISOString(), id);

  apiKeys.rollQuotaIfDue(id);
  assert.equal(apiKeys.get(id)!.quotaUsed, 0, '跨周期后已用额度应清零');
  assert.equal(apiKeyProblem(apiKeys.get(id)!), null);
});

test('令牌按账号隔离', () => {
  const a = accounts.create('owner_a', hashPassword('pass1234'), 'member');
  const b = accounts.create('owner_b', hashPassword('pass1234'), 'member');
  makeKey({ accountId: a.id });
  makeKey({ accountId: a.id });
  makeKey({ accountId: b.id });

  assert.equal(apiKeys.listByAccount(a.id).length, 2);
  assert.equal(apiKeys.listByAccount(b.id).length, 1);
  assert.equal(apiKeys.countByAccount(a.id), 2);
});

test('删除账号连带吊销其名下令牌', () => {
  const c = accounts.create('owner_c', hashPassword('pass1234'), 'member');
  const keyId = makeKey({ accountId: c.id });
  assert.ok(apiKeys.get(keyId));

  removeAccount(c.id, 'someone-else');
  assert.equal(apiKeys.get(keyId), null, '账号删除后令牌应一并清除');
});

test('更新令牌字段', () => {
  const id = makeKey();
  apiKeys.update(id, { label: '改名', quotaLimit: 50, quotaPeriod: 'monthly', notes: '备注' });
  const key = apiKeys.get(id)!;
  assert.equal(key.label, '改名');
  assert.equal(key.quotaLimit, 50);
  assert.equal(key.quotaPeriod, 'monthly');
  assert.equal(key.notes, '备注');
  assert.ok(key.quotaResetAt, '月周期应算出下次重置时间');
});

test('切换为 total 周期时清掉重置时间', () => {
  const id = makeKey({ quotaPeriod: 'daily' });
  apiKeys.update(id, { quotaPeriod: 'total' });
  assert.equal(apiKeys.get(id)!.quotaResetAt, null);
});

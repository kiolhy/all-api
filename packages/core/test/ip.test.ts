import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ipAllowed, ipAllowlistProblem } = await import('../src/invoke/ip.ts');
const { resolveToolName, toolName } = await import('../src/tools/compile.ts');

/* ───────────── IP 白名单 ───────────── */

test('空白名单不限制', () => {
  assert.equal(ipAllowed('8.8.8.8', []), true);
  assert.equal(ipAllowed('8.8.8.8', undefined), true);
  assert.equal(ipAllowed('8.8.8.8', null), true);
});

test('星号放行全部', () => {
  assert.equal(ipAllowed('1.2.3.4', ['*']), true);
});

test('精确 IP 匹配', () => {
  const list = ['1.2.3.4', '10.0.0.1'];
  assert.equal(ipAllowed('1.2.3.4', list), true);
  assert.equal(ipAllowed('10.0.0.1', list), true);
  assert.equal(ipAllowed('1.2.3.5', list), false);
});

test('CIDR 网段匹配', () => {
  assert.equal(ipAllowed('192.168.1.55', ['192.168.1.0/24']), true);
  assert.equal(ipAllowed('192.168.2.55', ['192.168.1.0/24']), false);
  assert.equal(ipAllowed('10.20.30.40', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.20.30.40', ['10.0.0.0/8']), false);
  assert.equal(ipAllowed('172.16.5.5', ['172.16.0.0/12']), true);
  assert.equal(ipAllowed('172.32.5.5', ['172.16.0.0/12']), false);
});

test('/32 等价于单 IP', () => {
  assert.equal(ipAllowed('1.2.3.4', ['1.2.3.4/32']), true);
  assert.equal(ipAllowed('1.2.3.5', ['1.2.3.4/32']), false);
});

test('通配符匹配', () => {
  assert.equal(ipAllowed('10.0.0.7', ['10.0.0.*']), true);
  assert.equal(ipAllowed('10.0.1.7', ['10.0.0.*']), false);
  assert.equal(ipAllowed('10.9.8.7', ['10.*.*.*']), true);
});

test('IPv4-mapped IPv6 归一化', () => {
  assert.equal(ipAllowed('::ffff:1.2.3.4', ['1.2.3.4']), true);
  assert.equal(ipAllowed('::ffff:192.168.1.9', ['192.168.1.0/24']), true);
});

test('带端口的来源 IP 也能匹配', () => {
  assert.equal(ipAllowed('1.2.3.4:5678', ['1.2.3.4']), true);
});

test('IPv6 精确匹配', () => {
  assert.equal(ipAllowed('::1', ['::1']), true);
  assert.equal(ipAllowed('::2', ['::1']), false);
});

test('空白名单条目被忽略', () => {
  assert.equal(ipAllowed('1.2.3.4', ['  ', '1.2.3.4']), true);
});

test('白名单条目格式校验', () => {
  assert.equal(ipAllowlistProblem('1.2.3.4'), null);
  assert.equal(ipAllowlistProblem('10.0.0.0/8'), null);
  assert.equal(ipAllowlistProblem('10.0.0.*'), null);
  assert.equal(ipAllowlistProblem('*'), null);
  assert.equal(ipAllowlistProblem('::1'), null);
  assert.ok(ipAllowlistProblem('1.2.3'));
  assert.ok(ipAllowlistProblem('999.1.1.1'));
  assert.ok(ipAllowlistProblem('10.0.0.0/99'));
  assert.ok(ipAllowlistProblem(''));
});

/* ───────────── 对外工具名 ───────────── */

function fakeEndpoint(over: Record<string, unknown> = {}) {
  return {
    platformSlug: 'demo',
    slug: 'get_api_v1_users_user_id',
    pathTemplate: '/api/v1/users/{userId}',
    publicName: '',
    ...over,
  } as never;
}

test('没配对外名时用中性前缀，不带上游 host', () => {
  // platformSlug 是 host 推导出来的（demo / x127_8899），不能进对外工具名
  assert.equal(resolveToolName(fakeEndpoint()), 'api__get_api_v1_users_user_id');
});

test('平台名像域名/IP 时不进工具名', () => {
  for (const host of ['127.0.0.1:8899', 'api.github.com', 'http://x.io', 'example.org', '8899']) {
    const name = resolveToolName(fakeEndpoint(), { platformName: host });
    assert.ok(name.startsWith('api__'), `${host} → ${name}`);
    assert.ok(!name.includes('127'), name);
    assert.ok(!name.includes('github'), name);
  }
});

test('平台名是人起的就用它', () => {
  const name = resolveToolName(fakeEndpoint(), { platformName: 'orders' });
  assert.equal(name, 'orders__get_api_v1_users_user_id');
});

test('配了对外名就用它，与上游路径无关', () => {
  assert.equal(resolveToolName(fakeEndpoint({ publicName: 'query_user' })), 'query_user');
});

test('对外名首尾空白被忽略', () => {
  assert.equal(resolveToolName(fakeEndpoint({ publicName: '  query_user  ' })), 'query_user');
});

test('对外名不包含上游域名或路径痕迹', () => {
  const name = resolveToolName(fakeEndpoint({ publicName: 'query_user' }));
  assert.ok(!name.includes('api'));
  assert.ok(!name.includes('demo'));
  assert.ok(!name.includes('__'));
});

test('传统 toolName 仍可用', () => {
  assert.equal(toolName('demo', 'get_user'), 'demo__get_user');
});

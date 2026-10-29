import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl, tokenizeCurl, looksLikeCurl } from '../src/import/curl.ts';

test('tokenize 处理引号与转义', () => {
  const tokens = tokenizeCurl(`curl -X POST 'https://a.com/x' -H "Content-Type: application/json" -d '{"a":1}'`);
  assert.deepEqual(tokens, [
    'curl',
    '-X',
    'POST',
    'https://a.com/x',
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"a":1}',
  ]);
});

test('解析基础 GET + query', () => {
  const specs = parseCurl(`curl 'https://api.demo.com/v1/orders?limit=10&status=paid' -H 'Accept: application/json'`);
  assert.equal(specs.length, 1);
  const s = specs[0]!;
  assert.equal(s.method, 'GET');
  assert.equal(s.url, 'https://api.demo.com/v1/orders');
  assert.deepEqual(s.query, { limit: '10', status: 'paid' });
  assert.equal(s.headers['Accept'], 'application/json');
});

test('反斜杠续行 + Bearer 头 + JSON body', () => {
  const raw = `curl -X POST https://api.demo.com/v1/messages \\
  -H 'Authorization: Bearer sk-live-abcdef1234567890' \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"hi","channel":"web"}'`;
  const specs = parseCurl(raw);
  assert.equal(specs.length, 1);
  const s = specs[0]!;
  assert.equal(s.method, 'POST');
  assert.equal(s.headers['Authorization'], 'Bearer sk-live-abcdef1234567890');
  assert.match(s.bodyRaw ?? '', /"content":"hi"/);
  assert.match(s.bodyContentType ?? '', /application\/json/);
});

test('多条 curl 切块', () => {
  const raw = [
    `curl 'https://api.demo.com/v1/a'`,
    `curl -X POST 'https://api.demo.com/v1/b' -d 'x=1'`,
  ].join('\n');
  const specs = parseCurl(raw);
  assert.equal(specs.length, 2);
  assert.equal(specs[1]!.method, 'POST');
});

test('-u 转 Basic 头，-b 转 Cookie', () => {
  const specs = parseCurl(`curl -u user:pass -b 'sid=abc' https://api.demo.com/v1/me`);
  const s = specs[0]!;
  assert.equal(s.headers['Authorization'], `Basic ${Buffer.from('user:pass').toString('base64')}`);
  assert.equal(s.headers['Cookie'], 'sid=abc');
});

test('-F 生成 multipart', () => {
  const specs = parseCurl(`curl -X POST https://api.demo.com/upload -F 'file=@/tmp/a.png' -F 'name=demo'`);
  const s = specs[0]!;
  assert.match(s.bodyContentType ?? '', /multipart\/form-data/);
  assert.match(s.bodyRaw ?? '', /name="name"/);
  assert.match(s.bodyRaw ?? '', /<FILE:/);
});

test('looksLikeCurl', () => {
  assert.equal(looksLikeCurl('curl https://a.com'), true);
  assert.equal(looksLikeCurl('{"openapi":"3.0.0"}'), false);
});

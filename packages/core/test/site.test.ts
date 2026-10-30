// 测试用假上游在本机回环：显式打开私网出网开关（生产默认关闭）
process.env.ALLOW_PRIVATE_EGRESS = 'true';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { extractTitle, extractIcon, fetchSiteInfo, hostToName } from '../src/import/site.ts';
import { siteKeyFromUrl, platformSlugFromHost } from '../src/import/normalize.ts';

test('站点标识：端口不同就是不同站点', () => {
  assert.equal(siteKeyFromUrl(new URL('http://127.0.0.1:8899/x')), 'x127_8899');
  assert.equal(siteKeyFromUrl(new URL('http://127.0.0.1:8898/x')), 'x127_8898');
  assert.notEqual(
    siteKeyFromUrl(new URL('http://127.0.0.1:8899/x')),
    siteKeyFromUrl(new URL('http://127.0.0.1:8898/x')),
    '同 host 不同端口不能并成一个站点',
  );
});

test('站点标识：标准端口不写进 slug', () => {
  assert.equal(siteKeyFromUrl(new URL('https://api.github.com/repos')), 'github');
  assert.equal(siteKeyFromUrl(new URL('http://example.com:80/a')), 'example');
  assert.equal(siteKeyFromUrl(new URL('https://example.com:443/a')), 'example');
});

test('站点标识：同 host 同端口稳定归一', () => {
  const a = siteKeyFromUrl(new URL('https://api.github.com/a'));
  const b = siteKeyFromUrl(new URL('https://www.github.com/b'));
  assert.equal(a, b);
  assert.equal(a, platformSlugFromHost('api.github.com'));
});

test('提取 title 并解码实体', () => {
  assert.equal(extractTitle('<html><head><title>订单系统</title></head></html>'), '订单系统');
  assert.equal(extractTitle('<title>  A &amp; B  </title>'), 'A & B');
  assert.equal(extractTitle('<title>多行\n标题</title>'), '多行 标题');
  assert.equal(extractTitle('<title></title>'), '');
  assert.equal(extractTitle('<html>没有标题</html>'), '');
});

test('提取 title 有长度上限，不吞掉整个文档', () => {
  const long = 'A'.repeat(500);
  const out = extractTitle(`<title>${long}</title>`);
  assert.ok(out.length <= 120, `应截断，实际 ${out.length}`);
});

test('提取 favicon', () => {
  assert.equal(extractIcon('<link rel="icon" href="/fav.ico">'), '/fav.ico');
  assert.equal(extractIcon('<link rel="shortcut icon" href="/s.ico">'), '/s.ico');
  assert.equal(extractIcon('<link href="/x.ico" rel="icon">'), '/x.ico');
  assert.equal(extractIcon('<html></html>'), '');
});

test('hostToName 保留非标准端口', () => {
  assert.equal(hostToName('http://127.0.0.1:8898'), '127:8898');
  assert.equal(hostToName('https://api.github.com'), 'github');
  assert.equal(hostToName('https://example.com:443'), 'example');
});

/* ────────── 真实抓取 ────────── */

let srv: Server;
let port = 0;

async function listen(html: string, opts: { status?: number; ct?: string } = {}): Promise<void> {
  srv = createServer((_req, res) => {
    res.writeHead(opts.status ?? 200, { 'Content-Type': opts.ct ?? 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}

async function close(): Promise<void> {
  if (srv) await new Promise<void>((r) => srv.close(() => r()));
}

test('fetchSiteInfo：抓到标题和图标', async () => {
  await listen(
    '<html><head><title>商品中心 API</title><link rel="icon" href="/f.ico"></head><body></body></html>',
  );
  const info = await fetchSiteInfo(`http://127.0.0.1:${port}`, true);
  await close();
  assert.equal(info.title, '商品中心 API');
  assert.equal(info.icon, '/f.ico');
  assert.equal(info.error, undefined);
});

test('fetchSiteInfo：非 HTML 首页不报错，返回说明', async () => {
  await listen('{"ok":true}', { ct: 'application/json' });
  const info = await fetchSiteInfo(`http://127.0.0.1:${port}`, true);
  await close();
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /不是 HTML/);
});

test('fetchSiteInfo：404 不抛异常', async () => {
  await listen('nope', { status: 404 });
  const info = await fetchSiteInfo(`http://127.0.0.1:${port}`, true);
  await close();
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /404/);
});

test('fetchSiteInfo：连不上不抛异常', async () => {
  const info = await fetchSiteInfo('http://127.0.0.1:1');
  assert.equal(info.title, '');
  assert.ok(info.error, '应带失败原因');
});

test('fetchSiteInfo：非法 baseUrl 不抛异常', async () => {
  const info = await fetchSiteInfo('not-a-url');
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /不是合法地址/);
});

test('fetchSiteInfo：没有 title 时保留 icon', async () => {
  await listen('<html><head><link rel="icon" href="/only.ico"></head></html>');
  const info = await fetchSiteInfo(`http://127.0.0.1:${port}`, true);
  await close();
  assert.equal(info.title, '');
  assert.equal(info.icon, '/only.ico');
  assert.match(info.error ?? '', /没有 <title>/);
});

/* ────────── 跳转 ────────── */

let hopServer: Server;
let hopPort = 0;

/** 起一个会按路径返回不同响应的服务器 */
async function listenRoutes(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
): Promise<void> {
  hopServer = createServer((req, res) => handler(req.url ?? '/', res));
  await new Promise<void>((r) => hopServer.listen(0, '127.0.0.1', r));
  const addr = hopServer.address();
  hopPort = typeof addr === 'object' && addr ? addr.port : 0;
}

async function closeHop(): Promise<void> {
  if (hopServer) await new Promise<void>((r) => hopServer.close(() => r()));
}

test('fetchSiteInfo：跟随同站跳转（相对路径）', async () => {
  await listenRoutes((url, res) => {
    if (url === '/') {
      res.writeHead(301, { Location: '/home' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>跳转后的站点</title></head></html>');
  });
  const info = await fetchSiteInfo(`http://127.0.0.1:${hopPort}`, true);
  await closeHop();
  assert.equal(info.title, '跳转后的站点');
  assert.equal(info.error, undefined);
});

test('fetchSiteInfo：跟随同站绝对地址跳转', async () => {
  await listenRoutes((url, res) => {
    if (url === '/') {
      res.writeHead(302, { Location: `http://127.0.0.1:${hopPort}/real` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>绝对跳转</title>');
  });
  const info = await fetchSiteInfo(`http://127.0.0.1:${hopPort}`, true);
  await closeHop();
  assert.equal(info.title, '绝对跳转');
});

test('fetchSiteInfo：不跟随到其他域', async () => {
  await listenRoutes((_url, res) => {
    res.writeHead(302, { Location: 'http://evil.example.com/steal' });
    res.end();
  });
  const info = await fetchSiteInfo(`http://127.0.0.1:${hopPort}`, true);
  await closeHop();
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /其他域/);
});

test('fetchSiteInfo：跳转次数过多会停', async () => {
  let n = 0;
  await listenRoutes((_url, res) => {
    n += 1;
    res.writeHead(302, { Location: `/hop${n}` });
    res.end();
  });
  const info = await fetchSiteInfo(`http://127.0.0.1:${hopPort}`, true);
  await closeHop();
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /跳转次数过多/);
});

/**
 * 站点信息抓取
 *
 * 整理接口时，用户往往只给了 curl，平台名字是域名推出来的（比如 `api`、`demo`），
 * 对人没意义。这里去抓一次站点首页，拿到 `<title>` 和 favicon，用作平台名。
 *
 * 安全约束：
 * - 只抓 baseUrl 的根路径，不跟随到别的域
 * - 5 秒超时，64KB 上限
 * - 失败静默降级（抓不到就用域名）
 * - **走受控出网**：私网/回环/元数据地址一律拒绝。
 *   真实事故：导入时对 curl 里的 `http://127.0.0.1:8778/...` 自动建平台并抓标题，
 *   等于「整理接口」这个动作本身就是一次 SSRF。现在这里会直接拒绝私网目标，
 *   由调用方降级成用域名当名字。
 */

import { safeFetch } from '../security/safe-fetch.ts';
import { loadConfig } from '../config.ts';

export type SiteInfo = {
  /** 站点标题，如「订单管理系统」 */
  title: string;
  /** favicon 地址（相对或绝对） */
  icon: string;
  /** 抓取失败原因 */
  error?: string;
};

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

/** 从 HTML 里抽 <title>，做基本实体解码 */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!m) return '';
  return decodeEntities(m[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 从 HTML 里抽 favicon（link rel=icon / shortcut icon / apple-touch-icon） */
export function extractIcon(html: string): string {
  const patterns = [
    /<link[^>]+rel=["']?(?:shortcut\s+)?icon["']?[^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']?(?:shortcut\s+)?icon["']?/i,
    /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1].trim().slice(0, 500);
  }
  return '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_all, d: string) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/**
 * 抓站点首页拿标题。
 * 永不抛异常：失败就返回空标题 + error 说明。
 *
 * @param allowPrivate 仅当平台已被服务端策略授权访问私网时才为 true。
 *   默认 false —— 也就是说 `curl http://127.0.0.1:8778/...` 不会再触发抓取。
 */
export async function fetchSiteInfo(baseUrl: string, allowPrivate = false): Promise<SiteInfo> {
  let start: URL;
  try {
    start = new URL(baseUrl);
  } catch {
    return { title: '', icon: '', error: 'baseUrl 不是合法地址' };
  }

  const cfg = loadConfig();
  try {
    // 最多跟 2 跳，且只跟同站（含 http→https、www 变体），不跟到别的域
    let url = new URL(start.origin + '/');
    for (let hop = 0; hop <= 2; hop++) {
      const res = await safeFetch(url, {
        method: 'GET',
        // 自己处理跳转：每一跳都要重新过地址判定，不能交给客户端自动跟
        allowPrivate: allowPrivate && cfg.allowPrivateEgress,
        allowHosts: [url.hostname],
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        headers: {
          // 有些站点对非浏览器 UA 直接返回 403
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const locRaw = res.headers['location'];
        const loc = Array.isArray(locRaw) ? locRaw[0] : locRaw;
        if (!loc) return { title: '', icon: '', error: `站点返回 ${res.status}` };
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          return { title: '', icon: '', error: `站点返回了无法解析的跳转：${loc.slice(0, 120)}` };
        }
        if (!sameSite(start, next)) {
          return {
            title: '',
            icon: '',
            error: `站点跳转到其他域 ${next.host}，未跟随`,
          };
        }
        url = next;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        return { title: '', icon: '', error: `站点返回 ${res.status}` };
      }

      const ctRaw = res.headers['content-type'];
      const ct = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? '';
      if (!/text\/html|application\/xhtml/i.test(ct)) {
        return { title: '', icon: '', error: `首页不是 HTML（${ct.split(';')[0] || '未知'}）` };
      }

      const html = res.text;
      const title = extractTitle(html);
      const icon = extractIcon(html);

      if (!title) return { title: '', icon, error: '首页没有 <title>' };
      return { title, icon };
    }
    return { title: '', icon: '', error: '跳转次数过多' };
  } catch (err) {
    const e = err as Error & { code?: string };
    // 出网被拒（私网/白名单）是预期结果，不是"抓取失败"，措辞要能看出来
    if (e.code === 'egress_private_blocked') {
      return { title: '', icon: '', error: '目标解析到内网地址，已拒绝抓取' };
    }
    if (e.code === 'egress_host_blocked') {
      return { title: '', icon: '', error: '目标主机不在出网白名单内' };
    }
    const msg = e.message;
    return { title: '', icon: '', error: msg.includes('timeout') ? '抓取超时' : msg };
  }
}

/** 同站判断：host 相同，或只是 www./api. 之类前缀差异，或 http→https */
function sameSite(a: URL, b: URL): boolean {
  const norm = (h: string): string =>
    h
      .toLowerCase()
      .split('.')
      .filter((x) => x && x !== 'www')
      .join('.');
  return norm(a.hostname) === norm(b.hostname);
}

/** 从域名推一个好认的备用名字（保留端口，端口不同才是不同服务） */
export function hostToName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    const parts = host.split('.').filter(Boolean);
    // api.example.com → example
    const meaningful = parts.filter((p) => !['api', 'www', 'open', 'gateway', 'gw', 'admin'].includes(p));
    const name = meaningful[0] ?? parts[0] ?? host;
    const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
    return name + port;
  } catch {
    return baseUrl;
  }
}

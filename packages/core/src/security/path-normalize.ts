/**
 * 请求路径规范化（鉴权的地基）
 *
 * 背景：Fastify 的路由层（find-my-way）在匹配前会把 `%61` 解码成 `a`，
 * 而鉴权如果直接拿 `req.url`（未解码的原始字符串）做前缀判断，
 * `/%61pi/settings` 就会既绕过 `/api/` 前缀鉴权、又命中真实的 `/api/settings` 路由。
 *
 * 结论：**任何基于路径的安全判断，都必须作用在「解码后的规范化路径」上**。
 * 这里提供的 normalizeRequestPath 就是那个唯一入口：
 *   1. 取 pathname（去掉 query / fragment）→ 只解码一次（与路由层语义一致）
 *   2. 折叠重复斜杠、去掉 `;param` 路径参数、处理 `.` / `..`
 *   3. 解码后仍含危险字符（控制字符、反斜杠、`?`、`#`、再编码的 `%XX`）→ 视为异常
 *   4. 小写归一（行业惯例：路由大小写不敏感，宁可多拦不可漏拦）
 *
 * 任何一步不干净都返回 ok=false，调用方应当直接拒绝请求（400），
 * 而不是"猜一个路径继续鉴权"。
 */

export type NormalizedPath =
  | { ok: true; path: string; hadEncoding: boolean }
  | { ok: false; reason: string; path: string };

function rawPathname(rawUrl: string): string {
  // 只取 pathname：`?` 和 `#` 之后都不是路径
  const q = rawUrl.indexOf('?');
  const h = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  const path = rawUrl.slice(0, end);
  return path.startsWith('/') ? path : `/${path}`;
}

/** 折叠 `//`、处理 `.` 与 `..`、去掉 `;param` */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    // 矩阵参数 `;jsessionid=...` 不属于路径语义，统一剥离
    const semi = seg.indexOf(';');
    const clean = semi >= 0 ? seg.slice(0, semi) : seg;
    if (clean === '' || clean === '.') continue;
    if (clean === '..') {
      out.pop();
      continue;
    }
    out.push(clean);
  }
  return `/${out.join('/')}`;
}

/** 规范化失败时也要给一个安全的落回值，方便日志/报错 */
export function normalizeRequestPath(rawUrl: string): NormalizedPath {
  const raw = rawPathname(rawUrl);

  if (raw.includes('\\')) return { ok: false, reason: '路径包含反斜杠', path: raw };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: '路径包含控制字符', path: raw };

  const hadEncoding = raw.includes('%');
  // 编码后的路径分隔符（%2f / %5c）会让"解码前几段、解码后几段"不一致，
  // 路由层和鉴权层很容易在这里分叉。直接拒绝，不做猜测。
  if (/%2f|%5c/i.test(raw)) {
    return { ok: false, reason: '路径包含编码的分隔符', path: raw };
  }
  let decoded: string;
  try {
    // 只解码一次，和路由层保持一致；多重编码会在下面被判定为异常
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: '路径不是合法的百分号编码', path: raw };
  }

  if (decoded.includes('\0')) return { ok: false, reason: '路径包含空字节', path: raw };
  if (decoded.includes('\\')) return { ok: false, reason: '路径包含反斜杠', path: raw };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return { ok: false, reason: '路径包含控制字符', path: raw };
  // 解码后仍然有 %XX → 多重编码，路由层不会期望这种路径
  if (/%[0-9a-fA-F]{2}/.test(decoded)) return { ok: false, reason: '路径存在多重百分号编码', path: raw };
  // 解码后出现的 `?` `#` `/` 会改变路由匹配语义（如 `%2f` 变成路径分隔符）
  if (decoded.includes('?') || decoded.includes('#')) {
    return { ok: false, reason: '路径解码后包含分隔符', path: raw };
  }
  if (!decoded.startsWith('/')) return { ok: false, reason: '路径不是绝对路径', path: raw };

  const normalized = normalizeSegments(decoded);
  return { ok: true, path: normalized.toLowerCase(), hadEncoding };
}

/**
 * 判断两个路径段是否相等（大小写不敏感，便于测试与断言复用）
 */
export function pathStartsWith(path: string, prefix: string): boolean {
  const p = path.toLowerCase();
  const pre = prefix.toLowerCase();
  if (p === pre) return true;
  return p.startsWith(pre.endsWith('/') ? pre : `${pre}/`);
}

import type { EndpointRecord } from '../schema/asset.ts';

export type EndpointParam = EndpointRecord['params'][number];

const VERB_BY_METHOD: Record<string, string> = {
  GET: '查询',
  HEAD: '检查',
  POST: '创建',
  PUT: '更新',
  PATCH: '更新',
  DELETE: '删除',
};

/**
 * 这段文字里是否带着上游路径。
 *
 * `GET /api/v1/orders`、`https://x.com/v2/y` 这类东西一旦进了 title/description，
 * 就等于把上游接口结构直接递给调用方 —— 网关掩了域名也白掩。
 */
export function looksLikeUpstreamPath(text: string | null | undefined): boolean {
  const s = (text ?? '').trim();
  if (!s) return false;
  return (
    /^[A-Z]{3,7}\s+\//.test(s) || // GET /api/v1/orders
    /\/api\//i.test(s) ||
    /\/v\d+\//i.test(s) ||
    /^https?:\/\//i.test(s) ||
    /^\/[a-z0-9{}:_-]+(\/[a-z0-9{}:_-]+)+$/i.test(s) // 裸路径 /users/{id}
  );
}

/**
 * 方法 + 路径 → 一句人话，**不带路径**。
 *
 * 这是对外文案的地基：没有 AI 也要让调用方知道「这个工具干什么」，
 * 但不能顺手把 `GET /api/v1/orders` 抄进去。
 */
export function semanticLabel(method: string, pathTemplate: string): string {
  const m = (method || 'GET').toUpperCase();
  const verb = VERB_BY_METHOD[m] ?? m;
  const segs = (pathTemplate || '').split('/').filter(Boolean);

  const isParamSeg = (s: string) => /^\{[^}]+\}$/.test(s) || /^:[A-Za-z_]\w*$/.test(s);
  const lastSeg = segs[segs.length - 1] ?? '';
  const endsWithParam = isParamSeg(lastSeg);

  // 资源名：倒着找第一个既不是参数、也不是版本号的段
  const resource = [...segs].reverse().find((s) => !isParamSeg(s) && !/^v\d+$/i.test(s));

  if (!resource) return `${verb}接口`;
  if (m === 'GET' || m === 'HEAD') {
    // 只有「末尾是参数」才算查详情；/users/{id}/orders 仍然是查列表
    return endsWithParam ? `按 ID 查询 ${resource} 详情` : `${verb} ${resource} 列表`;
  }
  return `${verb} ${resource}`;
}

/**
 * 对外文本清洗：空的、或者写着上游路径的，一律换成兜底说法。
 */
export function sanitizePublicText(text: string | null | undefined, fallback: string): string {
  const s = (text ?? '').trim();
  if (!s) return fallback;
  if (looksLikeUpstreamPath(s)) return fallback;
  return s;
}

/** 把 `（GET /api/v1/orders）` 这种括号补丁抠掉，其余内容保留 */
export function stripPathParenthetical(text: string | null | undefined): string {
  const s = (text ?? '').trim();
  if (!s) return '';
  return s
    .replace(/[（(][^）)]*\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\s+\/[^）)]*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const NAME_HINTS: Array<[RegExp, string]> = [
  [/^(page|page_?num|pageno|page_?index|page_?no)$/i, '页码，从 1 开始'],
  [/^(per_?page|page_?size|limit|size|count|take|rows|max_?results)$/i, '每页返回条数'],
  [/^(offset|skip|start_?index|from_?index)$/i, '跳过的条数，用于分页'],
  [/^(cursor|after|before|next_?token|page_?token)$/i, '分页游标，取上一页返回的值'],
  [/^(q|query|keyword|keywords|search|term|kw)$/i, '搜索关键词'],
  [/^(sort|sort_?by|order_?by|orderby)$/i, '排序字段'],
  [/^(order|direction|asc|desc|ascending|descending|reverse)$/i, '排序方向'],
  [/^(id|uuid|guid|key|code)$/i, '唯一标识'],
  [/^.*(_id|_key|_code)$/i, '唯一标识'],
  [/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)*I[dD]$/, '唯一标识'], // userId / orderId
  [/^(name|title|label|nickname)$/i, '名称'],
  [/^(email|mail|e_?mail)$/i, '邮箱地址'],
  [/^(phone|mobile|tel|telephone|phone_?number)$/i, '手机号'],
  [/^(url|link|href|callback_?url|webhook|redirect_?url|endpoint)$/i, '链接地址，需完整 URL'],
  [/^(status|state)$/i, '状态值'],
  [/^(type|kind|category|mode)$/i, '类型'],
  [/^(from|start|start_?at|start_?date|start_?time|since|begin|date_?from)$/i, '起始时间'],
  [/^(to|end|end_?at|end_?date|end_?time|until|date_?to)$/i, '结束时间'],
  [/^(date|day|datetime|timestamp|time)$/i, '日期 / 时间'],
  [/^(lang|locale|language|region)$/i, '语言 / 地区代码'],
  [/^(timezone|tz|utc_?offset)$/i, '时区'],
  [/^(amount|price|total|fee|cost|money)$/i, '金额'],
  [/^(quantity|qty|num|number|total_?count)$/i, '数量'],
  [/^(enabled|active|disabled|is_.+|has_.+|with_.+)$/i, '开关，true / false'],
  [/^(content|body|payload|data|text|message|remark|note|notes|comment)$/i, '内容正文'],
  [/^(tags?|labels?)$/i, '标签，可多个'],
];

const IN_HINT: Record<string, string> = {
  path: '路径参数',
  query: '查询参数',
  body: '请求体字段',
  header: '请求头',
  cookie: 'Cookie',
};

/**
 * 参数说明兜底。
 *
 * AI 开着时 `applyParamHints` 会用模型给的中文说明覆盖这里；
 * AI 关着时至少让调用方知道 `page` 是页码而不是「查询参数 page」。
 */
export function paramHint(param: EndpointParam): string {
  const name = (param.name ?? '').trim();
  const enumPart =
    param.type === 'enum' && param.enum?.length ? `，可选：${param.enum.slice(0, 8).join(' / ')}` : '';

  for (const [re, hint] of NAME_HINTS) {
    if (re.test(name)) return `${hint}${enumPart}`;
  }

  const where = IN_HINT[param.in] ?? '参数';
  return `${where}${enumPart}`;
}

/** 示例值按声明类型纠正：`page` 声明是 number，示例就不该是字符串 "1" */
export function coerceExample(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'number' || type === 'integer') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  if (typeof value === 'object') return undefined;
  return value;
}

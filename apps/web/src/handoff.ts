import type { Tool } from './types.ts';

/* ────────────────────────── 工具 schema ────────────────────────── */

type PropSchema = {
  type?: string;
  description?: string;
  examples?: unknown[];
  enum?: unknown[];
  default?: unknown;
};

type ObjectSchema = { properties?: Record<string, PropSchema>; required?: string[] };

export function schemaOf(tool: Tool): ObjectSchema {
  return (tool.inputSchema ?? {}) as ObjectSchema;
}

/** 按 schema 造一份能直接跑的示例参数 */
export function exampleArgs(tool: Tool): Record<string, unknown> {
  const props = schemaOf(tool).properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (Array.isArray(prop.enum) && prop.enum.length) {
      out[key] = prop.enum[0];
      continue;
    }
    if (Array.isArray(prop.examples) && prop.examples.length) {
      out[key] = prop.examples[0];
      continue;
    }
    const type = String(prop.type ?? 'string');
    out[key] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : `<${key}>`;
  }
  return out;
}

/**
 * 工具的介绍看起来像上游路径吗？
 *
 * 没开 AI 分析时标题会回退成 `GET /api/v1/orders` 这种，
 * 交给别的 AI 就等于把原始接口递出去了。
 */
export function looksLikeUpstreamPath(text: string): boolean {
  if (!text) return false;
  return /\/api\//.test(text) || /^[A-Z]{3,7}\s+\//.test(text) || /\/v\d+\//.test(text);
}

/* ────────────────────────── 错误码 ────────────────────────── */

export const ERROR_ROWS: Array<{ code: string; status: string; desc: string }> = [
  { code: 'unauthorized', status: '401', desc: '没带 x-api-key' },
  { code: 'invalid_key', status: '401', desc: '令牌不存在或已删除' },
  { code: 'key_expired', status: '403', desc: '令牌已过期' },
  { code: 'forbidden', status: '403', desc: 'IP 不在白名单内' },
  { code: 'scope_forbidden', status: '403', desc: '令牌无权调用该工具' },
  { code: 'endpoint_closed', status: '403', desc: '该接口未对外开放' },
  { code: 'tool_not_found', status: '404', desc: '工具名不存在' },
  { code: 'tool_disabled', status: '409', desc: '工具已被禁用' },
  { code: 'missing_arg', status: '400', desc: '缺少必填参数' },
  { code: 'invalid_arg', status: '400', desc: '参数类型或枚举值不对' },
  { code: 'unknown_arg', status: '400', desc: '传了未声明的参数' },
  { code: 'quota_exceeded', status: '429', desc: '超出令牌配额' },
  { code: 'rate_limited', status: '429', desc: '触发 QPS 限流' },
  { code: 'upstream_error', status: '502', desc: '上游返回错误' },
  { code: 'circuit_open', status: '503', desc: '上游熔断中，稍后重试' },
];

/* ────────────────────────── 接入包 ────────────────────────── */

export type PackOptions = {
  baseUrl: string;
  key: string;
  tools: Tool[];
  includeErrors: boolean;
  /** 默认 false：标题/介绍里像上游路径的一律剔除，避免把原始接口递给对方 */
  includeLeakyMeta?: boolean;
};

/**
 * 生成一段可以直接贴给别的 AI 的接入说明。
 *
 * 目标是「粘贴即用」：地址、鉴权、工具清单、参数、示例、返回格式都在里面，
 * 对方不需要再问、也不需要自己爬接口。
 */
export function buildHandoffPack(opts: PackOptions): string {
  const { baseUrl, key, tools, includeErrors, includeLeakyMeta = false } = opts;
  const k = key.trim() || '<把令牌粘这里>';
  const L: string[] = [];

  L.push('# 接口网关接入说明');
  L.push('');
  L.push('你可以通过下面这个网关调用一组第三方接口。网关负责鉴权和上游地址，');
  L.push('你只需要知道**工具名**和**参数**，不需要关心上游域名或路径。');
  L.push('');
  L.push('## 连接信息');
  L.push('');
  L.push(`- 网关地址：\`${baseUrl}\``);
  L.push(`- 鉴权请求头：\`x-api-key: ${k}\``);
  L.push('- 每个请求都要带这个头，否则返回 401');
  L.push('');
  L.push('## 调用方式');
  L.push('');
  L.push('### 方式一：按工具名调用（推荐）');
  L.push('');
  L.push('```bash');
  L.push(`curl -X POST ${baseUrl}/gw/v1/call \\`);
  L.push(`  -H 'x-api-key: ${k}' \\`);
  L.push(`  -H 'content-type: application/json' \\`);
  L.push(`  -d '{"tool":"<工具名>","args":{"参数名":"参数值"}}'`);
  L.push('```');
  L.push('');
  L.push('### 方式二：直连路径');
  L.push('');
  L.push('```bash');
  L.push(`curl '${baseUrl}/gw/v1/<工具名>?参数名=参数值' \\`);
  L.push(`  -H 'x-api-key: ${k}'`);
  L.push('```');
  L.push('');
  L.push('### 方式三：自己拉工具清单');
  L.push('');
  L.push('```bash');
  L.push(`curl ${baseUrl}/gw/v1/tools -H 'x-api-key: ${k}'`);
  L.push('```');
  L.push('');
  L.push('## 返回格式');
  L.push('');
  L.push('```json');
  L.push('{');
  L.push('  "ok": true,');
  L.push('  "status": 200,');
  L.push('  "data": { },');
  L.push('  "meta": { "requestId": "rq_xxx", "latencyMs": 42, "cached": false }');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('失败时 `ok` 为 `false`，错误在 `data.error`：');
  L.push('');
  L.push('```json');
  L.push(
    '{ "ok": false, "status": 400, "data": { "error": { "code": "missing_arg", "message": "缺少参数 page" } } }',
  );
  L.push('```');
  L.push('');

  L.push(`## 可用工具（${tools.length} 个）`);
  L.push('');
  if (tools.length === 0) {
    L.push('_当前没有已发布的工具。_');
    L.push('');
  }
  tools.forEach((tool, i) => {
    const props = schemaOf(tool).properties ?? {};
    const required = new Set(schemaOf(tool).required ?? []);

    // 像上游路径的标题/介绍默认不带出去 —— 网关掩了地址，别在元数据这漏了
    const title = includeLeakyMeta || !looksLikeUpstreamPath(tool.title) ? tool.title : '';
    const desc = includeLeakyMeta || !looksLikeUpstreamPath(tool.description) ? tool.description : '';

    L.push(`### ${i + 1}. \`${tool.name}\``);
    L.push('');
    if (title) L.push(`- 标题：${title}`);
    if (desc) L.push(`- 说明：${desc.replace(/\n+/g, ' ')}`);
    if (!title && !desc) L.push('- 说明：_（未填写对外介绍，按工具名和参数使用）_');
    L.push(`- 类型：${tool.annotations?.readOnly ? '只读（不会改动数据）' : '写入（会改动数据）'}`);

    const names = Object.keys(props);
    if (names.length === 0) {
      L.push('- 参数：无');
    } else {
      L.push('- 参数：');
      for (const name of names) {
        const p = props[name]!;
        const bits = [`\`${name}\``, `(${p.type ?? 'string'}${required.has(name) ? '，必填' : '，可选'})`];
        if (p.description) bits.push(`— ${p.description}`);
        else if (Array.isArray(p.enum) && p.enum.length) bits.push(`— 可选值：${p.enum.join(' / ')}`);
        L.push(`  - ${bits.join(' ')}`);
      }
    }

    L.push('- 调用示例：');
    L.push('');
    L.push('```bash');
    L.push(`curl -X POST ${baseUrl}/gw/v1/call \\`);
    L.push(`  -H 'x-api-key: ${k}' -H 'content-type: application/json' \\`);
    L.push(`  -d '${JSON.stringify({ tool: tool.name, args: exampleArgs(tool) })}'`);
    L.push('```');
    L.push('');
  });

  if (includeErrors) {
    L.push('## 常见错误码');
    L.push('');
    L.push('| code | HTTP | 含义 |');
    L.push('| --- | --- | --- |');
    for (const row of ERROR_ROWS) L.push(`| \`${row.code}\` | ${row.status} | ${row.desc} |`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('提示：如果你的 IP 会变，或者令牌设了 IP 白名单，调用可能被 403 拒绝 ——');
  L.push('这时请联系令牌的签发者调整白名单。');
  L.push('');

  return L.join('\n');
}

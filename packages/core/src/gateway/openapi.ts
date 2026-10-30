import type { EndpointRecord, PlatformRecord, ToolRecord } from '../schema/asset.ts';
import { paramHint } from '../tools/describe.ts';

/** 由 catalog 生成对外 OpenAPI 3.1 描述 */
export function buildOpenApiDoc(opts: {
  tools: ToolRecord[];
  platforms: PlatformRecord[];
  endpointById: Map<string, EndpointRecord>;
  serverUrl: string;
}): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const tool of opts.tools) {
    const ep = opts.endpointById.get(tool.endpointId);
    if (!ep) continue;
    // 对外只暴露工具名，不带平台/上游路径结构
    const path = `/gw/v1/${tool.name}`;
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of ep.params) {
      if (p.secretRef) continue;
      if (p.in === 'path' || p.in === 'query') {
        props[p.name] = { type: p.type === 'integer' ? 'integer' : p.type === 'number' ? 'number' : 'string' };
        (props[p.name] as Record<string, unknown>).description = p.description?.trim() || paramHint(p);
        if (p.required) required.push(p.name);
      }
    }

    paths[path] = {
      get: {
        operationId: tool.name,
        // 用工具标题，不要 ep.summary —— 那是上游原文（`GET /api/v1/orders`）
        summary: tool.title || tool.name,
        description: tool.description,
        parameters: Object.entries(props).map(([name, schema]) => ({
          name,
          in: (ep.params.find((p) => p.name === name)?.in ?? 'query') as string,
          required: required.includes(name),
          schema,
        })),
        responses: {
          '200': { description: '上游返回（原样透传；仅在接口上配了 redactFields 时才打码）' },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API Gateway',
      version: '0.3.0',
      description: '统一接口转发网关。上游域名与密钥不外泄，所有调用需 x-api-key。',
    },
    servers: [{ url: opts.serverUrl }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
    security: [{ apiKey: [] }],
    paths,
  };
}

/** 给模型看的纯文本清单 */
export function buildLlmsTxt(tools: ToolRecord[], serverUrl: string): string {
  const lines: string[] = [
    '# API Asset Hub — 可用工具清单',
    '',
    `网关地址：${serverUrl}`,
    '调用方式：POST /gw/v1/call  body: {"tool":"<name>","args":{...}}  头：x-api-key',
    '',
  ];
  for (const t of tools) {
    lines.push(`## ${t.name}`);
    if (t.title) lines.push(`标题：${t.title}`);
    lines.push(`说明：${t.description.replace(/\n/g, ' ')}`);
    lines.push(`入参：${JSON.stringify(t.inputSchema)}`);
    lines.push('');
  }
  return lines.join('\n');
}

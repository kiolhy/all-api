#!/usr/bin/env node
/**
 * API Asset Hub — MCP Server
 * 把中枢里已发布的接口以 MCP 工具形式暴露给任意 MCP 客户端（DSH / Claude Desktop / Codex 等）。
 *
 * 环境变量：
 *   GATEWAY_URL   网关地址，默认 http://127.0.0.1:8778
 *   HUB_API_KEY   在控制台生成的 API Key（hub_live_xxx）
 *   MCP_TOOL_MODE auto | direct | catalog   默认 auto
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const GATEWAY = (process.env.GATEWAY_URL ?? process.env.HUB_BASE_URL ?? 'http://127.0.0.1:8778').replace(/\/$/, '');
const API_KEY = process.env.HUB_API_KEY ?? '';
const MODE = process.env.MCP_TOOL_MODE ?? 'auto';
const DIRECT_LIMIT = 20;

type RemoteTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean };
};

let cache: { at: number; tools: RemoteTool[] } = { at: 0, tools: [] };

async function fetchTools(force = false): Promise<RemoteTool[]> {
  if (!force && Date.now() - cache.at < 15_000 && cache.tools.length) return cache.tools;
  const res = await fetch(`${GATEWAY}/gw/v1/tools`, {
    headers: API_KEY ? { 'x-api-key': API_KEY } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`获取工具列表失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const tools = (await res.json()) as RemoteTool[];
  cache = { at: Date.now(), tools };
  return tools;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${GATEWAY}/gw/v1/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({ tool: name, args }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  const doc = parsed as { ok?: boolean; data?: unknown; meta?: unknown; error?: unknown };
  if (!res.ok || doc?.ok === false) {
    return {
      text: JSON.stringify({ ok: false, status: res.status, error: doc?.error ?? parsed }, null, 2),
      isError: true,
    };
  }
  return {
    text: JSON.stringify({ ok: true, data: doc?.data ?? parsed, meta: doc?.meta }, null, 2),
    isError: false,
  };
}

const CATALOG_TOOLS: RemoteTool[] = [
  {
    name: 'catalog_search',
    title: '搜索接口资产',
    description: '按关键词搜索可用接口（名称、描述、平台）。返回匹配的工具名与摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如 用户、订单、天气' },
        limit: { type: 'number', description: '最多返回条数，默认 10' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'catalog_describe',
    title: '查看接口详情',
    description: '查看某个工具的完整说明与入参 JSON Schema。',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: '工具名' } },
      required: ['tool'],
      additionalProperties: false,
    },
  },
  {
    name: 'catalog_call',
    title: '调用接口',
    description: '调用指定工具取数据。args 必须符合该工具的入参 schema。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名' },
        args: { type: 'object', description: '调用参数' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  },
];

function toMcpTool(t: RemoteTool) {
  return {
    name: t.name,
    description: [t.title, t.description].filter(Boolean).join(' — ').slice(0, 1000),
    inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
    annotations: {
      readOnlyHint: t.annotations?.readOnly ?? true,
      destructiveHint: t.annotations?.destructive ?? false,
      idempotentHint: t.annotations?.idempotent ?? true,
    },
  };
}

const server = new Server(
  { name: 'api-asset-hub', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await fetchTools();
  const useDirect = MODE === 'direct' || (MODE === 'auto' && tools.length <= DIRECT_LIMIT);
  const list = useDirect ? tools.map(toMcpTool) : CATALOG_TOOLS.map(toMcpTool);
  return { tools: list };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (name === 'catalog_search') {
      const q = String(args.query ?? '').toLowerCase();
      const limit = Number(args.limit ?? 10);
      const tools = await fetchTools(true);
      const hits = tools
        .filter((t) =>
          `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(q),
        )
        .slice(0, limit)
        .map((t) => ({ tool: t.name, title: t.title, description: (t.description ?? '').slice(0, 200) }));
      return { content: [{ type: 'text', text: JSON.stringify({ count: hits.length, hits }, null, 2) }] };
    }

    if (name === 'catalog_describe') {
      const tools = await fetchTools(true);
      const t = tools.find((x) => x.name === String(args.tool ?? ''));
      if (!t) return { content: [{ type: 'text', text: `未找到工具 ${String(args.tool ?? '')}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(t, null, 2) }] };
    }

    if (name === 'catalog_call') {
      const target = String(args.tool ?? '');
      const callArgs = (args.args ?? {}) as Record<string, unknown>;
      const r = await callTool(target, callArgs);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError };
    }

    const r = await callTool(name, args);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `调用失败：${(err as Error).message}` }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const tools = await fetchTools();
  return {
    resources: tools.map((t) => ({
      uri: `hub://tool/${t.name}`,
      name: t.name,
      title: t.title ?? t.name,
      mimeType: 'application/json',
      description: (t.description ?? '').slice(0, 300),
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  const name = uri.replace(/^hub:\/\/tool\//, '');
  const tools = await fetchTools();
  const t = tools.find((x) => x.name === name);
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(t ?? { error: `未找到 ${name}` }, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

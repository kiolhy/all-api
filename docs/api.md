# REST 契约（控制台 + 网关）

> 前端只需依赖本文档。所有响应均为 JSON，错误统一 `{ error: { code, message } }`。

## 鉴权

| 通道 | 头 | 说明 |
|---|---|---|
| 控制台 API `/api/**` | `x-admin-token: <ADMIN_TOKEN>` | 单机自用口令，前端存 localStorage |
| 对外网关 `/gw/**` | `x-api-key: <key>` | 在控制台「API Key」页生成，形如 `hub_live_xxx` |

## 通用

- `GET /api/health` → `{ ok: true, version, llm: { enabled, model } }`
- `GET /api/stats` → `{ platforms, endpoints, published, tools, calls: { total, ok, failed, today, avgLatency } }`

## 平台

```
GET    /api/platforms                       → Platform[]
POST   /api/platforms        {slug,name,baseUrl,authKind,authConfig,defaultHeaders,egressAllowHosts,rateLimit,allowPrivate,notes}
GET    /api/platforms/:id                    → Platform
PATCH  /api/platforms/:id    (部分字段)
DELETE /api/platforms/:id
POST   /api/platforms/:id/test               → { ok, status, latencyMs, sample }
```

`Platform` 字段：`id, slug, name, baseUrl, authKind('none'|'bearer'|'header'|'query'|'basic'), authConfig, defaultHeaders, egressAllowHosts, rateLimit{qps,daily}, allowPrivate, notes, createdAt, updatedAt`

## 接口资产

```
GET    /api/endpoints?platformId=&status=&q=   → Endpoint[]
POST   /api/endpoints        { platformId, ...EndpointInput }
GET    /api/endpoints/:id                      → Endpoint
PUT    /api/endpoints/:id    { ...EndpointInput }
DELETE /api/endpoints/:id
POST   /api/endpoints/:id/publish  { note? }   → Endpoint（version+1，写不可变快照）
POST   /api/endpoints/:id/archive
POST   /api/endpoints/:id/test     { args }    → { ok, status, latencyMs, data, upstreamHost }
```

`Endpoint` = `EndpointInput` + `id, platformId, platformSlug, status('draft'|'published'|'archived'), version, contentHash, sourceKind, sourceRef, createdAt, updatedAt`

`EndpointInput`：
```ts
{
  slug, group, method, pathTemplate,
  summary, description,
  params: Array<{ name, in:'path'|'query'|'header'|'body'|'cookie', type, required, description, default?, enum?, example?, pattern?, secretRef? }>,
  body: null | { contentType, encoding:'json'|'form'|'multipart'|'raw', required, schema, example, secretRef? },
  response: { contentType, pick: string[], unwrap: string|null, transform: string|null, redactFields: string[], maxBytes },
  sideEffect:'read'|'write', sensitivity:'low'|'medium'|'high',
  tags: string[], examples: Array<{ args: object, note?: string }>, notes
}
```

## 工具（AI 侧）

```
GET   /api/tools                       → Tool[]
PATCH /api/tools/:id   { enabled?, title?, description?, cacheTtl?, namespace? }
POST  /api/tools/rebuild               → { rebuilt }   // 全量重编译 inputSchema
```

`Tool` = `id, name, namespace, title, description, inputSchema, cacheTtl, annotations{readOnly,destructive,idempotent}, enabled, platformSlug, endpointSlug, endpointId, createdAt, updatedAt`

## 一键整理

```
POST /api/import   { text, kind?, platformSlug?, useAi?, autoPublish?, probeUpstream?, maxProbes?, wait? }
     → 默认 { jobId, status:'queued' }        （异步，立即返回）
     → wait:true 时 { jobId, status, stats:{...}, error? }（同步，等跑完）
GET  /api/import/stream                 → text/event-stream（SSE，任务进度推送）
GET  /api/import/jobs                  → Job[]
GET  /api/import/jobs/:id              → { job, candidates: Candidate[] }
DEL  /api/import/jobs/:id              → { ok }        （运行中的任务 409）
POST /api/import/candidates/:id/accept → { endpointId }
POST /api/import/candidates/:id/reject → { ok }
POST /api/import/jobs/:id/accept-all   → { created, updated }
```

`kind`：`curl | har | openapi | text`，省略则自动识别。

`probeUpstream`（默认 `true`）：是否让探测 Agent 真实请求上游只读接口，拿到真实响应样本后再让 AI 分析。
`maxProbes`（默认 12）：单次导入最多探测几个接口。

### 发布（= 采纳候选）

**「发布」就是采纳候选**：建接口 → `publish` → 编译工具，一次完成。没有独立的发布状态机。

三个入口，语义完全一致：

| 入口 | 接口 | 说明 |
| --- | --- | --- |
| 导入页「全部采纳」 | `POST /api/import/jobs/:id/accept-all` | 采纳该任务全部待定候选 |
| 整理记录页「发布全部」 | 同上 | 后台跑完后不用回导入页 |
| 单条「发布」/「忽略」 | `POST /api/import/candidates/:id/accept\|reject` | 逐条决策 |

规则：

- `duplicate`（已存在完全相同）和 `conflict`（同路径不同定义）**不会**被 `accept-all` 采纳
- `modified` 候选会更新已有接口（`targetEndpointId`），不是新建
- 幂等：已采纳的候选再次 `accept-all` 不会重复建，返回 `created: 0`

`stats.autoPublished` 是「导入时勾了直接发布」自动发布的条数；
没勾就等用户到「整理记录」页手动发布。

### AI 备注与介绍

`notes` / `description` / `summary` 由分析 Agent 生成。LLM 未启用时：

- `stats.aiErrors` 会带一条 `LLM 未启用，跳过 AI 分析（备注和接口介绍不会生成）`
- `notes` 回退到规则文案：`查询 orders 列表（GET /api/v1/orders）` + `（规则生成，未经 AI 分析）`
- `GET /api/health` 的 `llm.enabled` 供前端提前提示

`notes` 是多行文本，前端用 `white-space: pre-line` 渲染：

```
返回订单列表数据，含订单号与金额。
返回：订单数组，按创建时间倒序
关键字段：orderId（订单号）、amount（金额）
注意：会消耗上游配额
```

### 后台执行与进度

默认异步：`POST /api/import` 立刻返回 `jobId`，流水线在后台跑。

进度**不用轮询**，订阅事件流即可：

```
GET /api/import/stream   → text/event-stream
```

帧格式（每帧 `data: <json>`）：

```
{ "type": "snapshot", "jobs": Job[] }                 // 连接建立时推一次全量
{ "type": "job", "jobId": "...", "job": Job, "isRunning": bool }   // 每完成一步推一次
```

- 服务端每完成一步就推一帧，步骤几乎即时出现
- 15 秒一次 `: ping` 心跳，防止代理掐掉空闲连接
- 客户端断开时服务端自动清理订阅和心跳
- 用 `fetch` + `ReadableStream` 读，不用 `EventSource`（后者发不了 `Authorization` 头）

> 为什么是 SSE 不是 WebSocket：这里全是服务端 → 客户端单向推送，
> WS 的双向能力用不上，还要多引一个 `ws` 依赖。SSE 走普通 HTTP、能过代理、
> 自带断线重连语义，站内对话也已经在用同一套模式。

`Job` 结构：

```
id, kind, status, stats, error, aiUsed,
steps: [{ key, label, status, detail }],
progress: 0-100, siteCount, createdAt, finishedAt, isRunning
```

`status`：`queued | running | done | failed | interrupted`

`steps` 固定 8 步，`status` 为 `pending | running | done | failed | skipped`：

| key | label |
| --- | --- |
| `detect` | 识别格式 |
| `parse` | 解析接口 |
| `site` | 识别站点 |
| `probe` | 探测上游 |
| `analyze` | AI 分析用途 |
| `naming` | AI 生成对外名 |
| `dedupe` | 去重入库 |
| `publish` | 自动发布 |

服务重启时，遗留的 `queued`/`running` 任务会被标成 `interrupted`，不会永远转圈。

### 站点自动归组

同一站点的接口自动归到一个平台下。站点标识 = host + 非标准端口：

- `api.example.com/a` 和 `www.example.com/b` → 同一个站点 `example`
- `127.0.0.1:8899` 和 `127.0.0.1:8898` → **两个**站点（端口不同就是不同服务）

`stats.sites` 返回本次涉及的站点：

```
[{ slug, name, baseUrl, count }]
```

### 站点标题自动抓取

新平台创建时会抓一次首页 `<title>`，作为平台名：

- 抓到 → `platform.name` 和 `platform.siteTitle` 都是标题
- 抓不到（非 HTML / 无 `<title>` / 超时）→ 回退到 `host:port`，不报错

老平台可手动重抓：

```
POST /api/platforms/:id/refresh-title  { applyName? }
  → { ok, title, icon, error, appliedName, renamed, platform }
```

`applyName` 省略时，只在平台名还是「占位样」（等于 slug、纯 IP、包含 slug）才覆盖，
不会冲掉手改的名字。

`stats` 结构：

```ts
{
  detected: 'curl' | 'har' | 'openapi' | 'text',
  parsed, candidates, duplicates, conflicts,
  aiUsed: boolean, aiEnriched: number, aiErrors: string[],
  platformsCreated: string[], autoPublished: number,
  agentSummary: string,              // 如「探测 3/3 成功，分析 3 个，命名 3 个」
  probe: { attempted, succeeded, failed, skipped }
}
```

`Candidate` = `{ id, jobId, platformSlug, payload: EndpointInput, diffKind:'new'|'modified'|'conflict'|'duplicate', targetEndpointId, decision:'pending'|'accept'|'reject', createdAt }`

`payload` 里的 `notes` 由分析 Agent 生成，包含业务含义、返回什么数据、关键字段、注意事项；
`publicName` 由命名 Agent 生成，与上游路径解耦。

## 密钥 / API Key

两样东西**方向相反**，别混：

| | vault 密钥 | API Key（对外令牌） |
| --- | --- | --- |
| 方向 | 出站：网关 → 上游 | 入站：调用方 → 网关 |
| 解决的问题 | 上游要给 token，但正文不能落明文 | 网关不能对所有人开放 |
| 存在哪 | AES-256-GCM 密文（主密钥 `MASTER_KEY` 或 `data/master.key`） | 只存 sha256，明文仅创建时返回一次 |
| 长相 | 接口里写 `${secret:NAME}` | `hub_live_xxx`，放请求头 `x-api-key` |
| 谁读 | 服务端自己（`makeResolver()`） | 调用方 |
| 控制什么 | 无（只是凭据） | IP 白名单、配额、过期、scopes、归属账号 |

```
调用方 ──x-api-key──▶ 网关 ──${secret:NAME} 解密──▶ 上游
```

vault 明文只在两个瞬间出现：写入时加密、出网时解密。解密后的明文会进 `plaintexts`
用于把上游响应里回显的密钥擦掉，不会漏给调用方或 LLM。

```
GET    /api/secrets                    → Array<{ name, hint, createdAt, rotatedAt }>
POST   /api/secrets   { name, value, hint? }
DELETE /api/secrets/:name
GET    /api/api-keys                   → Array<{ id, label, prefix, scopes, enabled, lastUsedAt, createdAt }>
POST   /api/api-keys  { label, scopes?, ipAllowlist?, quotaLimit?, quotaPeriod?, expiresAt? } → { id, key }   // key 只返回一次
PATCH  /api/api-keys/:id { enabled }
DELETE /api/api-keys/:id
```

## 审计 / 设置

```
GET /api/audit?limit=100&tool=          → Audit[]
GET /api/audit/stream                   → text/event-stream（实时调用流水）
GET /api/settings                       → { llm: {enabled,baseUrl,model,apiKeySet}, egress:{allowPrivate,timeoutMs,maxBytes} }
PUT /api/settings { llm?: {enabled?,baseUrl?,apiKey?,model?,timeoutMs?} }
```

`Audit` = `{ id, ts, requestId, channel, toolName, status, ok, latencyMs, upstreamHost, errorCode, reqMeta, respMeta }`

## 在线更新

只挂在 `/api` 下（走账号会话），**网关 `/gw` 碰不到** —— 不能让调用方更新网关自己。

```
GET  /api/update                        → UpdateState（只读本地，不联网，页面打开就能显示）
GET  /api/update/check?force=1          → UpdateState（git fetch + 比较，30 秒内复用结果）
POST /api/update/apply                  → ApplyResult（pull → 装依赖 → 重建前端）
```

`UpdateState` = `{ version, isGit, branch, commit, shortCommit, commitSubject, commitDate, dirty, remote, upstream, hasUpstream, behind, ahead, latestCommit, latestSubject, canUpdate, message, checkedAt }`

`ApplyResult` = `{ ok, restarted, restartRequired, before, after, steps[], message }`
，`steps[]` = `{ name, ok, detail, skipped? }`。

行为约定：

| 情况 | 结果 |
|---|---|
| 不是 git 仓库 | `isGit:false`，`canUpdate:false`，说明原因 |
| 工作区有未提交改动 | `canUpdate:false` —— 更新会覆盖本地修改，先提交或还原 |
| 远程仓库为空 | `"远程还没有 main 分支（仓库是空的？）"` |
| 远程不可达 / 凭证问题 | `message` 带首行错误，不抛 500 |
| 已是最新 | `behind:0`，`apply` 只 pull 一次就返回，不重建 |
| 有更新 | `behind:N`，`apply` 依次 pull → 必要时 `npm install` → `vite build` |

只用 `git pull --ff-only`：出现冲突时留给人处理，不产生本地合并提交。
`restartRequired:true` 表示**代码已换新但进程还在跑旧代码**，必须重启才生效。

### 实时流水

概览页用 SSE 订阅，不用轮询：

```
{ "type": "snapshot", "records": Audit[] }      // 连接建立时推最近 20 条
{ "type": "record", "record": Audit }           // 网关每次调用推一条
```

15 秒 `: ping` 心跳；断开自动清理订阅。

**工具层面的失败也留痕**：工具名写错（`tool_not_found`，404）和工具被禁用
（`tool_disabled`，409）都会写一条审计（`reqMeta.early = true`，`upstreamHost` 为空
—— 压根没出网）。以前这些直接返回、审计里什么都没有，调错了只能干瞪眼。

鉴权失败（401/403/IP 拦截/超配额）**不进审计** —— 那是访问控制拒绝，不是接口调用，
记了只会让日志被刷。

## 站内对话

```
POST /api/chat/sessions                 → { id, title }
GET  /api/chat/sessions                 → Array<{ id, title, updatedAt }>
GET  /api/chat/sessions/:id/messages    → Message[]
POST /api/chat/sessions/:id/messages    { content } → text/event-stream
DELETE /api/chat/sessions/:id
```

SSE 事件（`data: {json}\n\n`）：
```
{"type":"tool_call","tool":"xxx","args":{...}}
{"type":"tool_result","tool":"xxx","ok":true,"preview":"..."}
{"type":"delta","text":"..."}
{"type":"done","messageId":"..."}
{"type":"error","message":"..."}
```

## 对外网关

```
GET  /gw/v1/tools                      → Array<{ name, title, description, inputSchema }>
POST /gw/v1/call   { tool, args }      → { ok, data, meta:{status,latencyMs,cached} }
GET  /gw/v1/:platform/:slug?<query>    → 同上
GET  /gw/openapi.json                  → OpenAPI 3.1
GET  /gw/llms.txt                      → 纯文本工具清单
```

# 架构与数据模型

## 分层

```
apps/server ─┐
apps/mcp  ───┼──> packages/core ──> node:sqlite
apps/web  ───┘        │
                      └──> 上游 API（undici/global fetch）
```

- `packages/core` 是唯一真相源，apps 只做传输层。
- `apps/web` 不依赖 core（避免把 `node:sqlite` 打进浏览器包），类型在 `src/types.ts` 自带副本，接口契约见 `docs/api.md`。
- `apps/mcp` 不直接读库，而是通过网关 HTTP 取工具列表与调用，可指向远端网关。

## 表

| 表 | 关键列 | 说明 |
|---|---|---|
| `platform` | slug(唯一), base_url, auth_kind, auth_config, default_headers, egress_allow_hosts, rate_limit{qps,daily}, allow_private | 一个上游平台 |
| `endpoint` | platform_id, slug, grp, method, path_template, params(JSON), body(JSON), response(JSON), side_effect, sensitivity, status, version, content_hash | 接口定义，`unique(platform_id, slug)` |
| `endpoint_version` | endpoint_id, version, snapshot(JSON) | 发布即写不可变快照，AI 侧引用固定版本 |
| `tool` | endpoint_id(唯一), name(唯一), input_schema, cache_ttl, annotations, enabled | AI 侧视图，由 endpoint 编译而来 |
| `secret` | name(主键), ciphertext, hint | AES-256-GCM 密文，永不回显 |
| `api_key` | label, prefix, key_hash, scopes, enabled | 对外网关凭据，只存哈希 |
| `import_job` / `import_candidate` | kind, stats, payload, diff_kind, decision | 一键整理的批次与候选 |
| `audit_log` | ts, channel, tool_name, status, ok, latency_ms, upstream_host, req_meta, resp_meta | 追加写 |
| `chat_session` / `chat_message` | session_id, role, content, tool_calls, tool_result | 站内对话 |
| `setting` | key, value | LLM 等运行时配置（覆盖 env） |

所有 JSON 列写入前过 Zod 校验；读出时 `safeJsonParse` + 默认值兜底。

## 关键不变量

1. **明文密钥只存在于两个瞬间**：写库前加密、出网前解引用。响应、日志、审计三处都过 `scrubAll`。
2. **对外响应不含上游 host**：`meta.upstreamHost` 仅在 `channel === 'console'` 时返回，审计表仍记录真实值。
3. **参数白名单**：`buildRequest` 遇到未声明参数直接 `unknown_arg`，避免把 AI 的幻觉参数打到上游。
4. **发布才可调用**：非 `published` 的接口只能通过控制台试运行（`channel='console'`）。
5. **版本快照**：`endpoint_version.snapshot` 不可变；上游文档变更不会悄悄改变已有工具的语义。

## 一次调用的完整链路

```
tool.name
  → tools.byName
  → endpoints.bySlug(platform, slug)
  → 限流 / 熔断检查
  → 缓存（仅 read + cacheTtl>0）
  → buildRequest：参数校验 → 路径编码 → query → header(密钥注入) → body 组装
  → guard：assertSafePath + assertEgressAllowed（host 白名单 + 私网策略）
  → fetch（timeout, redirect: manual）
  → readCapped（maxBytes）
  → shapeResponse（unwrap → transform → pick）
  → redactPaths → redactByKeyName → scrubAll(密钥明文)
  → audit.append
  → { ok, status, data, meta }
```

## 一键整理：后台执行与站点归组

### 为什么是后台任务

探测上游 + 多次 LLM 调用动辄几十秒，不能占着 HTTP 请求。
所以 `POST /api/import` 只建任务就返回 `jobId`，流水线在后台跑，逐步把状态写进 `import_job`：

```
POST /api/import
  → import_job（status=queued, steps=8 步全 pending）
  → 立即返回 { jobId }              ← 通常 30-120ms
  → 后台 void runImport({ jobId })  ← 不 await
       每完成一步：importJobs.setStep(jobId, key, {status, detail})
  → 前端轮询 GET /api/import/jobs/:id 读 progress / steps
```

关键点：

- **切页面、刷新、关控制台都不影响后台** —— 任务状态全在 SQLite，不在内存
- 内存里只留「正在跑」的句柄（`apps/server/src/import-runner.ts`），用于阻止删除运行中的任务
- 服务重启时 `recoverInterruptedJobs()` 把遗留的 `queued`/`running` 标成 `interrupted`，
  否则前端会永远转圈
- 前端把当前 jobId 存在 localStorage，离开页面再回来能接着看进度

八个步骤：`detect → parse → site → probe → analyze → naming → dedupe → publish`

失败时把当前 `running` 和所有 `pending` 步骤标成 `failed` 并写入错误信息，
一眼能看出断在哪一步。

### 进度推送：SSE，不是 WebSocket

进度走 `GET /api/import/stream` 的 SSE 长连接，**前端不再轮询**：

```
importJobs.setStep(...)  →  emitJob(jobId)  →  EventEmitter  →  所有 SSE 连接
```

- `startBackgroundImport` 把 `runImport` 的 `onStep` 接到广播上，每完成一步推一帧
- 连接建立时先推一次全量快照，前端打开即渲染，不用等第一个事件
- 15 秒心跳 `: ping`；客户端断开时清掉订阅和定时器
- 两个页面（导入、整理记录）各自订阅，共享同一条广播源

**为什么不上 WebSocket：**

| | SSE | WebSocket |
| --- | --- | --- |
| 方向 | 单向（正好够用） | 双向（用不上） |
| 依赖 | 0（原生 `fetch` 流） | 需要 `ws` / `@fastify/websocket` |
| 代理 | 普通 HTTP，能过 | 需要 Upgrade 支持 |
| 项目内一致性 | 对话页已经在用 | 新引入第二套 |

真正需要双向的只有对话，而对话也只需要「流式下行 + 一次性上行 POST」，
已经是 SSE 了。网关 `/gw/v1/*` 是一次性请求/响应，CRUD 同理 —— 都不该改成 WS。

### 实时调用流水

概览页的「实时调用流水」是第二条 SSE 通道：**网关每被调用一次就推一帧**。

```
audit.append(...)  →  auditListeners  →  SSE  →  概览页
```

订阅点放在 `packages/core/src/db/repos.ts` 的 `audit` 对象上（`audit.subscribe(fn)`），
不是在 server 里 —— 写审计的地方在 core 的 engine，core 不该反过来依赖 server。

- 首帧推最近 20 条，打开页面不是空白
- 前端保留最近 50 条，长时间开着不会涨内存
- 支持「暂停」：暂停期间新调用不进来，方便看具体某几条
- 新调用到达后**延迟 3 秒**才刷新 `/api/stats`，避免每来一条打一次接口
- 单个订阅者抛错不影响调用本身（`append` 里 try/catch 包住广播）

### 早期失败也要留痕

工具名写错、工具被禁用，这类失败在**摸到具体接口之前**就返回了。
以前直接 `return`，审计里什么都没有 —— 用户调错了工具名，流水里看不到任何痕迹。

现在 `invokeTool` 统一走 `earlyFailure()` 补一条审计：

| 情况 | 状态 | errorCode |
| --- | --- | --- |
| 工具名不存在 | 404 | `tool_not_found` |
| 工具已禁用 | 409 | `tool_disabled` |

记 `reqMeta.early = true`、`upstreamHost` 为空（压根没出网）。

`/gw/v1/:toolName` 直连路由也去掉了「先 `tools.byName` 预检再 404」的写法，
一律交给 `invokeTool` —— 否则直连路径的失败不会留痕，两条路行为不一致。

**鉴权失败不进审计**（401/403/IP 拦截/超配额）：那是访问控制拒绝，不是接口调用，
记了只会让日志被刷爆。

### 密钥与令牌：两级凭据方向相反

```
调用方 ──x-api-key──▶ 网关 ──${secret:NAME} 解密──▶ 上游
         ↑ 入站：API Key              ↑ 出站：vault 密钥
```

| | vault 密钥 | API Key |
| --- | --- | --- |
| 解决的问题 | 上游要 token，正文不能落明文 | 网关不能对所有人开放 |
| 存储 | AES-256-GCM 密文 | 只存 sha256 |
| 谁读 | 服务端（`makeResolver()`） | 调用方 |
| 控制什么 | 无 | IP 白名单、配额、过期、scopes、归属账号 |

加上第三层「账号」（控制台登录），共三层：**账号管配置 → 令牌管入站 → 密钥管出站**。

### 站内接口文档页：给别的 AI 交接，不是给人读

`#/docs`（导航里叫「交给其他 AI」）的目标不是当说明书，而是**生成一段能直接贴给
另一个 AI 的接入包**。用户把这段文字粘进任何 AI 客户端，对方就能开始调网关。

所以页面主体是生成器，不是目录：

```
选令牌 / 一键新建  →  生成 Markdown 接入包  →  复制 / 下载 .md
```

接入包内容：网关地址、`x-api-key`、三种调用方式、返回格式、**全部工具的
名字/参数/示例**、错误码表。一次性给全，对方不需要再问、也不用自己爬接口。

**只渲染 `name` / `title` / `description` / `inputSchema`。**
`platformSlug` / `endpointSlug` 也在 `/api/tools` 响应里，但一律不进接入包 ——
那两个值由上游 host 推导，等于半个上游地址。

#### 元数据泄露：默认剔除

没开 AI 分析时，`title` / `description` 会回退成 `GET /api/v1/orders` 这种上游路径。
网关本身把地址掩掉了，但元数据会把它漏出去 —— 而且是**直接递给另一个 AI**。

所以 `buildHandoffPack` 默认把「像上游路径」的标题/介绍剔除
（`looksLikeUpstreamPath()` 命中 `/api/`、`/v\d+/`、`^METHOD /`），
换成一句「未填写对外介绍，按工具名和参数使用」。要带出去得显式勾「带上游路径」。

生成器抽在 `apps/web/src/handoff.ts`（纯函数、无 React 依赖），
就是为了能拿真数据在 Node 里直接跑测试：生成 → 照着包里的话术真的调一次网关 → 断言不泄露。

#### 工具名也是泄露面

`title` / `description` 能裁，**工具名裁不掉** —— 它是调用凭据，必须原样出现在接入包里。

早期兜底名是 `平台slug__接口slug`，而平台 slug 由上游 host 推导，于是：

```
x127_8899__get_api_v1_orders      ← host、端口、路径全在里面
github__get_users_repos           ← 连是哪个服务商都告诉对方了
```

网关把域名掩了，名字又把地址写回去了。

现在 `resolveToolName()`：

1. `endpoint.publicName` 优先（用户自己起的名）
2. 否则 `平台名__接口slug`，但**平台名像域名/IP/带端口时改用中性前缀 `api`**
   （`looksHostish()` 判断），得到 `api__get_api_v1_orders`
3. 平台名是人起的（如 `orders`）才用它

配套两件事：

- `PATCH /api/tools/:id` 支持 `name`（校验 `[A-Za-z0-9_-]{1,64}` + 唯一），
  工具页编辑弹窗里能直接改。以前 `name: tool.name` 是锁死的，改不掉只能删了重发。
- `POST /api/tools/rebuild` 在 `publicName` 有值时以它为准，让接口页改的名能同步到工具。

前端 `looksLikeUpstreamName()` 标出仍带上游痕迹的名字，工具编辑弹窗和「交给其他 AI」页都会提示。
它抓的是 IP 片段、端口、`/api/`、`/v1/` —— 服务商名（`github_users`）抓不出来，
那种只能靠人自己别这么起。

#### 对外文案：标题、描述、参数说明

名字改干净了，**文案还在漏**。没开 AI 时 `summary` 就是上游原文，于是：

```
GET /gw/v1/tools  →
  title:       "GET /api/v1/orders"
  description: "GET /api/v1/orders"
  inputSchema.properties.page = { type: "number" }     ← 没有 description
```

网关把域名掩了，路径原样递给每一个调用方。而且 `page` 是什么、传什么格式，调用方完全靠猜。

`packages/core/src/tools/describe.ts` 是这套文案的地基：

| 函数 | 作用 |
|---|---|
| `looksLikeUpstreamPath()` | 认出 `GET /api/v1/x`、`/v1/x`、`https://…`、裸路径 `/users/{id}` |
| `semanticLabel()` | 方法 + 路径 → 「查询 orders 列表」「按 ID 查询 orders 详情」，**不带路径** |
| `sanitizePublicText()` | 空的、或者写着上游路径的，一律换成兜底说法 |
| `paramHint()` | 参数名 → 中文说明（`page` → 页码，`limit` → 每页条数，`userId` → 唯一标识…） |
| `coerceExample()` | 示例值按声明类型纠正（`page` 声明 number，示例不该是字符串 `"1"`） |

三处一起改：

1. **`compileTool`** —— `title`/`description` 走 `sanitizePublicText`，参数没说明时用 `paramHint` 兜底。
   描述里额外列出参数清单（`- page（query）：页码，从 1 开始`），MCP 客户端不渲染 `inputSchema` 也读得懂。
2. **`/gw/v1/me`** —— 不再直接用 `ep.summary` / `ep.notes`，改用编译后的工具文案，
   `notes` 过一遍 `stripPathParenthetical()` 抠掉 `（GET /api/v1/orders）` 这种括号补丁。
3. **`/gw/openapi.json`** —— `summary` 用 `tool.title`，参数说明用 `paramHint` 兜底。

AI 那条链也要管：模型看到 `GET /api/v1/orders` 很可能原样抄回来当标题。
所以 `applyAnalysis` / `applyDescription` / `applyParamHints` 收模型输出时都过一遍
`looksLikeUpstreamPath()`，命中就丢掉，落回规则兜底 —— **不能让模型把路径带回去**。

命名 Agent 现在还会产出 `description`（一两句功能说明，说清做什么、什么副作用），
以前它只管名字和参数说明，工具描述是空的。

改完的效果：

```
GET /gw/v1/tools  →
  title:       "查询 orders 列表"
  description: "查询 orders 列表\n参数：\n- page（query）：页码，从 1 开始"
  inputSchema.properties.page = { type: "number", description: "页码，从 1 开始", examples: [1] }
```

`scripts/smoke.mjs` 里加了硬检查：`/gw/v1/tools`、`/gw/v1/me`、`/gw/openapi.json`
三处的标题/描述/备注都不许命中 `/\/api\/|\/v\d+\/|METHOD \//`，且每个入参必须有说明。

#### 令牌进不去服务端

接入包在**浏览器里**拼，令牌不会发给任何接口。已有令牌的明文只在创建时显示过一次
（库里存哈希），所以页面提供两条路：一键新建（明文直接带进包）或手动粘贴。

### 站点自动归组

### 站点自动归组

站点标识是 **host + 非标准端口**，不是纯 hostname：

```
api.example.com/a, www.example.com/b  → example      （同一个站点）
127.0.0.1:8899/x, 127.0.0.1:8898/y    → x127_8899 / x127_8898  （两个站点）
```

早期只按 hostname 归组，导致本机不同端口的服务被错并成一个站点，
连站点标题都会串。现在端口参与标识。

### 站点标题自动抓取

新平台落地前并行抓一次首页（`packages/core/src/import/site.ts`）：

- 5 秒超时、64KB 上限、只抓 `origin + '/'`
- 只接受 `text/html`；3xx 不跟随（避免跳到别的域）
- 解析 `<title>`（实体解码、去空白、截断 120 字）和 favicon
- 失败静默降级到 `host:port`，绝不因为抓不到标题而让整理失败

抓到标题就用它当平台名 —— 用户看到的从 `x127_8898` 变成「商品中心 API」。

多站点并行抓取（`Promise.all`），不是逐个等超时。

## 一键整理：Agent 流水线

整理不再是「LLM 看路径猜用途」，而是三个 Agent 串行协作：

```
curl / HAR / OpenAPI / 文档
  ↓  规则解析（不需要 AI）
NormalizedDraft[]
  ↓  平台 + 密钥落地（探测需要 baseUrl 和密钥）
  ↓
┌─ 1. 探测 Agent  packages/core/src/agents/probe.ts
│     对只读接口发一次真实请求，拿真实响应样本
│     护栏：只碰 GET/HEAD + sideEffect=read；必填参数缺样例值就跳过；
│           走 assertEgressAllowed（域名白名单 + 私网拦截）；redirect=manual；
│           超时 + 256KB 上限；响应脱敏后才交给 LLM
│     ⚠ 4xx/5xx 标记 errorResponse，不当成接口正常返回结构
│  ↓
├─ 2. 分析 Agent  packages/core/src/agents/analyze.ts
│     拿「接口定义 + 真实样本」判断用途，产出：
│     summary / description / notes（业务含义+返回什么+关键字段+注意事项）
│     无样本 → 备注注明「未经实际调用验证」
│  ↓
└─ 3. 命名 Agent  packages/core/src/agents/naming.ts
      生成对外工具名（与上游路径解耦）+ 参数说明
      清洗：剥掉 api/v1/rest 等上游痕迹；同批撞名自动加序号
  ↓
import_candidate（带备注、对外名、参数说明）
```

编排在 `packages/core/src/agents/index.ts`，每步独立失败、独立可关：

| 开关 | 作用 |
|---|---|
| `probeUpstream: false` | 不发真实请求，只用路径推断 |
| `useAi: false` | 整条 AI 链路跳过，只做规则解析 |
| `maxProbes` | 单次导入最多探测几个接口（默认 12），防止打爆上游 |

LLM 未配置时全链路优雅降级：探测仍会跑（不依赖 LLM），分析与命名跳过。

## 一键整理的分类规则

`dedupeKey = METHOD + 归一化路径({x}→{}) + 参数集合(排序)`

| 情况 | diffKind | 处理 |
|---|---|---|
| 平台内无同名 slug 且无同 key | `new` | 采纳后新建 |
| 同 slug，内容哈希相同 | `duplicate` | 跳过 |
| 同 slug，内容不同 | `modified` | 采纳后覆盖该接口并发布 |
| 同 key，内容不同 | `modified` | 采纳后覆盖 |
| 与本次批次内其它草稿同 key | `conflict` | 默认不自动发布，需人工判断 |

## 扩展点

- **加一个平台**：控制台「平台」页新建（或直接贴 curl 让它自动建），补 `egressAllowHosts` 与鉴权方式。
- **换存储**：`packages/core/src/db/repos.ts` 是唯一 SQL 出口，替换实现即可接 Postgres。
- **接签名/风控接口**：在 `buildRequest` 之后插入 `preRequest` 钩子（当前留空），可注入 JS 签名、时间戳、nonce。

## 备注的兜底与可见性

### 为什么需要兜底

早期 `specToDraft` 里 `notes: ''` —— 不开 LLM 时，用户整理完看到的备注是空的，
不知道是「AI 没跑」还是「AI 跑了但没内容」。现在分三层：

```
1. 规则兜底（永远有）      fallbackNotes(method, path) → 「查询 orders 列表（GET /api/v1/orders）」
                                              + 「（规则生成，未经 AI 分析）」
2. AI 分析（LLM 启用时）    applyAnalysis 整段覆盖 notes：
                            业务含义 / 返回什么 / 关键字段 / 注意事项
3. 明确告知（LLM 关闭时）   analyzeDrafts 往 stats.errors 写
                            「LLM 未启用，跳过 AI 分析（备注和接口介绍不会生成）」
                            → 前端 .notice.warn 自动显示
```

关键：**兜底文案必须自带「未经 AI 分析」标注**，否则用户会误以为那是 AI 的结论。

### 候选预览必须显示备注

以前导入页的候选卡只渲染 `payload.summary`，`payload.notes`（返回什么 / 关键字段 /
注意事项）从来没渲染过 —— AI 明明生成了，用户却看不到，只有采纳后在接口资产页展开才看得见。
现在导入页和整理记录页都直接渲染 `description` 和 `notes`，用 `white-space: pre-line`
保留 AI 输出的多行结构。

## 路径参数占位符

`new URL()` 会把 `{id}` 编码成 `%7Bid%7D`。早期没还原，导致：

- `/api/v1/orders/{id}` 被当成字面量路径
- 备注写成「查询 %7Bid%7D 列表」
- 工具名里出现 `7_bid_7_d` 这种垃圾

现在 `buildPathTemplate` 先把 `%7B`/`%7D` 还原，再按三类识别：

| 写法 | 处理 |
| --- | --- |
| `{id}` / `{order_id}` / `:id` | 直接用作参数名，**不给 example**（占位符不是真实值，探测会跳过） |
| `/orders/12345` | 推断名 `orderId`，example=`12345`（探测可以用） |
| `/orders/<uuid>` | 同上 |

重名占位符自动加序号：`/a/{id}/b/{id}` → `/a/{id}/b/{id2}`。

## 发布路径

「发布」= 采纳候选（建接口 → publish → 编译工具）。为了让后台整理完能直接发布：

- **整理记录页**每行「发布全部」→ `accept-all`，展开后逐条「发布 / 忽略」，并显示备注
- **导入页**把 jobId 存两份：`aah_active_import_job`（跑动中）和
  `aah_last_import_job`（跑完后保留）。离开再回来能恢复上一次的候选列表，
  否则组件重挂载后候选是空的，就没法发布了

`accept-all` 跳过 `duplicate` 和 `conflict`，幂等（已采纳的不会重复建）。

## 数据落盘：位置、WAL、备份

### 路径必须锚定，不能跟 cwd 走

`.env` 里 `DB_PATH=./data/hub.db` 是相对路径。早期直接用 `resolve()`，解析基准是
`process.cwd()` —— 于是：

```
从项目根启动    → D:\project\各个平台接口\data\hub.db   ✅ 有数据
从 C:\ 启动     → C:\data\hub.db                        ❌ 一个全新的空库
```

用户看到的现象就是「每次重启数据都丢了」，其实数据还在原处，只是服务读的是另一个文件。

现在 `resolveDataPath()` 把相对路径锚在**项目根**（由 `import.meta.dirname`
往上四层推导），与 cwd 无关。主密钥 `master.key` 同理 —— 而且这个更严重：
路径一变就会**重新生成主密钥**，之前加密的所有上游凭据全部解不开，且不可逆。

启动时把两个绝对路径打进日志，出问题时不用猜：

```
{"msg":"数据库: D:\\project\\各个平台接口\\data\\hub.db"}
{"msg":"主密钥: D:\\project\\各个平台接口\\data\\master.key"}
```

### WAL 与「备份出来是空库」

SQLite 用 WAL 模式时，数据先写进 `hub.db-wal`，主库文件可能长期只有 4KB：

```
hub.db        4096      ← 只有一个头
hub.db-wal    1046512   ← 真正的数据在这
```

两个后果：

1. **只拷 `hub.db` 去备份会得到空库。** 所以退出时 `wal_checkpoint(TRUNCATE)`
   把 WAL 合回主库，之后 `hub.db` 才是自包含的。
2. **硬杀不丢数据，但文件不完整。** Windows 的 `Stop-Process -Force` 不走
   SIGINT/SIGTERM，优雅关闭不会执行；不过 WAL 本身是可恢复的，下次打开会自动回放。
   真正危险的是「拷了半套文件」——所以备份前必须先 checkpoint。

### 启动备份

`getDb()` 打开之前先备份一次（同一小时内不重复，最多留 10 份）：

```
data/backups/hub-2026-10-29-17-44-49.db
```

备份**必须发生在 checkpoint 之后**，否则拷到的还是那个 4KB 空壳 —— 这个坑实现时踩过一次。
如果 checkpoint 失败（比如有别的连接占着），就退化成连 `-wal` 一起拷，
还原时两个文件放回去才能用。

单机自用没有别的兜底：迁移写坏了、手滑删了，都只能靠这个。`data/` 不要提交到版本库。

## 在线更新：pull 不是全部

这是「源码直跑」的部署形态（Node 直接执行 `.ts`，没有编译产物），所以更新不是换个二进制，
而是三件事，少一件就会出「更新了但没变化」：

```
git pull --ff-only  →  必要时 npm install  →  重建前端 dist  →  重启进程
```

**为什么必须重建前端**：`apps/web/dist/` 在 `.gitignore` 里（构建产物不入库），
所以 `git pull` 之后页面上跑的仍是旧 bundle。不重建的话，后端新接口前端根本看不见。

**为什么依赖要单独判断**：`npm install` 动辄几分钟。只有 `package.json` /
`package-lock.json` / 任意子包 `package.json` 在 diff 里出现时才装，否则跳过。

**为什么只允许 fast-forward**：单机部署没有冲突解决流程。`--ff-only` 遇到分叉就失败，
留一个干净的仓库让人来处理，好过产生一个半合并的提交。

**为什么不自动重启**：进程重启会丢掉正在跑的导入任务。`apply` 返回
`restartRequired: true`，由用户自己 Ctrl+C 再启动。

### 边界

- 端点挂在 `/api` 下 → 走账号会话；`/gw` 网关碰不到。不能让调用方更新网关自己。
- `git fetch/pull` 一律带 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、
  `GIT_ASKPASS=echo` —— 没有凭证时**立刻失败**，而不是把 HTTP 请求挂在那里等输入。
- 远程为空、不可达、非 git 仓库，都返回结构化 `message` 而不是 500。
- **Windows 上 `npm`/`npx` 是 `.cmd`**，Node 不允许直接 spawn（抛 `EINVAL`），
  必须带 `shell: true`。否则表现为「代码已经 pull 成功，但接口 500」——
  最难判断的一种失败：仓库变了，页面没变。

### 版本号只有一个来源

根 `package.json` 的 `version`。`VERSION` 常量在 `packages/core/src/util/version.ts`
读它，`/api/health` 和更新页都从这里取。

以前 `app.ts` 硬编码 `'0.2.0'`、`package.json` 写 `0.1.0` —— 两处对不上，
在线更新要显示当前版本，不能有第二个真相。

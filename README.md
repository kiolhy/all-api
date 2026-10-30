# 接口资产中枢（API Asset Hub）

把各平台接口收编成**资产**，用 AI 一键整理，通过**自有网关**转发（上游域名与密钥全程不外泄），再以 **MCP / 站内对话 / REST** 三种形态交给 AI 调用取数。

```
              ┌──────────── 一键整理 ────────────┐
 curl / HAR / │ 解析 → 归一化 → AI 补语义 → 去重  │
 OpenAPI /文档 │            → 候选 diff → 发布     │
              └───────────────┬──────────────────┘
                              ▼
   ┌──────────────────── 接口资产库（SQLite）────────────────────┐
   │  platform · endpoint(版本快照) · tool · secret(加密) · audit  │
   └───────────────────────────┬─────────────────────────────────┘
                               ▼
   ┌──────────────────── 转发引擎（隐藏上游）────────────────────┐
   │ 参数白名单 · 密钥注入 · 出网白名单 · 限流熔断 · 响应裁剪脱敏  │
   └───────┬───────────────────┬───────────────────┬─────────────┘
           ▼                   ▼                   ▼
      MCP Server          站内对话(SSE)       REST / OpenAPI 3.1
   (DSH/Claude/Codex)    (模型自动选工具)      (给程序调用)
```

---

## 快速开始

```bash
npm install
cp .env.example .env          # 改 ADMIN_TOKEN，可选配 LLM

npm run mock                  # 终端 1：本地假上游 http://127.0.0.1:8899
npm run dev                   # 终端 2：网关 8778 + 控制台 5173
# 或者只起后端：npm run server
```

打开 <http://127.0.0.1:5173>（dev）或 <http://127.0.0.1:8778>（构建后由服务端托管），
顶部填入 `.env` 里的 `ADMIN_TOKEN` 即可使用。

### 5 分钟走通一遍

1. **一键整理**页粘贴：

```bash
curl 'http://127.0.0.1:8899/api/v1/users/42' -H 'Authorization: Bearer sk-demo-secret-xyz'
curl 'http://127.0.0.1:8899/api/v1/orders?limit=3'
```

2. 勾选「自动发布」→ 开始整理。你会看到 2 个候选（`GET /api/v1/users/{userId}`、`GET /api/v1/orders`），
   `Authorization` 已被自动抽成密钥 `x127_authorization`，接口定义里只剩 `${secret:...}` 引用。
3. **密钥**页生成一个 API Key（只显示一次）。
4. **工具**页点「复制 MCP 配置」，粘到 DSH / Claude Desktop 的 MCP 配置里。
5. 对话里问「帮我查一下用户 42 的信息」，模型会自己选中工具并取数。

---

## 三种给 AI 用的通道

### 1. MCP Server（推荐）

```json
{
  "mcpServers": {
    "api-asset-hub": {
      "command": "node",
      "args": ["D:/project/各个平台接口/apps/mcp/src/index.ts"],
      "env": {
        "GATEWAY_URL": "http://127.0.0.1:8778",
        "HUB_API_KEY": "hub_live_xxx"
      }
    }
  }
}
```

- 工具数 ≤ 20：每个接口直接注册成一个 MCP 工具（`platform__endpoint`，带 JSON Schema 与 `readOnlyHint`）。
- 工具数 > 20：只暴露 `catalog_search` / `catalog_describe` / `catalog_call` 三件套，避免上下文爆炸。
- 另有 `hub://tool/<name>` resource 提供完整文档。

冒烟测试：`node scripts/mcp-smoke.mjs <toolName> '{"limit":2}'`

### 2. 站内对话

`POST /api/chat/sessions/:id/messages` 走 SSE。模型按 JSON 协议决策：

```json
{"action":"call","tool":"x127_get_api_v1_orders","args":{"limit":2}}
{"action":"final","answer":"..."}
```

最多连续 4 步工具调用；每一步都会推 `tool_call` / `tool_result` 事件，界面渲染成独立卡片。

### 3. REST / OpenAPI

```bash
curl -X POST http://127.0.0.1:8778/gw/v1/call \
  -H 'x-api-key: hub_live_xxx' -H 'Content-Type: application/json' \
  -d '{"tool":"x127_get_api_v1_orders","args":{"limit":2}}'
```

- `GET /gw/v1/me` — 当前令牌绑定的接口资产与备注
- `GET /gw/v1/tools` — 工具清单（含 inputSchema）
- `GET /gw/openapi.json` — 自动生成的 OpenAPI 3.1
- `GET /gw/llms.txt` — 给模型看的纯文本清单
- `GET|POST /gw/v1/:toolName?<query>` — 按对外工具名直连

> 控制台「交给其他 AI」页（`#/docs`）把上面这些 + 当前已发布工具目录
> 生成成一段可以直接粘给别的 AI 的接入包（地址、令牌、调用方式、工具清单、
> 参数示例、错误码），可复制可下载 .md。只显示对外工具名，不含上游 host
> 与原始路径；标题/介绍里混进上游路径的会被自动剔除。

---

## 一键整理管线

| 输入 | 处理 |
|---|---|
| `curl` | 词法解析（`-X -H -d --data-raw --data-urlencode -F -u -b`、反斜杠续行、单双引号、`$'...'`、**一次多条**） |
| `HAR` | 过滤静态资源，按 host 分组，同 key 去重（整段抓包一次进） |
| `OpenAPI` | JSON/YAML 直接映射（含 `$ref` 浅解析、servers 前缀、requestBody），质量最高，跳过 LLM（一个文档的 path 全部进） |
| 文档文本 | LLM 抽取接口清单 |

**一次能进多少个接口**：没有数量上限，取决于输入里有多少条请求。
- 多条 `curl` 直接叠在一个粘贴框里，按行首 `curl`/`wget` 切块（`splitCurlBlocks`）
- 一份 HAR 是整个浏览会话的所有请求
- 一份 OpenAPI 是所有 path × method

跑完得到候选列表，可以逐个确认，也可以「全部采纳」一次性入库。
点之前会先弹一张账：**将新建几个、更新几个、跳过几个（批次内冲突 / 重复）**，
确认后才写库并编译工具 —— 批量操作不该盲点。

**重复导入是幂等的**：同一份文档导入第二次，接口按「方法 + 归一化路径 + 参数集合」判重，
内容一致直接跳过（`duplicates`），不再产生 `_2`、`_3` 这种后缀漂移。

归一化阶段做的事：

- URL → 平台（`api.github.com` → `github`），路径动态段 → `{userId}`（数字 / UUID / 长 hex 识别）
- 噪声头（Host、Content-Length、UA、Sec-* …）丢弃
- **密钥自动识别**：`Authorization` / `x-api-key` / 高熵串 → 抽进加密 vault，接口定义里只留 `${secret:NAME}`；`Bearer xxx` 会保留前缀
- 请求体：JSON 顶层字段 → 参数；字面密钥替换为引用；生成 JSON Schema 形状给 AI 看

AI 增强（可关，`LLM_ENABLED=true` 时生效）补：语义 slug、中文 summary/description、参数类型与必填、读写/敏感度、分组标签。返回严格 JSON → Zod 校验 → 失败自动降级为规则结果，不会阻塞。

去重键 = `方法 + 归一化路径 + 参数集合`；内容哈希未变直接跳过。候选分四类：`new / modified / conflict / duplicate`，人工确认后发布（发布写入不可变版本快照，AI 侧引用固定版本）。

---

## 安全设计

| 面 | 做法 |
|---|---|
| 密钥 | AES-256-GCM 落库；主密钥来自 `MASTER_KEY`（缺省自动生成 `data/master.key`）；只在出网瞬间解引用 |
| 上游隐藏 | 响应里不回显上游 host（仅控制台可见）；上游错误归一化为自有错误码，不透传上游 body |
| 响应脱敏 | 字段级 `redactFields` + 键名命中（token/password/authorization…）+ 密钥明文全文替换 |
| 出网 | host 白名单（平台 baseUrl + `egressAllowHosts`）；默认禁私网/回环；禁止 3xx 跳转（防白名单外跳转） |
| 入参 | 只接受接口声明过的参数；路径参数 `encodeURIComponent` 且拒绝 `..` `//` 协议前缀 |
| 流量 | 每 API Key × 平台令牌桶 QPS + 日配额；上游连续 5 次失败熔断 60s |
| 审计 | 追加写表，记录 tool/状态/耗时/上游 host/脱敏后的元数据；工具名写错/被禁用也留痕 |

> 单机自用定位，三层鉴权：**账号**（控制台登录，管配置）→ **API Key**（入站，管谁能调）
> → **vault 密钥**（出站，管怎么调上游）。多租户/计费不在当前范围。
>
> 调用方 ──x-api-key──▶ 网关 ──`${secret:NAME}` 解密──▶ 上游

---

## 数据文件

全部在 `data/`，**相对路径锚在项目根，不跟启动目录走**：

| 文件 | 说明 |
|---|---|
| `data/hub.db` | 全部数据（SQLite，WAL 模式） |
| `data/hub.db-wal` / `-shm` | WAL 日志，**不要单独删** |
| `data/master.key` | 主密钥，丢了则所有上游凭据解不开且不可逆 |
| `data/backups/` | 启动时自动备份，留最近 10 份 |

```bash
# 从任何目录启动都读同一个库（相对 DB_PATH 锚在项目根）
node --env-file-if-exists='D:\project\各个平台接口\.env' 'D:\project\各个平台接口\apps\server\src\index.ts'
```

两个容易踩的坑：

- **备份只拷 `hub.db` 可能得到空库** —— WAL 模式下数据可能还在 `-wal` 里。程序退出时会自动
  checkpoint 合并，`data/backups/` 里的文件也已经合并过，可以直接用。
- **`master.key` 换了，旧密钥就全废了**。迁移机器时把 `data/` 整个拷走。

---

## 目录

```
packages/core/            领域逻辑（唯一真相源）
  src/schema/             Zod 资产模型
  src/db/                 迁移 + 仓储层（换 Postgres 只改这里）
  src/import/             curl / HAR / OpenAPI / 归一化 / 去重 / AI 增强 / 管线
  src/invoke/             建请求 / 出网守卫 / 响应整形 / 脱敏 / 缓存 / 执行器
  src/secrets/            vault
  src/tools/              Endpoint → 工具定义编译
  src/chat/               对话 agent（JSON 工具调用协议）
  src/gateway/            OpenAPI 3.1 / llms.txt 生成
apps/server/              Fastify：/api（控制台）+ /gw（网关）+ 静态托管
apps/mcp/                 MCP Server（stdio）
apps/web/                 Vite + React 控制台（手写 CSS，无 UI 框架）
fixtures/mock-upstream/   本地假上游（测试/演示）
scripts/                  dev / mcp-smoke
docs/api.md               REST 契约
```

## 命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 网关 + 控制台 dev |
| `npm run server` | 只起网关 |
| `npm run web` | 只起控制台 dev |
| `npm run mcp` | 单独跑 MCP Server（stdio） |
| `npm run mock` | 本地假上游 8899 |
| `npm test` | core 单测 + 端到端（自动拉起假上游） |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |

## 在线更新

设置页「版本与更新」里点**检查更新 / 立即更新**。更新 = `git pull --ff-only`
→ 必要时 `npm install` → 重建前端 `dist` → **重启进程生效**。

前端产物不入库，所以 pull 之后必须重建，否则页面还是旧的；这两步由接口一次做完。

```bash
# 手动等价操作
git pull --ff-only
npm install            # 只有依赖变了才需要
npx vite build --config apps/web/vite.config.ts
# 然后 Ctrl+C 重启服务
```

更新端点挂在 `/api` 下（要账号登录），网关 `/gw` 碰不到 ——
不能让调用方更新网关自己。工作区有未提交改动时会拒绝更新。

## 一键验收

```bash
npm run verify
```

依次跑：类型检查 → 单元测试（186）→ 前端构建 → 冒烟（51）→ 批量导入（16）
→ 批量发布预览 → AI 链路（32）。缺服务会自动拉起假上游 `:8899` 和网关 `:8778`，
跑完只关自己拉起的那些。

**跑完库跟跑之前一样**：每个测试脚本记下开跑前的接口/平台 id，结束只删自己新增的，
不碰你已有的数据。LLM 配置也会还原（`baseUrl` / `model` 一并）。

AI 那一步用本地 OpenAI 兼容桩，不需要真实 Key —— 它验证的是整条链路
（配置 → 提示词 → 解析 → 应用 → 编译 → 网关）和「模型不听话时能不能兜住」。

## 技术约束（重要）

- Node **24+**，直接跑 `.ts`（原生类型擦除）：**禁用 `enum` / `namespace` / 构造函数参数属性**，类型导入必须 `import type`，相对导入必须带 `.ts` 扩展名。
- 存储用内置 `node:sqlite`（无需编译原生模块），WAL 模式。
- 无 Docker / 无 pnpm 依赖。

## 已知边界

- 需要 JS 签名、验证码、风控的接口（部分电商/社交平台）暂不支持，预留 `preRequest` 钩子位。
- 文件上传（multipart）只保留结构，实际调用会明确报错而不是静默失败。
- 多租户、计费、审计不可篡改存储不在当前范围。
- 本地假上游的 host 是 `127.0.0.1`，自动生成的平台 slug 会是 `x127`（数字开头加前缀）；接真实域名时 slug 正常。

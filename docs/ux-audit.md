# 全站体验审查报告

审查范围：`apps/web/src` 全部 12 个页面 + 8 个组件 + `styles.css`（2731 行）。
方法：逐页读源码，扫 CSS 类覆盖度，对照后端已实现但前端没接的能力。

---

## 结论：不是配色问题

三个根因，按影响排序：

1. **CSS 词汇漂移** —— 账号页用了 5 个 `styles.css` 里根本不存在的类，两个表单完全没样式。
2. **两套编辑入口** —— 「接口资产」和「工具」都在改同一批字段，用户不知道该去哪改。
3. **核心配置是裸 JSON** —— 接口编辑抽屉 18 个字段里有 4 个是 JSON 编辑器，最常改的 `params` 要手写数组。

---

## 逐页清单

| 页面 | 主要问题 | 严重度 |
|---|---|---|
| 概览 | 卡片里写开发者路径；「刷新」「重新载入」两个按钮同义 | P1 |
| 平台 | `authConfig` / `defaultHeaders` 裸 JSON；一行 4 个按钮 | P1 |
| 接口资产 | 一行 5 个按钮；编辑抽屉 4 个 JSON 编辑器；无分页无多选 | P1 |
| 工具 | 和接口页抢同一个「对外名」；无搜索 | P1 |
| 一键整理 | 三选项挤一行；候选不能先改再采纳；任务 ID 是 hash | P1 |
| 整理记录 | **标题没样式（32px）** | P0 |
| 对话 | 必须先建会话才能说话 | P2 |
| 密钥与令牌 | 编辑抽屉用了未定义的 `.form-row` | P0 |
| 交给其他 AI | 基本没问题 | — |
| 审计 | 基本没问题 | — |
| 设置 | **无改密表单，但菜单指向这里** | P0 |
| 账号 | **`.panel` 等 5 个类未定义，表单裸奔** | P0 |

---

## P0 · 坏掉的（看得见，改起来快）

### 1. 整理记录页标题是别人的两倍大

`pages/JobsPage.tsx:212`

```tsx
<h1>整理记录</h1>          // 没有 className
```

`styles.css` 里**没有任何 `h1` / `h2` / `h3` 全局样式**（全文搜索 0 命中）。
所以它按浏览器默认 `2em` ≈ 32px 粗体渲染，其他 11 个页面都是 `.page-title` 的 18px。

副标题也用了 `<p className="dim">` 而不是 `.page-sub`，字号和颜色都不对。

### 2. 账号页的表单没有任何样式

`pages/AccountsPage.tsx:183,195,196,197,223,232,243`

用到的类：`.page` `.panel` `.panel-title` `.form-row` `.panel-actions`

`styles.css` 里定义了 279 个类，**这 5 个一个都没有**。

结果：「新建账号」「重置密码」两个表单是裸的 —— 没有边框、没有内边距、没有卡片背景，标题和正文一样大，三个字段直接堆在页面上。

同一个问题在 `pages/SecretsPage.tsx:605`：API Key 编辑抽屉里用了 `.form-row`，本该是网格布局，实际挤成一坨。

> 全站扫描结果：233 个用到的类里，9 个没定义（其中 3 个是 `` `step-${status}` `` 这类模板拼接的误报，真实缺失 5 个）。

### 3. 修改密码是死链接

`App.tsx:191` —— 用户菜单点「修改密码」→ `navigate('/settings')`。

但 `SettingsPage` 只有三块：LLM、出网配置、版本与更新。**没有改密表单**。

而后端和 API 层其实都写好了：

- `apps/server/src/routes/auth.ts:70` `POST /api/auth/change-password`
- `apps/web/src/api.ts:171` `changePassword(oldPassword, newPassword)`

全站搜索 `changePassword`，**除了定义处没有任何页面调用它**。

后果：普通成员无法修改自己的密码；管理员只能去「账号」页重置自己，还得先看到自己的行。

### 4. 概览页把接口路径写进了界面

`pages/OverviewPage.tsx:240`

```
概览数字来自 `GET /api/stats`，审计来自 `GET /api/audit?limit=10`。
```

这是给开发者看的调试信息。而且这个系统的目的就是不暴露原始接口，界面上摆一排路径观感很跳。

### 5. 两处代码格式被压平

- `pages/ImportPage.tsx:174` —— `const run = async () => {    if (!text.trim()) {`
- `pages/SettingsPage.tsx:144` —— `return (    <>`

不影响运行，但说明之前有脚本改过文件且没跑格式化。

---

## P1 · 用起来别扭的

### 6. 接口资产：一行 5 个按钮

`EndpointsPage.tsx:437` 操作列宽 300px，塞了「试运行 / 编辑 / 发布 / 归档 / 删除」。
表格共 9 列（含展开箭头），横向已经需要滚动。

**改法**：只留「编辑」，其余收进 `⋯` 下拉；或改成点行展开后才出操作。

### 7. 接口编辑抽屉是一堵墙

`EndpointsPage.tsx:686-877`，18 个字段，宽度 760px，其中 4 个 JSON 编辑器：

| 字段 | 行数 |
|---|---|
| `params（JSON 数组）` | 7 |
| `body（JSON 或 null）` | 5 |
| `response（JSON）` | 7 |
| `examples（JSON 数组）` | 4 |

最要命的是 `params`：**这是最常改的东西，却要手写 JSON 数组**，还得记住 `{"name","in","type","required","description","secretRef"}` 的结构。

而展开行里 params 明明已经渲染成漂亮的表格了（`EndpointsPage.tsx:479`）—— 看得懂，改不动。

**改法**：params 换成可增删的行编辑器（名称 / 位置 / 类型 / 必填 / 说明 / 密钥引用 六列），JSON 收进「高级」折叠区。`body` / `response` / `examples` 同理，默认折叠。

### 8. 平台鉴权也是裸 JSON

`PlatformsPage.tsx:419,428` —— `authConfig` 和 `defaultHeaders` 两个 JSON 编辑器。

选了 `bearer` 之后，用户得自己知道要写 `{"token":"${secret:NAME}"}`。选 `apiKey` 又得知道键名叫什么。

**改法**：按 `authKind` 渲染不同表单 —— bearer 就一个「Token」输入框，header 就「头名 + 值」，query 就「参数名 + 值」。`${secret:NAME}` 用下拉选已有密钥。

### 9. 工具页和接口页在改同一批数据

| 字段 | 接口资产页 | 工具页 |
|---|---|---|
| 对外名 | ✅ 可改 | ✅ 可改 |
| 标题 | — | ✅ |
| 描述 | ✅ `description` | ✅ `description` |
| cacheTtl | — | ✅ |
| namespace | — | ✅ |
| params | ✅ | — |

同一个「对外名」两个页面都能改，改完另一边不一定刷新。用户不知道权威入口在哪。

**改法**：工具页只读（它是「AI 看到的样子」的预览），要改就跳转接口页；或者干脆合并成一个页面两个 tab。

### 10. 表格没有分页、排序、多选

`components/Table.tsx` 116 行，全量渲染 `rows.map()`。

批量导入 200 条接口后，接口资产页一次渲染 200 行 DOM。也不能多选批量发布 / 归档 —— 只能一条条点。

**改法**：Table 加 `pageSize` 和 `selectable`，接口资产页加「全选 + 批量发布」。

### 11. 导入候选不能先改再采纳

AI 起错名字（比如 `list_orders_2`），只能先「采纳」，再跳到接口页找到它、打开抽屉、改、保存。

**改法**：候选卡片上加「编辑后再采纳」，直接在卡片里改 slug / 对外名 / 标题。

### 12. 中英文枚举混着显示

| 位置 | 显示 |
|---|---|
| 状态筛选 `EndpointsPage.tsx:593` | `draft` / `published` / `archived` |
| 读写属性 `:748` | `read` / `write` |
| 敏感度 `:757` | `low` / `medium` / `high` |
| 鉴权类型 `PlatformsPage` | `none` / `bearer` / `header` / `query` / `basic` |
| 导入格式 | `curl` / `har` / `openapi` / `text` |
| **开放策略** | **中文**（`EXPOSURE_LABEL`） |
| **额度周期** | **中文**（`QUOTA_PERIOD_LABEL`） |

`types.ts` 里只有 `EXPOSURE_LABEL` 和 `QUOTA_PERIOD_LABEL` 两个中文映射，其余直接渲染原始值。

### 13. 刷新按钮三个词一个意思

「刷新」（概览、接口、平台、工具、密钥）、「重新载入」（导入、概览）、「重新加载」（设置）。

概览页甚至同时有「刷新」和「重新载入」两个按钮。

### 14. 导入页三个选项挤在一行

`ImportPage.tsx:320-334`，三个 checkbox 塞进一个 `Field`：

- 用 AI 分析
- 真实探测（只读接口）
- 直接发布（整理完立即上线接口）← 标签特别长，撑开布局

另外 **`probeUpstream` 默认是 `true`**（`ImportPage.tsx:41`）—— 每次导入都会真的去请求上游接口。对「不想惊动上游」的场景不友好。

---

## P2 · 细节

15. **表格字号偏小** —— 正文 12px、表头 11.5px（`styles.css:727,733`），长时间看累。
16. **响应式只有 2 个断点** —— 1180px 和 960px。960 以下侧栏还是固定 160px，375px 手机上内容区只剩约 190px。
17. **对话页必须先建会话** —— 空状态下输入框不可用，得先点「新建会话」。
18. **任务 ID 是 hash** —— 导入页和整理记录页显示 `a1b2c3d4`，用户认不出是哪个任务。
19. **登录页常驻默认密码提示** —— `LoginPage.tsx:72` 永远显示 `admin / admin123456`，改过密码也不消失。
20. **4 个死 CSS 类** —— `.token-bar` `.token-label` `.token-input` `.token-state`（`styles.css:189-239`），旧设计残留。

---

## 建议的修复顺序

**第一批 · 纯 bug（约 30 分钟）**
1. 整理记录页标题加 `.page-title`，副标题改 `.page-sub`
2. 补 `.panel` `.panel-title` `.panel-actions` `.form-row` 四个样式（或改用已有的 `.card` / `.form-grid`）
3. 设置页加「修改密码」表单，接上已有的 `authApi.changePassword`
4. 删掉概览页的开发者文案
5. 修两处压平的代码格式

**第二批 · 交互（约半天）**
6. 接口行操作收进菜单
7. `params` 改行编辑器
8. 平台鉴权按 `authKind` 拆表单
12. 枚举补中文映射
13. 统一「刷新」
14. 导入选项拆开，`probeUpstream` 默认关

**第三批 · 结构（约一天）**
9. 工具页只读化
10. 表格加分页 + 多选
11. 候选可编辑后再采纳

---

## 已完成的改动（本轮）

### 第一批 · 纯 bug（20 条中的 1–5）

| # | 问题 | 改法 | 文件 |
|---|---|---|---|
| 1 | 整理记录页标题没样式 | `<h1 className="page-title">` + `.page-sub`，外层改普通 `<div>` | `pages/JobsPage.tsx` |
| 2 | `.panel` / `.form-row` 未定义 | 账号页两张表单、密钥页编辑抽屉全部换成已有的 `.card` / `.card-head` / `.card-body` / `.form-grid` | `pages/AccountsPage.tsx`、`pages/SecretsPage.tsx` |
| 3 | 没有修改密码入口 | 设置页新增「修改密码」卡片，接 `authApi.changePassword`，前端校验 ≥6 位 + 两次一致 + 不与旧密码相同；成功后清会话跳回登录页 | `pages/SettingsPage.tsx` |
| 4 | 概览页写 API 路径 | 改成实时状态徽标（实时 / 已断开）+ 暂停提示 | `pages/OverviewPage.tsx` |
| 5 | 两处压平的代码 | `ImportPage.tsx` 的 `run`、`SettingsPage.tsx` 的 `return (` 恢复缩进 | 同左 |

### 第二批 · 交互（6–8、12–14）

| # | 问题 | 改法 | 文件 |
|---|---|---|---|
| 6 | 一行五个按钮 | 行内只留「试运行 / 编辑」，发布·归档·删除收进 `⋯` 菜单（`RowMenu` 组件，点外部或 Esc 关闭），操作列 300px → 190px | `components/RowMenu.tsx`、`pages/EndpointsPage.tsx` |
| 7 | params 只能写 JSON | 新增 `ParamsEditor`：逐行表单（名称 / 位置 / 类型 / 必填 / 说明 / 密钥引用）+ 删除 + 添加，JSON 收进「高级」；JSON 不合法时自动回退到原始编辑并给提示 | `components/ParamsEditor.tsx`、`pages/EndpointsPage.tsx` |
| 8 | 平台鉴权要手写 authConfig | 按 `authKind` 渲染对应字段：bearer → 密钥名；header → 请求头名 + 密钥名；query → 参数名 + 密钥名；basic → 用户名 + 密码密钥名。密钥名带 `datalist` 联想已存的 vault 密钥；切方式时自动清理无关键 | `pages/PlatformsPage.tsx` |
| 12 | 枚举显示英文 | 新增 `ENDPOINT_STATUS_LABEL` / `AUTH_KIND_LABEL` / `AUTH_KIND_HINT` / `PARAM_LOCATION_LABEL` / `SIDE_EFFECT_LABEL` / `SENSITIVITY_LABEL` / `IMPORT_KIND_LABEL`，全部下拉改成中文 | `types.ts` + 各页 |
| 13 | 刷新 / 重新载入 / 重新加载 | 统一为「刷新」 | 概览、导入、设置 |
| 14 | 三个选项挤一行 + 默认真探测 | 拆成独立 `.options-row`，文案补全；`probeUpstream` 默认改 `false` | `pages/ImportPage.tsx` |

### 第三批 · 结构（9–11）

| # | 问题 | 改法 | 文件 |
|---|---|---|---|
| 9 | 工具页看不出上游是哪个接口 | 展开面板把 `endpointId` 换成上游接口 slug，并加「去接口资产里改」按钮（带 `?q=` 搜索词跳转） | `pages/ToolsPage.tsx` |
| 10 | 表格没分页没多选 | `DataTable` 新增 `pageSize` / `selectable` / `selectedKeys` / `onSelectionChange`：底部分页条、表头全选（支持半选态）、选中行高亮；接口页每页 20 条 + 批量发布 / 批量归档 / 取消选择 | `components/Table.tsx`、`pages/EndpointsPage.tsx` |
| 11 | 候选只能原样采纳 | 没有「编辑候选」后端接口，改为发布后原地给「去改」直达该接口的编辑抽屉（`#/endpoints?edit=<id>`），省掉「去接口页再搜一遍」 | `pages/JobsPage.tsx`、`pages/EndpointsPage.tsx` |

### P2 · 细节

| # | 问题 | 改法 |
|---|---|---|
| 15 | 表格字号小 | 正文 12px → 13px，表头 11.5px → 12px |
| 16 | 响应式只有 2 个断点 | 新增 `@media (max-width: 720px)`：侧栏变顶部横向滚动导航、内容区取消 `margin-left`、页头纵向排列 |
| 17 | 对话页必须先建会话 | 首次发送自动建会话（`skipLoad` 避免历史回拉冲掉乐观消息），输入框不再禁用 |
| 18 | 任务 ID 是 hash | 显示 `shortId()`，完整 id 放 `title`；格式列改中文 |
| 19 | 登录页常驻默认密码 | 只在成功登录前显示，登录成功或点「×」后写入 `localStorage` 不再出现 |
| 20 | 4 个死 CSS 类 | 删掉 `.token-bar` / `.token-label` / `.token-input` / `.token-state`（含 2 处媒体查询残留） |

### 顺带

- `useHashRoute` 只认路径部分，新增 `readHashQuery()`，支持 `#/endpoints?q=xxx` 与 `#/endpoints?edit=<id>` 两种深链。
- 新增 CSS：`.row-menu*`、`.params-editor*` / `.param-row*`、`.table-block` / `.select-col` / `.table-pager*`、`.bulk-bar*`、`.options-row`、`.login-tip-close`。

### 验收

- `npx tsc -p tsconfig.json` 通过
- `npm test` 217/217 通过
- `npx vite build` 通过，产物 CSS 内含上述新类、不含 `.token-*`


---

## 第三轮：用户实测反馈（P0/P1/P2）

### P0 · 必修

| # | 现象 | 根因 | 改法 | 文件 |
|---|---|---|---|---|
| 1 | 用户菜单关不掉，遮罩挡住整页，连用户按钮都点不到 | 菜单用一个 `position:fixed; inset:0; z-index:40` 的 `.menu-backdrop` 当点击层，它跟 `.topbar` 同级同层，把整个页面盖住了 | 删掉遮罩，改成 `menuRef` + 文档级 `mousedown`（点在 `user-area` 外才关）+ `Escape` 关闭；点按钮本身走 toggle | `App.tsx`、`styles.css` |
| 2 | 「修改密码」点了只关菜单，没有任何弹窗 | 菜单项只做了 `setMenuOpen(false)`，从来没有渲染改密弹窗 | 新增 `ChangePasswordDialog`（当前密码 / 新密码 ≥6 位 / 两次一致 / 不能与旧密码相同），接到菜单项上 | `components/ChangePasswordDialog.tsx`、`App.tsx` |
| 3 | 平台数在概览、平台列表、接口页下拉三处对不上，还会随别人写入变化 | 每个页面各自 `api.platforms.list()`，互不通知，写完也不失效 | 收成模块级 store：`refreshPlatforms()` / `invalidatePlatforms()` / `usePlatforms()`，所有写操作走 `bumpData()` 统一失效；切回标签页自动补拉 | `hooks.ts`、4 个页面 |

### P1 · 尽快

| # | 现象 | 改法 | 文件 |
|---|---|---|---|
| 4 | 概览实时流水初始「未连接」、一直转圈、最近请求是横线 | `streamAudit` 增加 `onOpen` 回调，响应头到手就算连上；断线按 1s→2s→4s→8s→15s 自动重连；失败时把原因写进卡片副标题 | `api.ts`、`pages/OverviewPage.tsx` |
| 5 | 整理记录 `done` 却显示 0%，候选一直转圈 | 进度列 `status==='done'` 直接 100%；候选加载加 15 秒超时 + 失败态 + 重试按钮 | `pages/JobsPage.tsx` |
| 6 | 写操作 `km_probe_keys_post` 显示成 GET，方法和读写属性矛盾 | 新增 `assertPublishable()`：`sideEffect=write` 却用 GET/HEAD/OPTIONS 一律 400；创建、更新、发布三个入口都拦，创建时先校验避免留孤儿草稿；列表上给这类行打「方法冲突」标 | `core/import/pipeline.ts`、`routes/admin.ts`、`pages/EndpointsPage.tsx` |
| 7 | `cacheTtl` 行内改值即时保存，误触风险 | 表格里只读展示（`30s` / `不缓存`），要改去编辑弹窗，点「保存」才生效 | `pages/ToolsPage.tsx` |
| 8 | 新建表单有示例预填，容易误提交 | 示例文案统一加 `例如：` 前缀；接口表单 `pathTemplate` 由 `/` 改为空，必须自己填 | 4 个页面 |
| 9 | MCP 配置给的是本地绝对路径 + 127.0.0.1 | `HUB_BASE_URL` 取当前站点 origin，`args` 用仓库相对路径 `apps/mcp/src/index.ts`，副标题说明工作目录不在仓库根时要改 | `pages/ToolsPage.tsx` |
| 10 | 概览标题说 LLM 未启用，设置页说已启用 | 概览的 health/stats/audit 都挂上 `useDataRev()`，设置页保存后 `bumpData()` | `pages/OverviewPage.tsx`、`pages/SettingsPage.tsx` |
| 11 | 归档后、建凭据后要手动刷新 | 写操作统一 `bumpData()`；新增窗口聚焦 / 页面可见时自动补拉 | `hooks.ts` |

### P2 · 细节

| # | 现象 | 改法 | 文件 |
|---|---|---|---|
| 12 | 账号表单冒英文报错 | `UsernameSchema` / 密码补中文 message（`String must contain at least 2 character(s)` 的来源）；再加 `localizeError()` 兜底把常见 zod 英文文案翻成中文，`errorMessage()` 统一走它 | `core/schema/asset.ts`、`hooks.ts`、`pages/AccountsPage.tsx` |
| 13 | 工具编辑弹窗的对外名字占位是无关示例 | 占位改成 `当前：<现有工具名>` | `pages/ToolsPage.tsx` |
| 14 | 工具开关请求中禁用时点一次没反转 | 改成乐观更新：先本地翻转，失败再 `reload()` 回滚 | `pages/ToolsPage.tsx` |
| 15 | LLM 未启用时发消息一直「生成中」约 2 分钟 | 进页面就查 `health.llm.enabled`，关闭时顶部横幅 + 直接拒发并提示去设置；发送后 30 秒无任何帧则主动断开并给出明确原因 | `pages/ChatPage.tsx` |

### 验收

- `npx tsc -p tsconfig.json` 通过
- `npm test` 246/246 通过
- `npx vite build` 通过；产物里 `menu-backdrop` 已消失，`.link` 存在
- 接口：`POST /api/endpoints` 传 `method=GET & sideEffect=write` → `400 inconsistent_side_effect`，且不落库；`method=POST & sideEffect=write`、`method=GET & sideEffect=read` 正常发布
### 顺带做的中期项

| 项 | 做法 | 文件 |
|---|---|---|
| 58 条规模没排序、没分页 | `DataTable` 加客户端排序：表头可点（升/降切换，空值沉底，中文按 `localeCompare('zh-Hans-CN', {numeric:true})`），`Column.sortable=false` 可关掉操作列；`defaultSort` 支持默认排序。接口/工具表补 `pageSize={20}`，审计表 `pageSize={50}` 并按时间倒序 | `components/Table.tsx`、5 个页面 |
| 审计失败率没分类没告警 | 审计页新增「失败原因」卡片：按 `errorCode`（无则 `http_状态码`）聚合计数与占比，点标签只看该类；失败率 ≥30% 时给黄色提示并点名最大的一类 | `pages/AuditPage.tsx` |
| 测试/探测数据混在生产里 | `scripts/cleanup-test-data.mjs` 重写：默认预演，`--apply` 才删；slug / 路径 / 平台名三条正则都可用环境变量覆盖，`CLEANUP_KEEP` 白名单；平台只在名下没有接口时才删。新增 `npm run cleanup:test` 与 `npm run cleanup:test:apply` | `scripts/cleanup-test-data.mjs`、`package.json` |

### 验收补充

- `npm test` 246/246 通过，`npx tsc` 通过，`npx vite build` 通过
- 服务端实际返回的 bundle 里能查到：`失败原因`、`清除筛选`、`点一下按这列排序`、`方法冲突`、`正在自动重连`、`不缓存`、`例如：github`、`至少需要`；CSS 里能查到 `.th-sort` / `.sort-caret` / `.reason-chip` / `.link`，且不再有 `menu-backdrop`
- `npm run cleanup:test` 预演正常退出（exit 0），只列命中项，不动数据
### 提交与部署

- 已提交 `517a41e`（本轮全部修复）与 `2bb5523`（在线更新脏检查忽略未跟踪文件），已推到 `origin/main`。
- `GET /api/update` 现在返回 `dirty:false / canUpdate:true / message:"已提交，可以检查更新"`，在线更新不再被永久禁用。
- 未跟踪的 `bug.txt`（另一个工作流的草稿）没有提交，也不再挡住更新。

### 本轮仍然没做的

- 整理记录里那条 2026-10-30 10:38:30 的历史记录本身没有被删（那是线上库里的旧数据），只修了「done 却显示 0%」的展示；线上用 `npm run cleanup:test:apply` 可以清掉探测残留。
- 平台 / 接口 / 密钥 / 令牌表单目前是「示例文案加前缀 + 关键字段置空 + 必填校验」，没有做成完全空白的空表单，因为 qps / daily / quota 这些字段有服务端默认值，清空反而要多一轮解释。
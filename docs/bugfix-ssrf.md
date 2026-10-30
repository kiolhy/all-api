# bug.txt 修复记录

三份报告、九个利用链，全部在本地源码修掉，并补了回归。
验收口径：不改变正常功能，只把"能被外部左右的目标地址"和"原样回显的上游响应"两件事管住。

---

## 一句话结论

| 报告 | 根因 | 修法 |
|---|---|---|
| ① 全响应 SSRF（平台/端点试运行） | 服务端按**用户可控地址**发请求，且把响应体原样回显 | 出网改由 `safeFetch` 统一代理：DNS 解析后按**地址**判定、连接锁 IP、不跟随跳转；试运行只回结构化摘要 |
| ② 匿名 `PUT /api/settings` → LLM 地址 SSRF + apiKey 外送 | 路由缺鉴权 + `chatJson` 裸 `fetch` 带 `Bearer` | 路由改 admin 级；`chatJson` 走 `safeFetch`，主机白名单 + 地址判定 |
| ③ 编码前缀绕过全局登录闸 | 鉴权看的是**原始字符串**，路由器看的是**解码后路径** | 新增 `normalizeRequestPath`：两侧用同一个归一化结果判定；无法归一化直接 400 |

---

## 三个新增的"地基"

### 1. `packages/core/src/security/egress.ts` — 地址级判定

原来的 `assertEgressAllowed` 只比对 **hostname 字面量**，漏掉了这些：

| 写法 | 实际指向 | 旧判定 |
|---|---|---|
| `2130706433` | 127.0.0.1 | 放行 ❌ |
| `0x7f.1` / `0177.0.0.1` / `127.1` | 127.0.0.1 | 放行 ❌ |
| `127.0.0.1.`（尾点） | 127.0.0.1 | 放行 ❌ |
| `http://evil.com@127.0.0.1/` | 127.0.0.1 | 放行 ❌ |
| `::ffff:127.0.0.1` | 127.0.0.1 | 放行 ❌ |
| `internal.example.com` | 10.0.0.5 | 放行 ❌ |
| `evil.com`（DNS 指向内网） | 内网 | 放行 ❌ |

现在：`normalizeObscureIpv4` 归一化各种写法，`lookup()` 解析出真实地址，
逐个按 CIDR 判定。**任何一个地址落入保留段就拒** —— 多 A 记录里挑一条内网的做法也堵住了。

保留段覆盖：`0/8`、`10/8`、`100.64/10`（含阿里云元数据 `100.100.100.200`）、`127/8`、
`169.254/16`（含 AWS/GCP 元数据 `169.254.169.254`）、`172.16/12`、`192.168/16`、
`192.0.0/24`、`192.0.2/24`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`224/4`、`240/4`，
以及 IPv6 的 `::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`2002::/16`（6to4）里嵌的 IPv4。

### 2. `packages/core/src/security/safe-fetch.ts` — 受控出网

这是本次最关键的改动：**服务端所有替用户发起的请求都改走它**。

```
校验 URL 形态 → DNS 解析 → 逐个地址判定 → 把连接锁到已校验的那个 IP → 不跟随重定向 → 超时/体积上限
```

"把连接锁到已校验 IP"这一步是防 DNS rebinding 的关键：
只校验一次域名的话，攻击者可以让第一次解析返回公网、第二次返回 `127.0.0.1`。
现在 `lookup` 被固定成已校验的地址，第二次解析根本不发生。

改造点：

| 文件 | 之前 | 现在 |
|---|---|---|
| `invoke/engine.ts` | 裸 `fetch` | `safeFetch` + `egressHostsFor(platform)` |
| `invoke/probe.ts` | 裸 `fetch` | `safeFetch` |
| `ai/client.ts` | 裸 `fetch`，带 `Bearer` | `safeFetch` + 主机白名单 |
| `import/site.ts` | 显式注释"不走 egress 检查" | `safeFetch`，逐跳校验 |
| `routes/admin.ts` 平台试运行 | 裸 `fetch` | `safeFetch` |

私网放行需要**双重条件**：调用方传 `allowPrivate: true` **且** 服务端
`ALLOW_PRIVATE_EGRESS=true`。任一处忘写都不会意外打开内网。

### 3. `packages/core/src/security/dry-run.ts` — 试运行不回显

真实事故里最要命的一条：试运行把上游响应体原样吐回去，包括 **401 的错误 JSON**
和**整套控制台 HTML**。配上"能指向任意地址"，盲测直接变成全响应读取。

现在按状态分治：

- **2xx**：只回结构摘要（键名 + 类型 + 160 字符短预览，最多 4 层）
- **非 2xx**：**一个字节的 body 都不回**，只给状态码 + 稳定错误码
  （错误体里恰恰是内部鉴权结构、版本号、堆栈）
- **HTML**：只回"这是一个页面"，不回正文（控制台 HTML 会暴露路由和版本）
- **非控制台通道**：连摘要都不给 —— 令牌持有者本就不该看到上游真实数据

---

## 逐条修复

### ① SSRF via 平台/端点试运行

1. **`POST /api/platforms/{id}/test`、`POST /api/endpoints/{id}/test`**
   - 加了 `requireAdminAccount`（路由规则表里也归为 admin 级）
   - 出网走 `safeFetch`
   - 响应改 `buildDryRunView`，不再回显
   - 两次试运行都写审计（`actor` + `upstreamHost`），能回溯"谁在往哪儿打"

2. **`allowPrivate` 不再由请求体决定**
   - `enforceEgressPolicy()`：服务端没开 `ALLOW_PRIVATE_EGRESS` 就强制 `false`
   - `baseUrl` 指向本机/内网、或 `egressAllowHosts` 里出现本地地址 → **保存时直接拒**
     （`egress_private_blocked`）
   - 保存时的静态检查只是第一道；真正的防护在运行时地址判定 ——
     DNS rebinding 只能靠后者

3. **第二个入口：`POST /api/import`**
   - `pipeline.ts` 不再 `allowPrivate: isLocalHost(...)`，一律 `false`
   - 需要内网的场景由管理员在平台页显式打开
   - `fetchSiteInfo` 默认拒绝私网；只有平台已被授权时才抓私网首页

4. **自定义 method/header 伪造来源**
   - 新增 `FORBIDDEN_HEADERS`：`host`、`x-forwarded-for`、`x-real-ip`、
     `x-forwarded-host`、`forwarded`、`via`、`content-length`、`transfer-encoding` 等
   - 端点定义、平台 `defaultHeaders`、调用方 `header_*` 三个入口统一拦截
   - 顺序有讲究：**先**拦危险头，**再**校验参数声明。
     否则 `header_x-forwarded-for` 会先报 `unknown_arg`，
     让人误以为"补个声明就能用"

### ② 匿名改 LLM 配置 → apiKey 外送

- `PUT /api/settings` 改 `requireAdminAccount`，写审计
- `isValidLlmBaseUrl` 收紧：`LLM_ALLOWED_HOSTS` 配了就是严格白名单；
  没配时私网主机要 `LLM_ALLOW_PRIVATE=true`
  （注意：**不**把它默认成"当前 baseUrl 的 host"，否则设置页永远改不了地址）
- `chatJson` 改走 `safeFetch`：主机白名单 + 地址判定 + 超时/体积上限
- 出网被拒时不重试、不透出内网可达性，错误里也不带密钥

### ③ 编码前缀绕过登录闸

新增 `packages/core/src/security/path-normalize.ts`：

- 先去 query/fragment
- **解码前**就拒绝 `%2f` / `%5c`（否则 `/api%2Faccounts` 会变成 `/api/accounts`）
- 只做**一次** `decodeURIComponent`，多重编码直接拒
- 拒绝 NUL / 控制字符 / 反斜杠 / 解码后出现的 `?` `#`
- 折叠 `//`、丢弃 `.` 和 `;param`、解析 `..`、统一小写

`app.ts` 里鉴权用的路径和路由用的路径现在是**同一个归一化结果**；
无法归一化的路径当场 400，不再"路由认得、鉴权没认出"。

---

## 顺手修掉的两个真问题

### `safeFetch` 的私网开关读错了配置源

第一版读 `process.env.ALLOW_PRIVATE_EGRESS`，而配置来自 `.env` 文件，
两者不一致时会**悄悄把私网关掉**，症状是莫名其妙的 `egress_private_blocked`，
排查方向完全跑偏。改成 `loadConfig().allowPrivateEgress`，单一事实来源。

### 端口冲突被误当成"服务已在运行"

`verify.mjs` 原来只用 `r.ok` 判断上游是否活着。本机 8899 常被外部软件占用
（这次撞上的是小米音频共享，返回裸 TCP），于是脚本以为"已在运行，复用"，
拿一个完全无关的服务跑验收，报出一堆假失败。

现在要求响应能解析成预期 JSON 形状，不是就当"没跑"，让 spawn 去撞端口冲突、
把问题当场暴露出来；假上游默认端口也换成不常见的 `18899`（可用 `MOCK_PORT` 覆盖）。

---

## 回归

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `npx tsc -p tsconfig.json` | 类型 | 干净 |
| `npm test` | 246 个单测（新增 `ssrf.test.ts` 27 个） | 全部通过 |
| `npm run verify` | 类型 + 单测 + 前端构建 + 冒烟 51 + 批量导入 16 + 批量预览 + AI 链路 32 | 全部通过 |
| `npm run verify:security` | 35 条攻击重放 | 全部拦住 |
| `npm run audit:leaks` | 落盘明文扫描 | 未发现 |

`packages/core/test/ssrf.test.ts` 按报告里的每条利用路径写的，改坏了就会红：

- 多写法 IP / 保留段 / 本地主机名 / 尾点 / userinfo / 非常规协议
- 平台试运行、`allowPrivate=true` 但服务端关闭、控制台通道 —— 三种都打不到内网
- 端点定义与调用方注入 `x-forwarded-for` / `host` 被拒，普通自定义头不受影响
- 非 2xx 不带样本、2xx 只给摘要、非控制台连摘要都没有
- `fetchSiteInfo` 默认拒私网、显式允许时仍可用
- `chatJson` 对私网 baseUrl / 白名单外主机直接失败且不发请求
- `safeFetch` 不跟随 3xx、连接锁 IP（Host 头保持原样）、响应体截断

`scripts/security-regression.mjs` 新增第 3 段，在**真实实例**上重放：
指向 `127.0.0.1` 的平台被拒、五种内网写法被拒、试运行不回显、
导入私网 curl 不产生 `allowPrivate` 平台、`llm.baseUrl` 指向本机被拒、
端点里的 `x-forwarded-for` 调用时报 `header_forbidden`。

---

## 部署后要做的（代码之外）

1. **轮换凭据**：报告里点名的 `claude_wire_admin_cookie`、`infolooper_cookie`、
   LLM apiKey、`apiKeyId=ak_f6df9c734c804185aed4` 都应按已泄露处理
2. **清理残留对象**：平台 `pf_b45604df7eec4ed3b5b4`，
   端点 `ep_67bb413c4f9b49d088b8` / `ep_283115d72a6d43d284c7` / `ep_1bb15f0a35734f6bb050`
3. **确认线上开关**：`ALLOW_PRIVATE_EGRESS` 与 `LLM_ALLOW_PRIVATE` 保持关闭；
   `LLM_ALLOWED_HOSTS` 按实际模型地址配白名单
4. 跑一次 `npm run audit:leaks`，确认历史响应里没落下明文

> 说明：本机 `.env` 里 `ALLOW_PRIVATE_EGRESS=true` 是本地开发/验收需要
> （假上游在 `127.0.0.1`）。生产必须关掉，否则上面一半的防护形同虚设。

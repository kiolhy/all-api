/**
 * 已泄露检测 / 服务端策略校验的小工具。
 *
 * 放在一起是因为它们服务于同一个目标：**密文之外不留明文**。
 */

import { secrets } from '../db/repos.ts';
import { decryptSecret } from '../secrets/vault.ts';
import { loadConfig } from '../config.ts';
import { isPrivateHost } from '../invoke/guard.ts';

/**
 * 把 vault 里所有密钥明文读出来，用于"写入侧检测"。
 *
 * 只在服务端内部使用（比较文本里是否包含密钥明文），不外传。
 * 为什么不用指纹：写入侧要能判断"用户是不是把密钥原样贴进来了"，
 * 这需要完整明文做子串匹配；指纹只适合做"不给明文也能识别"的输出侧兜底。
 */
export function knownSecretPlaintexts(): string[] {
  const names = secrets.list().map((s) => s.name);
  const out: string[] = [];
  for (const name of names) {
    const blob = secrets.getCipher(name);
    if (!blob) continue;
    try {
      out.push(decryptSecret(blob));
    } catch {
      /* 主密钥换了之类的：跳过，不能因为一条坏数据让整条链路挂掉 */
    }
  }
  return out;
}

/**
 * 允许 LLM 出网的域名白名单（环境变量 LLM_ALLOWED_HOSTS，逗号分隔）。
 *
 * 刻意**不**拿"当前配置里的 baseUrl"当默认白名单：
 * 那样设置页就永远改不了主机（改谁都被拒），等于把正常功能焊死。
 * 走白名单是运维的显式选择；不配白名单时，靠"禁私网"这一条兜住主要风险。
 */
function llmAllowedHosts(): string[] {
  const env = process.env.LLM_ALLOWED_HOSTS;
  if (!env || !env.trim()) return [];
  return env
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 允许非标准端口 / 私网的显式开关。
 *
 * 真实场景里有人把模型跑在局域网（局域网 llama.cpp、Ollama）。
 * 那就必须由运维显式声明「我允许 LLM 走私网」，而不是任何一次
 * `PUT /api/settings` 都能自己决定 —— 后者正是报告里让人担心的点。
 */
function llmPrivateAllowed(): boolean {
  return process.env.LLM_ALLOW_PRIVATE === 'true';
}

/**
 * LLM baseUrl 校验。
 *
 * 真实事故：`PUT /api/settings` 无鉴权，`llm.baseUrl` 可改成任意主机，
 * 对话管线会无条件把 `Authorization: Bearer <已存 apiKey>` 发过去 ——
 * 等于给攻击者一个"一键拿走 LLM key"的通道。
 *
 * 现在按三层收口：
 *   1. 必须是 http(s)、有主机名
 *   2. 配了 LLM_ALLOWED_HOSTS 就严格按白名单（生产推荐）
 *   3. 没配白名单时，私网地址必须由运维开 LLM_ALLOW_PRIVATE 才放行
 *
 * 注意这里**不**限制端口：自建模型服务常用非标准端口，
 * 而这个函数防的是"去别人的机器拿 key"，不是"奇怪端口"。
 */
export function isValidLlmBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'baseUrl 不是合法的 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'LLM baseUrl 只支持 http/https';
  if (!url.hostname) return 'LLM baseUrl 缺少主机名';

  const host = url.hostname.toLowerCase();
  const allowed = llmAllowedHosts();
  if (allowed.length) {
    return allowed.includes(host) ? null : `LLM baseUrl 主机 ${host} 不在允许列表内（${allowed.join(', ')}）`;
  }
  if (isPrivateHost(host) && !llmPrivateAllowed()) {
    return `LLM baseUrl 不允许指向私网地址 ${host}（需要时设置 LLM_ALLOW_PRIVATE=true）`;
  }
  return null;
}

/**
 * 服务端 egress 策略：allowPrivate 只认环境变量，不认请求体。
 */
export function serverAllowsPrivateEgress(): boolean {
  return process.env.ALLOW_PRIVATE_EGRESS === 'true';
}

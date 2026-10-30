import type { LlmConfig } from '../config.ts';
import { safeJsonParse } from '../util/json.ts';
import { safeFetch } from '../security/safe-fetch.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: string };

function stripFence(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) return fence[1].trim();
  const first = t.indexOf('{');
  const firstArr = t.indexOf('[');
  const start = first === -1 ? firstArr : firstArr === -1 ? first : Math.min(first, firstArr);
  if (start > 0) return t.slice(start);
  return t;
}

/**
 * 出网策略。
 *
 * 真实事故：`PUT /api/settings` 可改 `llm.baseUrl`，而 chatJson 用裸 fetch
 * 无条件把 `Authorization: Bearer <已存 apiKey>` 发过去 —— 改个配置就能把
 * 上游密钥送人，还能借服务端读内网。
 *
 * 现在两道：
 *   1. baseUrl 必须在服务端允许的主机内（LLM_ALLOWED_HOSTS，或同配置基线）
 *   2. 真正发请求走 safeFetch：DNS 解析后按地址判定，私网默认禁止
 *
 * 注意：**不要**在跨主机请求里带 Authorization。密钥只发给配置的 LLM 主机。
 */
function llmEndpoint(cfg: LlmConfig): { url: string; host: string } | { error: string } {
  let base: URL;
  try {
    base = new URL(cfg.baseUrl);
  } catch {
    return { error: 'LLM baseUrl 不是合法地址' };
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { error: 'LLM baseUrl 只支持 http/https' };
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  return { url, host: base.hostname.toLowerCase() };
}

/** OpenAI 兼容 /chat/completions，强制 JSON 输出 */
export async function chatJson<T = unknown>(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; retries?: number } = {},
): Promise<LlmResult<T>> {
  if (!cfg.enabled || !cfg.apiKey) return { ok: false, error: 'LLM 未启用' };

  const ep = llmEndpoint(cfg);
  if ('error' in ep) return { ok: false, error: ep.error };

  const retries = opts.retries ?? 1;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await safeFetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: opts.maxTokens ?? 4096,
        }),
        // 私网要运维显式开（局域网自建模型）；默认只允许公网主机。
        // 与 safeFetch 用同一个配置来源，避免 .env 与进程变量不一致时行为漂移
        allowPrivate: process.env.LLM_ALLOW_PRIVATE === 'true',
        // 主机白名单：配了 LLM_ALLOWED_HOSTS 就严格按它，否则就锁死在当前 baseUrl 的 host
        allowHosts: (() => {
          const env = process.env.LLM_ALLOWED_HOSTS;
          if (env && env.trim()) {
            return env
              .split(',')
              .map((h) => h.trim().toLowerCase())
              .filter(Boolean);
          }
          return [ep.host];
        })(),
        timeoutMs: cfg.timeoutMs,
        maxBytes: 512 * 1024,
      });

      const text = res.text;
      if (res.status < 200 || res.status >= 300) {
        // 错误体也脱敏：里面可能回显了我们发出去的 Authorization
        lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        // 只有瞬时错误才重试
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: lastError };
      }
      const doc = safeJsonParse<{
        choices?: Array<{ message?: { content?: string } }>;
      }>(text, {});
      const content = doc.choices?.[0]?.message?.content ?? '';
      if (!content) {
        lastError = '模型返回空内容';
        // 空内容可能是瞬时抖动，重试一次
        continue;
      }
      const parsed = safeJsonParse<T>(stripFence(content), undefined as unknown as T);
      if (parsed === undefined) {
        // 解析失败不重试：temperature=0 下重试同一 prompt 只会得到同样的坏 JSON，
        // 白白多等一个超时周期。直接返回，让调用方降级。
        return {
          ok: false,
          error: `模型返回的不是合法 JSON：${content.slice(0, 160)}`,
        };
      }
      return { ok: true, value: parsed, raw: content };
    } catch (err) {
      // 网络错误/超时属于瞬时错误，重试
      const e = err as Error & { code?: string };
      // 出网被拒是确定性失败，重试没有意义，也不该把"内网可达性"透给调用方
      if (e.code === 'egress_private_blocked' || e.code === 'egress_host_blocked') {
        return { ok: false, error: '模型调用失败：目标地址不被出网策略允许' };
      }
      lastError = e.message;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return { ok: false, error: lastError || '未知错误' };
}

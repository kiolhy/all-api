import type { LlmConfig } from '../config.ts';
import { safeJsonParse } from '../util/json.ts';

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

/** OpenAI 兼容 /chat/completions，强制 JSON 输出 */
export async function chatJson<T = unknown>(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; retries?: number } = {},
): Promise<LlmResult<T>> {
  if (!cfg.enabled || !cfg.apiKey) return { ok: false, error: 'LLM 未启用' };

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const retries = opts.retries ?? 1;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
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
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
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
      lastError = (err as Error).message;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError || '未知错误' };
}

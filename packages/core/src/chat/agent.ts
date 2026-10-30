import type { LlmConfig } from '../config.ts';
import type { ToolRecord } from '../schema/asset.ts';
import { chats, endpoints, tools } from '../db/repos.ts';
import { chatJson } from '../ai/client.ts';
import { invokeTool } from '../invoke/engine.ts';
import { previewOf } from '../invoke/transform.ts';
import { scrubAll, scrubDeep } from '../invoke/redact.ts';

export type ChatEvent =
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; ok: boolean; preview: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

const MAX_STEPS = 4;

function toolCatalog(list: ToolRecord[]): string {
  return list
    .map(
      (t) =>
        `- ${t.name}｜${t.title || t.endpointSlug}\n  说明：${t.description.replace(/\n/g, ' ').slice(0, 220)}\n  入参 schema：${JSON.stringify(
          t.inputSchema,
        ).slice(0, 900)}`,
    )
    .join('\n');
}

function systemPrompt(list: ToolRecord[]): string {
  return `你是「接口资产中枢」的调用助手。你可以调用一组已经整理好的、脱敏的第三方平台接口来回答用户问题。

可用工具：
${toolCatalog(list)}

工作方式（严格遵守）：
- 每次只输出一个 JSON 对象，不要输出多余文字，不要用 markdown 代码块。
- 需要调接口时：{"action":"call","tool":"工具名","args":{"参数名":值}}
- 已经能回答时：{"action":"final","answer":"中文回答"}
- 最多连续调用 ${MAX_STEPS} 次工具；拿到结果后应尽快给 final。
- args 必须符合该工具的入参 schema，不要传未声明的参数；不要尝试传 token、密钥、cookie。
- 如果没有任何工具能满足需求，直接 final 说明缺少什么接口。
- 回答用简体中文，尽量把关键数据列出来，不要编造。`;
}

/** 一次对话推进：模型 → 工具 → 模型 … 直到 final，逐步 yield 事件 */
export async function* runChat(
  cfg: LlmConfig,
  sessionId: string,
  userContent: string,
): AsyncGenerator<ChatEvent> {
  // 站内对话只使用"对外开放"的工具：closed 与 restricted 不进入 AI 视野
  const eps = new Map(endpoints.list({ status: 'published' }).map((e) => [e.id, e]));
  const list = tools.list({ enabledOnly: true }).filter((t) => {
    const ep = eps.get(t.endpointId);
    return ep ? ep.exposure === 'open' : false;
  });
  if (!list.length) {
    const msg = '当前没有对外开放的接口工具。请先在「一键整理」里导入接口、发布，并把开放策略设为「公开」。';
    const id = chats.addMessage({ sessionId, role: 'assistant', content: msg });
    yield { type: 'delta', text: msg };
    yield { type: 'done', messageId: id };
    return;
  }

  chats.addMessage({ sessionId, role: 'user', content: userContent });

  const history = chats
    .listMessages(sessionId, 40)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt(list) },
    ...history.slice(-12),
  ];

  let answer = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await chatJson<{
      action?: string;
      tool?: string;
      args?: Record<string, unknown>;
      answer?: string;
    }>(cfg, messages, { maxTokens: 1500 });

    if (!res.ok) {
      const err = `模型调用失败：${res.error}`;
      chats.addMessage({ sessionId, role: 'assistant', content: err });
      yield { type: 'error', message: err };
      return;
    }

    const decision = res.value;
    if (decision.action === 'call' && decision.tool) {
      const args = (decision.args ?? {}) as Record<string, unknown>;
      yield { type: 'tool_call', tool: decision.tool, args: scrubDeep(args) as Record<string, unknown> };
      chats.addMessage({
        sessionId,
        role: 'assistant',
        content: '',
        toolCalls: [{ tool: decision.tool, args }],
      });

      // 对话通道用 'chat'（不是 console）：开放策略照常校验，
      // 且这个通道解析出的密钥明文不进会话历史 —— 落库前统一 scrubAll。
      const result = await invokeTool(decision.tool, args, 'chat');
      const preview = scrubAll(previewOf(result.data, 1500));
      yield { type: 'tool_result', tool: decision.tool, ok: result.ok, preview };
      chats.addMessage({
        sessionId,
        role: 'tool',
        content: preview,
        toolResult: { tool: decision.tool, ok: result.ok, status: result.status },
      });

      messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      messages.push({
        role: 'user',
        content: `工具 ${decision.tool} 的执行结果（ok=${result.ok}, status=${result.status}）：\n${preview}`,
      });
      continue;
    }

    answer = decision.answer?.trim() || '（模型未给出回答）';
    break;
  }

  if (!answer) answer = '（已达到工具调用上限，请补充更明确的问题）';

  // 模型有可能把工具结果里的敏感串原样复述出来，落库前再兜一层
  answer = scrubAll(answer);
  const messageId = chats.addMessage({ sessionId, role: 'assistant', content: answer });
  const chunks = answer.match(/[\s\S]{1,40}/g) ?? [answer];
  for (const c of chunks) yield { type: 'delta', text: c };
  yield { type: 'done', messageId };
}

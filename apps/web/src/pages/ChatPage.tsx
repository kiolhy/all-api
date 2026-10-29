import { useEffect, useRef, useState } from 'react';
import { api, streamChatMessage } from '../api.ts';
import { Badge, OkBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox, Loading } from '../components/Empty.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { ConfirmDialog } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatTime, safeStringify } from '../format.ts';
import { errorMessage, useDataRev, useResource } from '../hooks.ts';
import type { ChatMessage, ChatSession, ChatToolCall } from '../types.ts';

function extractToolCalls(raw: Record<string, unknown>): ChatToolCall[] {
  const source = raw.toolCalls ?? raw.tool_calls;
  if (!Array.isArray(source)) return [];
  const calls: ChatToolCall[] = [];
  source.forEach((item, index) => {
    const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name =
      typeof obj.tool === 'string'
        ? obj.tool
        : typeof obj.name === 'string'
          ? obj.name
          : `tool_${index}`;
    calls.push({
      tool: name,
      args: obj.args,
      ok: typeof obj.ok === 'boolean' ? obj.ok : undefined,
      preview: typeof obj.preview === 'string' ? obj.preview : undefined,
    });
  });
  return calls;
}

function normalizeMessage(raw: unknown, index: number): ChatMessage {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const role =
    typeof obj.role === 'string'
      ? obj.role
      : typeof obj.author === 'string'
        ? obj.author
        : 'assistant';

  let content = '';
  if (typeof obj.content === 'string') content = obj.content;
  else if (Array.isArray(obj.content)) {
    content = obj.content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>;
        return typeof p.text === 'string' ? p.text : '';
      })
      .join('');
  } else if (typeof obj.text === 'string') {
    content = obj.text;
  }

  return {
    id: typeof obj.id === 'string' ? obj.id : `m-${index}`,
    role,
    content,
    toolCalls: extractToolCalls(obj),
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
  };
}

export function ChatPage() {
  const toast = useToast();
  const rev = useDataRev();
  const sessions = useResource(() => api.chat.sessions(), [rev]);

  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);
  const [deleting, setDeleting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeId && sessions.data && sessions.data.length > 0) {
      setActiveId(sessions.data[0].id);
    }
  }, [sessions.data, activeId]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let alive = true;
    setMessagesLoading(true);
    setMessagesError(null);
    api.chat
      .messages(activeId)
      .then((list) => {
        if (!alive) return;
        const normalized = Array.isArray(list)
          ? list.map((item, index) => normalizeMessage(item, index))
          : [];
        setMessages(normalized);
        setMessagesLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setMessagesError(errorMessage(err));
        setMessagesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const createSession = async () => {
    setCreating(true);
    try {
      const created = await api.chat.createSession();
      toast.success('新会话已创建');
      sessions.reload();
      setActiveId(created.id);
      setMessages([]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const deleteSession = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.chat.deleteSession(pendingDelete.id);
      toast.success('会话已删除');
      if (pendingDelete.id === activeId) {
        setActiveId('');
        setMessages([]);
      }
      setPendingDelete(null);
      sessions.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    if (!activeId) {
      toast.error('先新建一个会话');
      return;
    }

    setInput('');
    setSending(true);
    const stamp = Date.now();
    const userId = `local-user-${stamp}`;
    const assistantId = `local-assistant-${stamp}`;

    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content, createdAt: new Date().toISOString() },
      { id: assistantId, role: 'assistant', content: '', toolCalls: [] },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatMessage(
        activeId,
        content,
        (event) => {
          if (event.type === 'delta') {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + (event.text ?? '') }
                  : message,
              ),
            );
            return;
          }
          if (event.type === 'tool_call') {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      toolCalls: [
                        ...(message.toolCalls ?? []),
                        { tool: event.tool ?? 'tool', args: event.args },
                      ],
                    }
                  : message,
              ),
            );
            return;
          }
          if (event.type === 'tool_result') {
            setMessages((prev) =>
              prev.map((message) => {
                if (message.id !== assistantId) return message;
                const calls = [...(message.toolCalls ?? [])];
                for (let i = calls.length - 1; i >= 0; i -= 1) {
                  if (calls[i].tool === event.tool && calls[i].ok === undefined) {
                    calls[i] = { ...calls[i], ok: event.ok ?? true, preview: event.preview };
                    break;
                  }
                }
                return { ...message, toolCalls: calls };
              }),
            );
            return;
          }
          if (event.type === 'error') {
            const text = event.message ?? '未知错误';
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: `${message.content}${message.content ? '\n\n' : ''}[错误] ${text}` }
                  : message,
              ),
            );
            toast.error(text);
          }
        },
        controller.signal,
      );
    } catch (err) {
      const text = errorMessage(err);
      toast.error(text);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content || `[请求失败] ${text}` }
            : message,
        ),
      );
    } finally {
      abortRef.current = null;
      setSending(false);
      sessions.reload();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    toast.info('已停止生成');
  };

  const activeSession = (sessions.data ?? []).find((item) => item.id === activeId) ?? null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">对话</h1>
          <div className="page-sub">站内 AI 调试：直接让它调工具，工具调用会渲染成卡片</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => sessions.reload()}>
            刷新会话
          </button>
          <button type="button" className="btn primary" onClick={() => void createSession()} disabled={creating}>
            {creating ? '创建中…' : '新建会话'}
          </button>
        </div>
      </header>

      <div className="chat-layout">
        <aside className="card session-panel">
          <div className="card-head">
            <div className="card-title">会话</div>
            <div className="card-sub">{(sessions.data ?? []).length} 个</div>
          </div>
          <div className="session-list">
            {sessions.error ? <ErrorBox message={sessions.error} onRetry={sessions.reload} /> : null}
            {sessions.loading && !sessions.data ? <Loading /> : null}
            {!sessions.loading && (sessions.data ?? []).length === 0 ? (
              <div className="session-empty dim small">还没有会话，点右上角「新建会话」。</div>
            ) : null}
            {(sessions.data ?? []).map((session) => (
              <div
                key={session.id}
                className={`session-item${session.id === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(session.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setActiveId(session.id);
                }}
              >
                <div className="session-title">{session.title || '未命名会话'}</div>
                <div className="session-meta">
                  <span className="mono dim small">{formatTime(session.updatedAt)}</span>
                  <button
                    type="button"
                    className="btn tiny danger-ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDelete(session);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className="card chat-panel">
          <div className="card-head">
            <div className="card-title">{activeSession?.title || '对话'}</div>
            <div className="card-sub mono dim">{activeId || '未选择会话'}</div>
          </div>

          <div className="messages">
            {messagesError ? <ErrorBox message={messagesError} /> : null}
            {messagesLoading ? <Loading label="加载消息…" /> : null}
            {!messagesLoading && messages.length === 0 ? (
              <Empty
                title={activeId ? '开始对话' : '先新建一个会话'}
                hint={
                  activeId
                    ? '试试：「列出所有已发布的工具，并调用其中一个看看返回」。'
                    : '点右上角「新建会话」，然后在下方输入框提问。'
                }
              />
            ) : null}

            {messages.map((message) => {
              const isUser = message.role === 'user';
              const toolCalls = message.toolCalls ?? [];
              return (
                <div key={message.id} className={`msg ${isUser ? 'user' : 'assistant'}`}>
                  <div className="msg-role">
                    <span>{isUser ? '我' : 'AI'}</span>
                    {message.createdAt ? (
                      <span className="mono dim small">{formatTime(message.createdAt)}</span>
                    ) : null}
                  </div>
                  <div className="bubble">
                    {toolCalls.length > 0 ? (
                      <div className="tool-calls">
                        {toolCalls.map((call, index) => (
                          <div
                            key={`${message.id}-tool-${index}`}
                            className={`tool-card${call.ok === false ? ' failed' : ''}`}
                          >
                            <div className="tool-card-head">
                              <span className="mono strong">{call.tool}</span>
                              {call.ok === undefined ? (
                                <Badge tone="gray">执行中…</Badge>
                              ) : (
                                <OkBadge ok={call.ok} />
                              )}
                            </div>
                            <pre className="tool-args mono">{safeStringify(call.args)}</pre>
                            {call.preview ? (
                              <JsonView value={call.preview} label="结果预览" collapsed maxHeight={180} />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {message.content ? (
                      <div className="bubble-text">{message.content}</div>
                    ) : sending && !isUser ? (
                      <span className="typing">
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="composer">
            <textarea
              className="textarea mono composer-input"
              rows={3}
              value={input}
              placeholder={activeId ? 'Enter 发送，Shift+Enter 换行' : '先新建会话…'}
              disabled={!activeId || sending}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-actions">
              <span className="dim small">{sending ? '生成中…' : 'Enter 发送 · Shift+Enter 换行'}</span>
              {sending ? (
                <button type="button" className="btn ghost" onClick={stop}>
                  停止
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary"
                onClick={() => void send()}
                disabled={!activeId || sending || !input.trim()}
              >
                发送
              </button>
            </div>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话"
        danger
        confirmLabel="删除"
        busy={deleting}
        message={
          <span>
            确认删除会话 <b className="mono">{pendingDelete?.title || pendingDelete?.id}</b>？消息记录会一起清掉。
          </span>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void deleteSession()}
      />
    </>
  );
}

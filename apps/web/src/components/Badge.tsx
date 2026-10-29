import type { ReactNode } from 'react';

export type Tone = 'gray' | 'green' | 'blue' | 'red' | 'orange' | 'purple';

export function Badge({
  tone = 'gray',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const upper = (method || 'GET').toUpperCase();
  const tone: Tone =
    upper === 'GET'
      ? 'green'
      : upper === 'POST'
        ? 'blue'
        : upper === 'DELETE'
          ? 'red'
          : upper === 'PATCH'
            ? 'orange'
            : 'gray';
  return (
    <span className={`method method-${upper.toLowerCase()} tone-${tone}`}>{upper}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: Tone; label: string }> = {
    draft: { tone: 'gray', label: '草稿' },
    published: { tone: 'green', label: '已发布' },
    archived: { tone: 'orange', label: '已归档' },
  };
  const item = map[status] ?? { tone: 'gray' as Tone, label: status || '未知' };
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

export function DiffBadge({ kind }: { kind: string }) {
  const map: Record<string, { tone: Tone; label: string }> = {
    new: { tone: 'green', label: '新增' },
    modified: { tone: 'blue', label: '变更' },
    conflict: { tone: 'red', label: '冲突' },
    duplicate: { tone: 'orange', label: '重复' },
  };
  const item = map[kind] ?? { tone: 'gray' as Tone, label: kind };
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

export function OkBadge({ ok }: { ok: boolean }) {
  return <Badge tone={ok ? 'green' : 'red'}>{ok ? '成功' : '失败'}</Badge>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  const map: Record<string, Tone> = {
    rest: 'blue',
    mcp: 'purple',
    chat: 'green',
    console: 'gray',
  };
  return <Badge tone={map[channel] ?? 'gray'}>{channel}</Badge>;
}

export function CodeBadge({ children }: { children: ReactNode }) {
  return <span className="code-badge mono">{children}</span>;
}

export function ExposureBadge({
  exposure,
  allowedCount,
}: {
  exposure: string;
  allowedCount?: number;
}) {
  const map: Record<string, { tone: Tone; label: string }> = {
    open: { tone: 'green', label: '公开' },
    restricted: { tone: 'orange', label: '指定令牌' },
    closed: { tone: 'gray', label: '关闭' },
  };
  const item = map[exposure] ?? { tone: 'gray' as Tone, label: exposure || '未知' };
  const extra =
    exposure === 'restricted' && typeof allowedCount === 'number' ? ` (${allowedCount})` : '';
  return (
    <Badge tone={item.tone}>
      {item.label}
      {extra}
    </Badge>
  );
}

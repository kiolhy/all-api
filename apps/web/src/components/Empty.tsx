import type { ReactNode } from 'react';

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        ⌗
      </div>
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <div className="error-box-title">请求失败</div>
      <div className="error-box-text">{message}</div>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

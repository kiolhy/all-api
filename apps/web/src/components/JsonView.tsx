import { useState } from 'react';
import type { ReactNode } from 'react';
import { copyText, safeStringify } from '../format.ts';

export function JsonView({
  value,
  label,
  maxHeight,
  collapsed = false,
  onCopied,
}: {
  value: unknown;
  label?: ReactNode;
  maxHeight?: number;
  collapsed?: boolean;
  onCopied?: (ok: boolean) => void;
}) {
  const [open, setOpen] = useState(!collapsed);
  const text = safeStringify(value);

  return (
    <div className="json-view">
      <div className="json-head">
        <button type="button" className="btn ghost sm" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
          {label ? <span className="json-label">{label}</span> : null}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            void copyText(text).then((ok) => onCopied?.(ok));
          }}
        >
          复制
        </button>
      </div>
      {open ? (
        <pre className="json mono" style={maxHeight ? { maxHeight } : undefined}>
          {text}
        </pre>
      ) : null}
    </div>
  );
}

export function InlineJson({ value }: { value: unknown }) {
  return <code className="mono inline-json">{safeStringify(value)}</code>;
}

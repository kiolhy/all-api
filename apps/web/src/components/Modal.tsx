import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface OverlayProps {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

function useEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export function Modal({ open, title, subtitle, onClose, children, footer, width }: OverlayProps) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-heading">
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, title, subtitle, onClose, children, footer, width }: OverlayProps) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div
      className="overlay overlay-right"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="drawer"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <div className="modal-heading">
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, message, confirmLabel, danger, busy, onCancel, onConfirm, children } = props;
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={460}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? 'btn danger' : 'btn primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : (confirmLabel ?? '确认')}
          </button>
        </>
      }
    >
      <div className="confirm-text">{message}</div>
      {children}
    </Modal>
  );
}

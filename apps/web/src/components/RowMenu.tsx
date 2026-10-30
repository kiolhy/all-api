import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** 危险操作（删除/归档）走红色 */
  danger?: boolean;
  disabled?: boolean;
  /** 悬停提示，解释为什么禁用 */
  hint?: string;
}

/**
 * 表格行尾的「⋯」菜单。
 * 行内只留一个主操作，其余收进来，避免一行挤五个按钮。
 */
export function RowMenu({ items, label = '⋯' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="row-menu" ref={ref}>
      <button
        type="button"
        className="btn sm ghost row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多操作"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className="row-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'row-menu-item danger' : 'row-menu-item'}
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

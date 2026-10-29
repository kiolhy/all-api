import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Tone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}

export interface ToastApi {
  push: (text: string, tone?: Tone) => void;
  info: (text: string) => void;
  success: (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((text: string, tone: Tone = 'info') => {
    seq.current += 1;
    const id = seq.current;
    setItems((prev) => [...prev, { id, tone, text }].slice(-4));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      push,
      info: (text: string) => push(text, 'info'),
      success: (text: string) => push(text, 'success'),
      error: (text: string) => push(text, 'error'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.tone}`}
            role="status"
            onClick={() => setItems((prev) => prev.filter((t) => t.id !== item.id))}
          >
            <span className="toast-dot" />
            <span className="toast-text">{item.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}

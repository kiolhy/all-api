import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (next: T | null) => void;
}

/**
 * 极简数据加载 hook：deps 变化或 reload() 时重新拉取。
 * 用 JSON.stringify(deps) 当 key，避免 deps 数组长度变化导致的告警。
 */
export function useResource<T>(loader: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const depKey = JSON.stringify(deps);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [depKey, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { data, loading, error, reload, setData };
}

/* ────────────────────────── hash 路由 ────────────────────────── */

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function useHashRoute(): { path: string; navigate: (next: string) => void } {
  const [path, setPath] = useState<string>(readHash);

  useEffect(() => {
    const onChange = () => setPath(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: string) => {
    window.location.hash = next.startsWith('/') ? next : `/${next}`;
  }, []);

  return { path, navigate };
}

/* ────────────────────────── 跨页数据版本号 ────────────────────────── */

let dataRev = 0;
const listeners = new Set<() => void>();

export function bumpData(): void {
  dataRev += 1;
  for (const listener of listeners) listener();
}

export function useDataRev(): number {
  const [rev, setRev] = useState(dataRev);
  useEffect(() => {
    const listener = () => setRev(dataRev);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return rev;
}

/** 输入框防抖值。 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

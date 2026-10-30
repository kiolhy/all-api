import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { Platform } from './types.ts';

/**
 * 把后端可能漏出来的英文校验文案换成中文。
 * 主要来源是 zod 的默认 message（String must contain at least N character(s) 之类）。
 */
export function localizeError(message: string): string {
  if (!message) return message;
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/String must contain at least (\d+) character\(s\)/i, (m) => `至少需要 ${m[1]} 个字符`],
    [/String must contain at most (\d+) character\(s\)/i, (m) => `最多只能 ${m[1]} 个字符`],
    [/String must contain at least (\d+) character/i, (m) => `至少需要 ${m[1]} 个字符`],
    [/String must contain at most (\d+) character/i, (m) => `最多只能 ${m[1]} 个字符`],
    [/Number must be greater than or equal to (\d+)/i, (m) => `不能小于 ${m[1]}`],
    [/Number must be less than or equal to (\d+)/i, (m) => `不能大于 ${m[1]}`],
    [/Invalid email/i, () => '邮箱格式不对'],
    [/Invalid uuid/i, () => 'ID 格式不对'],
    [/Invalid url/i, () => '地址格式不对'],
    [/Invalid enum value/i, () => '取值不在允许范围内'],
    [/Invalid input/i, () => '格式不对'],
    [/^Required$/i, () => '必填'],
    [/Expected .* received .*/i, () => '类型不对'],
    [/Unauthorized/i, () => '登录状态已失效，请重新登录'],
    [/Forbidden/i, () => '没有权限'],
    [/Not Found/i, () => '找不到对应数据'],
    [/Internal Server Error/i, () => '服务端出错了，稍后重试'],
  ];
  let out = message;
  for (const [re, fn] of patterns) {
    const m = out.match(re);
    if (m) out = out.replace(re, fn(m));
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return localizeError(err.message);
  if (err instanceof Error) return localizeError(err.message);
  return localizeError(String(err));
}

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** 支持函数式更新，方便做乐观更新 */
  setData: (next: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * 极简数据加载 hook：deps 变化或 reload() 时重新拉取。
 * 用 JSON.stringify(deps) 当 key，避免 deps 数组长度变化导致的告警。
 * 默认 20 秒超时：请求卡住时给出失败态，不让界面无限转圈。
 */
export function useResource<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: { timeoutMs?: number } = {},
): Resource<T> {
  const timeoutMs = options.timeoutMs ?? 20000;
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

    const timer = window.setTimeout(() => {
      if (!alive) return;
      setError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），点重试再来一次`);
      setLoading(false);
    }, timeoutMs);

    loaderRef
      .current()
      .then((value) => {
        if (!alive) return;
        window.clearTimeout(timer);
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        window.clearTimeout(timer);
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [depKey, tick, timeoutMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { data, loading, error, reload, setData };
}

/* ────────────────────────── hash 路由 ────────────────────────── */

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '/';
  const clean = raw.startsWith('/') ? raw : `/${raw}`;
  // 路由只认路径部分；`#/endpoints?q=foo` 里的查询串交给页面自己读
  const at = clean.indexOf('?');
  return at === -1 ? clean : clean.slice(0, at);
}

/** 读取当前 hash 里的查询参数，例如 `#/endpoints?q=orders` → 'orders' */
export function readHashQuery(key: string): string {
  const raw = window.location.hash.replace(/^#/, '');
  const at = raw.indexOf('?');
  if (at === -1) return '';
  const params = new URLSearchParams(raw.slice(at + 1));
  return params.get(key) ?? '';
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
  // 平台是跨页共用的一份数据，任何写操作都顺手让它失效
  void refreshPlatforms();
}

/**
 * 切回标签页 / 窗口重新聚焦时再拉一次。
 * 别人在另一个窗口改了数据，不用手动点刷新也能看到最新状态。
 */
let focusBound = false;
function bindFocusRefresh(): void {
  if (focusBound || typeof window === 'undefined') return;
  focusBound = true;
  const kick = () => {
    dataRev += 1;
    for (const listener of listeners) listener();
    void refreshPlatforms();
  };
  window.addEventListener('focus', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
}

export function useDataRev(): number {
  const [rev, setRev] = useState(dataRev);
  useEffect(() => {
    bindFocusRefresh();
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

/* ────────────────────────── 平台：全站单一数据源 ────────────────────────── */

/**
 * 平台列表原本每个页面各拉一份，写完之后别的页面还是旧数据，
 * 概览数字、平台列表、接口页下拉能同时对不上。这里收成一个模块级 store：
 * 谁先加载谁发请求，其余订阅同一份结果，写操作统一走 invalidatePlatforms()。
 */
interface PlatformSnapshot {
  data: Platform[] | null;
  loading: boolean;
  error: string | null;
}

const platformSnapshot: PlatformSnapshot = { data: null, loading: false, error: null };
const platformSubs = new Set<() => void>();
let platformInflight: Promise<void> | null = null;

function emitPlatforms(): void {
  for (const fn of platformSubs) fn();
}

export function refreshPlatforms(): Promise<void> {
  if (platformInflight) return platformInflight;
  platformSnapshot.loading = true;
  platformSnapshot.error = null;
  emitPlatforms();

  platformInflight = api.platforms
    .list()
    .then((list) => {
      platformSnapshot.data = Array.isArray(list) ? list : [];
      platformSnapshot.error = null;
    })
    .catch((err: unknown) => {
      platformSnapshot.error = errorMessage(err);
    })
    .finally(() => {
      platformSnapshot.loading = false;
      platformInflight = null;
      emitPlatforms();
    });

  return platformInflight;
}

/** 平台被增删改后调用：清掉旧值并立即重拉，所有订阅者同步刷新 */
export function invalidatePlatforms(): void {
  platformSnapshot.data = null;
  void refreshPlatforms();
}

export interface PlatformsResource {
  data: Platform[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function usePlatforms(): PlatformsResource {
  const [, force] = useState(0);

  useEffect(() => {
    const onChange = () => force((n) => n + 1);
    platformSubs.add(onChange);
    if (platformSnapshot.data === null && platformInflight === null) {
      void refreshPlatforms();
    }
    return () => {
      platformSubs.delete(onChange);
    };
  }, []);

  return {
    data: platformSnapshot.data,
    loading: platformSnapshot.loading,
    error: platformSnapshot.error,
    reload: () => {
      void refreshPlatforms();
    },
  };
}

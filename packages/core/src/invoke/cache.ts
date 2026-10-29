type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

export function cacheGet<T>(key: string): { hit: true; value: T } | { hit: false } {
  const e = store.get(key);
  if (!e) return { hit: false };
  if (e.expires < Date.now()) {
    store.delete(key);
    return { hit: false };
  }
  return { hit: true, value: e.value as T };
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

export function cacheClear(): void {
  store.clear();
}

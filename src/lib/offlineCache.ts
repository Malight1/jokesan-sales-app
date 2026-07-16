// Lightweight read-cache for list queries, backed by localStorage.
// When the network is down, useQuery (see hooks.ts) falls back to the
// last-synced copy here instead of showing a hard error — the app stays
// usable, just visibly "offline" until the connection returns.

const PREFIX = 'sf_cache_';

export function cacheGet<T>(key: string): { data: T; syncedAt: number } | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, syncedAt: Date.now() }));
  } catch {
    // storage full or unavailable — offline cache is best-effort, never blocks the app
  }
}

// Wipe every cached list. Call on sign-out so the next login on a shared
// device never shows a previous tenant's stale data.
export function clearAllCache(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// Best-effort "is this a connectivity problem" check, since fetch errors
// from Supabase during an outage are generic TypeErrors.
export function looksOffline(error: any): boolean {
  if (!navigator.onLine) return true;
  const msg = String(error?.message ?? error ?? '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed');
}

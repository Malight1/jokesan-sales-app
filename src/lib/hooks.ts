import { useCallback, useEffect, useState } from 'react';
import { cacheGet, cacheSet, looksOffline } from './offlineCache';

interface QueryOptions {
  // When set, successful results are cached (localStorage) and reused if
  // a later fetch fails while offline — the page stays usable instead of
  // showing a hard error. Omit for queries where stale data isn't useful.
  cacheKey?: string;
}

// Minimal query hook: runs an async fetcher, exposes data/loading/error,
// and a refetch(). Re-runs when any dep changes.
export function useQuery<T>(fetcher: () => Promise<T>, deps: any[] = [], options: QueryOptions = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const { cacheKey } = options;

  const settle = useCallback((d: T) => {
    setData(d);
    setIsOffline(false);
    if (cacheKey) cacheSet(cacheKey, d);
  }, [cacheKey]);

  const fail = useCallback((e: any) => {
    if (cacheKey && looksOffline(e)) {
      const cached = cacheGet<T>(cacheKey);
      if (cached) { setData(cached.data); setIsOffline(true); return; }
    }
    setError(e.message ?? String(e));
  }, [cacheKey]);

  const run = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetcher()
      .then(d => { if (alive) settle(d); })
      .catch(e => { if (alive) fail(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { settle(await fetcher()); }
    catch (e: any) { fail(e); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, refetch, setData, isOffline };
}

// Minimal mutation hook: tracks pending/error around a write.
export function useMutation<TArgs extends any[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    setPending(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e: any) {
      setError(e.message ?? String(e));
      return null;
    } finally {
      setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { mutate, pending, error };
}

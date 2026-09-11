import { useCallback, useMemo } from 'react';
import { branches as branchesApi, Branch } from './api';
import { useAuth } from './AuthContext';
import { useQuery } from './hooks';

// Everything a screen needs to know about branches: whether the company has
// several, which one the signed-in person is working at, and names by id.
export function useBranches() {
  const { tenant, profile } = useAuth();
  const multi = tenant?.type === 'multi_branch';
  const q = useQuery<Branch[]>(() => branchesApi.list(), [], { cacheKey: 'branches' });

  const list = useMemo(() => q.data ?? [], [q.data]);
  const active = useMemo(() => list.filter(b => b.is_active), [list]);
  const byId = useMemo(() => new Map(list.map(b => [b.id, b])), [list]);

  // Every profile has a branch once migration 0020 has run; the fallback
  // only covers the moment before the branch list loads.
  const myBranchId = profile?.branch_id ?? active[0]?.id ?? null;
  const nameOf = useCallback((id?: string | null) => (id && byId.get(id)?.name) || '—', [byId]);

  return {
    multi,
    branches: list,
    active,
    myBranchId,
    myBranchName: nameOf(myBranchId),
    nameOf,
    loading: q.loading,
    refetch: q.refetch,
  };
}

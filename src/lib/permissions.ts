import { Role } from './AuthContext';

// Which routes each role may access. 'admin' implicitly gets everything.
export const ROLE_ROUTES: Record<Role, string[]> = {
  admin: ['*'],
  sales: ['/', '/profile', '/pos', '/sales', '/quotes', '/customers', '/finished-goods', '/stock-alerts', '/match-payment'],
  inventory: ['/', '/profile', '/inventory', '/finished-goods', '/production', '/batches', '/purchases', '/suppliers', '/stock-movement', '/stock-alerts', '/transfers', '/import'],
  accounts: ['/', '/profile', '/expenses', '/reports', '/sales', '/quotes', '/purchases', '/batches', '/stock-alerts', '/insights', '/match-payment'],
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_ROUTES[role];
  if (allowed.includes('*')) return true;
  return allowed.includes(path);
}

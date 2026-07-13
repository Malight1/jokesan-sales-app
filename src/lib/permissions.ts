import { Role } from './AuthContext';

// Which routes each role may access. 'admin' implicitly gets everything.
export const ROLE_ROUTES: Record<Role, string[]> = {
  admin: ['*'],
  sales: ['/', '/sales', '/customers', '/finished-goods', '/stock-alerts'],
  inventory: ['/', '/inventory', '/finished-goods', '/production', '/purchases', '/suppliers', '/stock-movement', '/stock-alerts'],
  accounts: ['/', '/expenses', '/reports', '/sales', '/purchases', '/stock-alerts'],
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_ROUTES[role];
  if (allowed.includes('*')) return true;
  return allowed.includes(path);
}

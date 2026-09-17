import { Role } from './AuthContext';

// Which routes each role may access. 'admin' implicitly gets everything.
export const ROLE_ROUTES: Record<Role, string[]> = {
  admin: ['*'],
  sales: ['/', '/profile', '/pos', '/sales', '/quotes', '/deliveries', '/customers', '/finished-goods', '/stock-alerts', '/match-payment', '/assistant'],
  inventory: ['/', '/profile', '/inventory', '/finished-goods', '/production', '/batches', '/purchases', '/suppliers', '/stock-movement', '/stock-alerts', '/transfers', '/import', '/insights', '/assistant'],
  accounts: ['/', '/profile', '/expenses', '/reports', '/sales', '/quotes', '/deliveries', '/purchases', '/batches', '/stock-alerts', '/insights', '/match-payment', '/assistant'],
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_ROUTES[role];
  if (allowed.includes('*')) return true;
  return allowed.includes(path);
}

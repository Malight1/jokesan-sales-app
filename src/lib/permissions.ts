import { Role } from './AuthContext';

// Which routes each role may access. 'admin' implicitly gets everything.
export const ROLE_ROUTES: Record<Role, string[]> = {
  admin: ['*'],
  sales: ['/dashboard', '/profile', '/pos', '/sales', '/quotes', '/deliveries', '/customers', '/finished-goods', '/stock-alerts', '/match-payment', '/assistant', '/support'],
  inventory: ['/dashboard', '/profile', '/inventory', '/finished-goods', '/production', '/batches', '/purchases', '/suppliers', '/stock-movement', '/stock-alerts', '/transfers', '/import', '/insights', '/assistant', '/support'],
  accounts: ['/dashboard', '/profile', '/expenses', '/reports', '/sales', '/quotes', '/deliveries', '/purchases', '/batches', '/stock-alerts', '/insights', '/match-payment', '/assistant', '/support'],
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_ROUTES[role];
  if (allowed.includes('*')) return true;
  // A listed route also covers its own sub-routes (e.g. '/support' covers
  // '/support/:id'), so a ticket detail page doesn't need its own entry.
  return allowed.some(a => path === a || path.startsWith(a + '/'));
}

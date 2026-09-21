import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { canAccess } from '../lib/permissions';
import { Loader2 } from 'lucide-react';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, profile, isPlatformAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="spin" size={28} color="#2563eb" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  // A platform-admin-only account (no tenant of its own, see migration
  // 0043) has nothing to do outside /platform — send it there instead of
  // letting it wander into tenant pages with no data behind them.
  if (!profile && isPlatformAdmin && !location.pathname.startsWith('/platform')) {
    return <Navigate to="/platform" replace />;
  }

  // Deactivated by an admin → block the whole app
  if (profile && profile.is_active === false) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '1rem', textAlign: 'center' }}>
        <h2 style={{ color: '#dc2626' }}>Account deactivated</h2>
        <p style={{ color: '#64748b', maxWidth: 380 }}>
          Your access has been turned off by your company administrator. Contact them if you think this is a mistake.
        </p>
      </div>
    );
  }

  // Logged in but no role access to this path → bounce to dashboard
  if (profile && !canAccess(profile.role, location.pathname)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

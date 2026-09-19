import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import MarketingLayout from '../marketing/MarketingLayout';

// Gate for the four public marketing pages ('/', '/product', '/pricing',
// '/faq'). A signed-in visitor has no reason to see the pricing page
// instead of their own dashboard, so this bounces them straight there —
// the mirror image of ProtectedRoute sending a signed-out visitor to
// /login. Logged-out visitors get the marketing nav/footer shell around
// whichever page matched.
export default function PublicGate() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="spin" size={28} color="#2563eb" />
      </div>
    );
  }

  if (session) return <Navigate to="/dashboard" replace />;

  return (
    <MarketingLayout>
      <Outlet />
    </MarketingLayout>
  );
}

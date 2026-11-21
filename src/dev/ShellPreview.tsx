import React from 'react';
import { AuthContextForPreview, AuthState, Role, Tenant, Profile } from '../lib/AuthContext';
import Layout from '../components/Layout';
import TillHeader from '../components/TillHeader';

// DEVELOPMENT ONLY (registered in App.tsx only when NODE_ENV is
// 'development'). Renders the signed-in frame around a placeholder page
// with a sample user, so the top bar, sidebar and cashier till bar can be
// checked on any screen size without signing in.
//
//   /__dev/shell?role=sales&type=retail   (&till=1 adds an open till bar)

export default function ShellPreview() {
  const params = new URLSearchParams(window.location.search);
  const role = (params.get('role') || 'sales') as Role;
  const type = params.get('type') === 'manufacturing' ? 'manufacturing' : 'retail';

  const tenant: Tenant = {
    id: 'preview', name: type === 'retail' ? 'Mama Tolu Stores' : 'Jokesan Soap Works', type: 'single',
    business_type: type, plan: 'growth', currency: 'NGN', logo_url: null, vat_enabled: false, vat_rate: 0,
    tin: null, trial_ends_at: null, plan_expires_at: null, is_active: true,
  };
  const profile: Profile = {
    id: 'preview-user', tenant_id: 'preview', branch_id: null, role,
    full_name: 'Adaeze Okafor', email: 'preview@example.com', is_active: true,
  };
  const value: AuthState = {
    session: null, profile, tenant, isPlatformAdmin: false, loading: false,
    signIn: async () => ({ error: null }), signUp: async () => ({ error: null }),
    signOut: async () => { window.alert('Signed out (preview)'); }, refresh: async () => {},
  };

  return (
    <AuthContextForPreview.Provider value={value}>
      <Layout>
        {params.get('till') === '1' && (
          <TillHeader onChanged={() => {}} shift={{
            shift_id: 'preview', register_id: 'r', branch_id: 'b', opened_by: 'preview-user',
            opened_at: new Date(Date.now() - 6 * 3600000).toISOString(), opening_float: 5000,
            sales_count: 0, sales_total: 0, discount_total: 0, refunds_total: 0,
            expected: { cash: 5000, opening_float: 5000, pay_in: 0, pay_out: 0, drop: 0 },
          }} />
        )}
        <div className="card"><h3>Page content</h3><p>Sample page for checking the frame.</p></div>
      </Layout>
    </AuthContextForPreview.Provider>
  );
}

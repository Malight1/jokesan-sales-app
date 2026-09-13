import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { clearAllCache } from './offlineCache';
import { clearQueue } from './offlineQueue';

export type Role = 'admin' | 'sales' | 'inventory' | 'accounts';

export interface Profile {
  id: string;
  tenant_id: string | null;
  branch_id: string | null;
  role: Role;
  full_name: string | null;
  email: string | null;
  is_active: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  type: 'single' | 'multi_branch';
  plan: string;
  currency: string;
  logo_url: string | null;
  vat_enabled: boolean;
  vat_rate: number;
  tin: string | null;
  trial_ends_at: string | null;
  plan_expires_at: string | null;
  // Set false by the platform owner's suspend button. Was never selected,
  // so the app could not tell a suspended tenant from a live one.
  is_active: boolean;
  // Batch/expiry settings (migration 0022). Optional until it has run.
  expiry_warning_days?: number;
  allow_expired_sale?: boolean;
  // How far a cashier may go with a return (migration 0024).
  cashier_returns?: 'none' | 'same_day_own' | 'any';
  // Shifts and cash-up (migration 0026). Optional until it has run.
  shift_rules?: {
    required_for: string[];   // e.g. ["sales"] once an admin turns it on
    blind_count: boolean;
    variance_alert: number;
    pay_out_limit: number;
  };
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  tenant: Tenant | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (params: SignUpParams) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface SignUpParams {
  email: string;
  password: string;
  fullName: string;
  companyName: string;
  tenantType: 'single' | 'multi_branch';
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId: string) => {
    const { data: prof } = await supabase
      .from('profiles')
      .select('id, tenant_id, branch_id, role, full_name, email, is_active')
      .eq('id', userId)
      .single();

    setProfile(prof as Profile | null);

    if (prof?.tenant_id) {
      const { data: ten } = await supabase
        .from('tenants')
        // '*' rather than a column list: a listed column that a not-yet-run
        // migration adds would fail the whole query and sign everyone out.
        .select('*')
        .eq('id', prof.tenant_id)
        .single();
      setTenant(ten as Tenant | null);
    } else {
      setTenant(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (session?.user) await loadProfile(session.user.id);
  }, [session, loadProfile]);

  useEffect(() => {
    supabase.auth.getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        if (data.session?.user) await loadProfile(data.session.user.id);
      })
      .catch((err) => {
        console.error('Failed to load session', err);
        setSession(null);
      })
      .finally(() => setLoading(false));

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setSession(sess);
      if (sess?.user) {
        await loadProfile(sess.user.id);
      } else {
        setProfile(null);
        setTenant(null);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  const signIn: AuthState['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp: AuthState['signUp'] = async ({ email, password, fullName, companyName, tenantType }) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, company_name: companyName, tenant_type: tenantType },
      },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setTenant(null);
    clearAllCache();
    // A still-pending offline sale must never replay under a different
    // tenant's session if someone else signs into this device next.
    clearQueue();
  };

  return (
    <AuthContext.Provider value={{ session, profile, tenant, loading, signIn, signUp, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

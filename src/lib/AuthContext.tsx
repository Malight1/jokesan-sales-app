import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

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
        .select('id, name, type, plan, currency, logo_url')
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
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session?.user) await loadProfile(data.session.user.id);
      setLoading(false);
    });

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

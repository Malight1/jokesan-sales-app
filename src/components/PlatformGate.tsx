import React from 'react';
import { Navigate } from 'react-router-dom';
import { platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Loading } from './DataStates';

export default function PlatformGate({ children }: { children: React.ReactNode }) {
  const adminQ = useQuery<boolean>(() => platform.isAdmin(), []);
  if (adminQ.loading) return <Loading label="Checking access…" />;
  if (!adminQ.data) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

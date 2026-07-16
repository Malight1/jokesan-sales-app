import React from 'react';
import { WifiOff } from 'lucide-react';

export default function OfflineBanner({ label = 'data' }: { label?: string }) {
  return (
    <div className="alert alert-warning" style={{ alignItems: 'center', gap: 8 }}>
      <WifiOff size={16} />
      <span>You're offline — showing the last synced {label}. Changes will sync once you're back online.</span>
    </div>
  );
}

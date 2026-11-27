import { useEffect, useState } from 'react';

// Which tips each person has seen, whether they switched tips off, and
// whether they hid the setup checklist. Kept on the device (per signed-in
// person), so it needs no database change and works offline. A new phone
// shows the tips once more, which is harmless.

export interface HelpState { off: boolean; seen: string[]; checklistHidden: boolean }
const blank: HelpState = { off: false, seen: [], checklistHidden: false };
const keyFor = (uid: string) => `pfb-help:${uid}`;
const EVENT = 'pfb-help-change';

export function readHelp(uid: string | null | undefined): HelpState {
  if (!uid) return blank;
  try {
    const raw = localStorage.getItem(keyFor(uid));
    return raw ? { ...blank, ...JSON.parse(raw) } : blank;
  } catch {
    return blank;
  }
}

export function writeHelp(uid: string | null | undefined, change: Partial<HelpState>) {
  if (!uid) return;
  const next = { ...readHelp(uid), ...change };
  try { localStorage.setItem(keyFor(uid), JSON.stringify(next)); } catch { /* private mode: tips just show again */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export const markSeen = (uid: string | null | undefined, key: string) => {
  const s = readHelp(uid);
  if (!s.seen.includes(key)) writeHelp(uid, { seen: [...s.seen, key] });
};

export function useHelpState(uid: string | null | undefined): HelpState {
  const [state, setState] = useState(() => readHelp(uid));
  useEffect(() => {
    const sync = () => setState(readHelp(uid));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, [uid]);
  return state;
}

// The help panel's "Show me around" asks the tour to start on this page.
export const TOUR_EVENT = 'pfb-start-tour';
export const startTour = () => window.dispatchEvent(new CustomEvent(TOUR_EVENT));

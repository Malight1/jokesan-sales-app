import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { HelpCircle, X, Compass, Sparkles, LifeBuoy } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { canAccess } from '../../lib/permissions';
import { isRetail } from '../../retail';
import { helpFor, tourKey, HelpTip } from '../../lib/help';
import { useHelpState, writeHelp, markSeen, startTour, TOUR_EVENT } from '../../lib/helpState';
import { useModalA11y } from '../../lib/useModalA11y';
import './help.scss';

// ---------------------------------------------------------------------
// The ? button at the top of every page, and the panel it opens.
// ---------------------------------------------------------------------
export function HelpButton({ variant = 'icon' }: { variant?: 'icon' | 'chip' }) {
  const { pathname } = useLocation();
  const { tenant } = useAuth();
  const [open, setOpen] = useState(false);
  const help = helpFor(pathname, isRetail(tenant));
  useEffect(() => { setOpen(false); }, [pathname]);
  if (!help) return null;
  return (
    <>
      {variant === 'chip' ? (
        <button type="button" className="till-chip" onClick={() => setOpen(true)} aria-label={`Help with ${help.title}`}>
          <HelpCircle size={14} /> <span className="till-chip-label">Help</span>
        </button>
      ) : (
        <button type="button" className="help-btn" onClick={() => setOpen(true)} aria-label={`Help with ${help.title}`} title="Help with this page">
          <HelpCircle size={18} />
        </button>
      )}
      {/* Rendered on <body>: the top bar's styling would otherwise trap a fixed panel inside it. */}
      {open && createPortal(<HelpPanel onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const { tenant, profile } = useAuth();
  const help = helpFor(pathname, isRetail(tenant))!;
  const state = useHelpState(profile?.id);
  const { overlayProps, modalProps } = useModalA11y(onClose);
  const role = profile?.role;

  return (
    <div className="help-overlay" {...overlayProps}>
      <aside className="help-panel" {...modalProps}>
        <div className="help-head">
          <h2>{help.title}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close help"><X size={18} /></button>
        </div>
        <div className="help-body">
          <p className="help-intro">{help.intro}</p>
          {help.steps && help.steps.length > 0 && (
            <section>
              <h3>How to use it</h3>
              <ol className="help-steps">{help.steps.map(s => <li key={s}>{s}</li>)}</ol>
            </section>
          )}
          {help.notes && help.notes.length > 0 && (
            <section>
              <h3>Good to know</h3>
              <ul className="help-notes">{help.notes.map(s => <li key={s}>{s}</li>)}</ul>
            </section>
          )}
          {help.tips && help.tips.length > 0 && (
            <button type="button" className="btn-secondary help-tour-btn" onClick={() => { onClose(); setTimeout(startTour, 250); }}>
              <Compass size={16} aria-hidden="true" /> Show me around this page
            </button>
          )}
        </div>
        <div className="help-foot">
          <p className="help-stuck">Still stuck?</p>
          <div className="help-links">
            {role && canAccess(role, '/assistant') && (
              <Link to="/assistant" className="help-link" onClick={onClose}><Sparkles size={15} aria-hidden="true" /> Ask ProfixBook</Link>
            )}
            {role && canAccess(role, '/support') && (
              <Link to="/support" className="help-link" onClick={onClose}><LifeBuoy size={15} aria-hidden="true" /> Contact Support</Link>
            )}
            {role === 'cashier' && <span className="help-muted">Ask your manager, or call the business owner.</span>}
          </div>
          <label className="help-switch">
            <input type="checkbox" checked={!state.off} onChange={e => writeHelp(profile?.id, { off: !e.target.checked })} />
            <span>Show tips the first time I open a page</span>
          </label>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------
// First-visit tips: a few pop-ups pointing at a page's main controls.
// ---------------------------------------------------------------------
const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
// The same target can be on two elements (the till's sale panel on a
// laptop, its bottom bar on a phone): use whichever is on screen.
const findEl = (target: string) =>
  Array.from(document.querySelectorAll(`[data-tour="${target}"]`)).find(visible) as HTMLElement | undefined;
const findTips = (tips: HelpTip[]) => tips.filter(t => !!findEl(t.target));

export function PageTour() {
  const { pathname } = useLocation();
  const { tenant, profile } = useAuth();
  const uid = profile?.id;
  const state = useHelpState(uid);
  const [steps, setSteps] = useState<HelpTip[] | null>(null);
  const [i, setI] = useState(0);
  const key = tourKey(pathname);
  const help = helpFor(pathname, isRetail(tenant));

  const begin = useCallback((force: boolean) => {
    const tips = help?.tips ?? [];
    if (!tips.length) return () => {};
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      // Wait for the page to load and for any dialog to close first.
      const blocked = !!document.querySelector('.modal-overlay, .help-overlay');
      const found = blocked ? [] : findTips(tips);
      if (found.length > 0) {
        window.clearInterval(timer);
        setI(0);
        setSteps(found);
      } else if (tries > (force ? 6 : 15)) {
        window.clearInterval(timer);
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [help]);

  // Automatically, once per page per person.
  useEffect(() => {
    setSteps(null);
    if (!uid || state.off || state.seen.includes(key) || !help?.tips?.length) return;
    return begin(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, uid, state.off]);

  // On request, from the help panel.
  useEffect(() => {
    const go = () => begin(true);
    window.addEventListener(TOUR_EVENT, go);
    return () => window.removeEventListener(TOUR_EVENT, go);
  }, [begin]);

  if (!steps) return null;
  const finish = () => { markSeen(uid, key); setSteps(null); };
  return <TourStep tip={steps[i]} index={i} total={steps.length}
                   onBack={() => setI(n => Math.max(0, n - 1))}
                   onNext={() => (i + 1 < steps.length ? setI(i + 1) : finish())}
                   onSkip={finish} />;
}

function TourStep({ tip, index, total, onBack, onNext, onSkip }: {
  tip: HelpTip; index: number; total: number; onBack: () => void; onNext: () => void; onSkip: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(180);

  useEffect(() => {
    const el = findEl(tip.target);
    if (!el) { onNext(); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    let frame = 0;
    const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setRect(el.getBoundingClientRect())); };
    measure();
    const t = window.setTimeout(measure, 400);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { window.clearTimeout(t); cancelAnimationFrame(frame); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip.target]);

  const ready = rect !== null;
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
    cardRef.current?.focus({ preventScroll: true });
  }, [tip.target, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onSkip(); }
      else if (e.key === 'ArrowRight') onNext();
      else if (e.key === 'ArrowLeft') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onNext, onBack, onSkip]);

  if (!rect) return null;
  const pad = 6;
  const vw = window.innerWidth, vh = window.innerHeight;
  const narrow = vw < 640;
  const cardW = Math.min(340, vw - 24);
  const below = rect.bottom + 12 + cardH < vh;
  const top = below ? rect.bottom + 12 : Math.max(12, rect.top - 12 - cardH);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - cardW / 2), vw - cardW - 12);
  const cardStyle: React.CSSProperties = narrow
    ? { left: 12, right: 12, bottom: 12 }
    : { top, left, width: cardW };

  return (
    <div className="tour-layer" role="presentation">
      <div className="tour-spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      <div ref={cardRef} className="tour-card" style={cardStyle} role="dialog" aria-modal="false" aria-labelledby="tour-title" tabIndex={-1}>
        <p className="tour-count">{index + 1} of {total}</p>
        <h3 id="tour-title">{tip.title}</h3>
        <p className="tour-body">{tip.body}</p>
        <div className="tour-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={onSkip}>Skip tips</button>
          <span className="tour-spacer" />
          {index > 0 && <button type="button" className="btn-secondary btn-sm" onClick={onBack}>Back</button>}
          <button type="button" className="btn-primary btn-sm" onClick={onNext}>{index + 1 < total ? 'Next' : 'Got it'}</button>
        </div>
      </div>
    </div>
  );
}

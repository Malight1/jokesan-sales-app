import { useCallback, useEffect, useId, useRef, type MouseEvent } from 'react';

// Every dialog in the app shares the same markup:
//   <div className="modal-overlay"> <div className="modal"> …
// but none of them were keyboard-operable — no Escape, no focus trap, no
// focus return, and nothing telling a screen reader a dialog had opened.
// This hook supplies all of that from one place, so a page only has to
// spread the two prop bags onto the markup it already has.
//
// Usage:
//   const { overlayProps, modalProps } = useModalA11y(() => setOpen(false));
//   <div className="modal-overlay" {...overlayProps}>
//     <div className="modal" {...modalProps}> …

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalA11y(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Call sites almost always pass an inline arrow, which would change every
  // render. Holding it in a ref keeps the effect from re-running (and stealing
  // focus back) on each keystroke inside the dialog.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Point the dialog at its own heading. The headings are written by ~14
    // different pages, so rather than editing each one, we adopt whichever
    // heading is already there.
    const heading = el.querySelector('h1, h2, h3');
    if (heading) {
      if (!heading.id) heading.id = titleId;
      el.setAttribute('aria-labelledby', heading.id);
    }

    // Move focus into the dialog: the first real control, or the dialog itself.
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus({ preventScroll: true });

    // The page behind a modal shouldn't scroll under it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      // Trap Tab inside the dialog by wrapping at both ends.
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); return; }

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === firstItem || active === el)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // Send focus back where it came from, so closing a dialog doesn't dump
      // a keyboard user at the top of the page.
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [titleId]);

  const onOverlayClick = useCallback(() => closeRef.current(), []);
  const stop = useCallback((e: MouseEvent) => e.stopPropagation(), []);

  return {
    titleId,
    overlayProps: { onClick: onOverlayClick },
    modalProps: {
      ref,
      role: 'dialog' as const,
      'aria-modal': true,
      tabIndex: -1,
      onClick: stop,
    },
  };
}

import React from 'react';
import { useModalA11y } from '../lib/useModalA11y';

interface Props {
  onClose: () => void;
  /** Optional cap, matching the inline style the old markup used. */
  maxWidth?: number;
  children: React.ReactNode;
}

// The shared dialog shell. It renders exactly the markup every page used to
// write by hand (.modal-overlay > .modal), so the styling is unchanged, but
// it also mounts and unmounts with the dialog itself — which is what makes
// the focus trap, Escape handling and focus return in useModalA11y work.
export default function Modal({ onClose, maxWidth, children }: Props) {
  const { overlayProps, modalProps } = useModalA11y(onClose);
  return (
    <div className="modal-overlay" {...overlayProps}>
      <div className="modal" {...modalProps} style={maxWidth ? { maxWidth } : undefined}>
        {children}
      </div>
    </div>
  );
}

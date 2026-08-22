import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../Modal';

// Covers the keyboard behaviour every dialog in the app was missing:
// Escape to close, focus moved in and trapped, focus handed back on close.

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal onClose={() => setOpen(false)}>
          <div className="modal-header"><h2>Add Customer</h2></div>
          <div className="modal-body">
            <input aria-label="Name" />
            <input aria-label="Phone" />
          </div>
          <div className="modal-footer"><button>Save</button></div>
        </Modal>
      )}
    </>
  );
}

describe('Modal', () => {
  it('announces itself as a dialog labelled by its heading', () => {
    render(<Modal onClose={() => {}}><h2>Add Customer</h2></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Add Customer');
  });

  it('moves focus to the first control when it opens', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('closes on Escape', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('returns focus to the trigger after closing', () => {
    render(<Harness />);
    const trigger = screen.getByText('Open');
    trigger.focus(); // a real click focuses the button; jsdom's does not
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('closes when the backdrop is clicked but not the panel', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.click(screen.getByRole('dialog'));      // panel — must stay open
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('dialog').parentElement!); // backdrop
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('wraps Tab from the last control back to the first', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    const save = screen.getByText('Save');
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('locks background scrolling while open and restores it after', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

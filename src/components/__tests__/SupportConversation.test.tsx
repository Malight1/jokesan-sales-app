import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../lib/ToastContext';
import { Composer, MessageList, ago } from '../SupportConversation';

// The reply box and message list shared by the customer's ticket page and
// the platform admin's. A lost reply is the worst outcome here, so most of
// this is about when the text is (and isn't) cleared.

const renderComposer = (onSend: (b: string, f: File[]) => Promise<boolean>) =>
  render(<ToastProvider><Composer placeholder="Write…" pending={false} onSend={onSend} /></ToastProvider>);

describe('Composer', () => {
  it('sends on Ctrl+Enter and clears once it went out', async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    renderComposer(onSend);
    const box = screen.getByLabelText('Reply');
    fireEvent.change(box, { target: { value: '  It still shows 3  ' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('It still shows 3', []));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps what was typed when sending fails', async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    renderComposer(onSend);
    const box = screen.getByLabelText('Reply');
    fireEvent.change(box, { target: { value: 'Please help' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(box).toHaveValue('Please help');
  });

  it('does not send an empty or whitespace reply', () => {
    const onSend = jest.fn().mockResolvedValue(true);
    renderComposer(onSend);
    const box = screen.getByLabelText('Reply');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('a plain Enter is a new line, not a send', () => {
    const onSend = jest.fn().mockResolvedValue(true);
    renderComposer(onSend);
    const box = screen.getByLabelText('Reply');
    fireEvent.change(box, { target: { value: 'Line one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('MessageList', () => {
  beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

  it('puts your own messages on your side and names the other', () => {
    render(
      <MessageList
        messages={[
          { id: '1', sender_type: 'tenant', body: 'Stock is wrong', created_at: '2026-10-01T09:00:00Z' },
          { id: '2', sender_type: 'admin', body: 'Looking now', created_at: '2026-10-01T09:05:00Z' },
        ]}
        isMine={m => m.sender_type === 'admin'}
        nameOf={m => (m.sender_type === 'admin' ? 'You' : 'Ada')}
      />,
    );
    expect(screen.getByText('Looking now').closest('.sp-msg')).toHaveClass('is-mine');
    expect(screen.getByText('Stock is wrong').closest('.sp-msg')).toHaveClass('is-theirs');
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });
});

describe('ago', () => {
  it('reads like a person would say it', () => {
    const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    expect(ago(minsAgo(0))).toBe('just now');
    expect(ago(minsAgo(5))).toBe('5m ago');
    expect(ago(minsAgo(180))).toBe('3h ago');
    expect(ago(minsAgo(60 * 24 * 2))).toBe('2d ago');
    expect(ago(null)).toBe('');
  });
});

import React from 'react';
import { Link } from 'react-router-dom';

const FAQS = [
  { q: 'Does StockFlow work with no internet?',
    a: 'Yes. Point of sale queues sales while you\'re offline and syncs for real the moment you\'re back online — the server is still the final word, so a real stock conflict is flagged for you to resolve rather than silently guessed at.' },
  { q: 'Can each branch have its own stock?',
    a: 'Yes. Every branch keeps completely separate stock. Moving stock between branches goes through a transfer that preserves the original FIFO cost, so your margins stay accurate wherever something ends up being sold.' },
  { q: 'Is StockFlow ready for Nigeria\'s new e-invoicing rules?',
    a: 'StockFlow scores your business\'s readiness against the real NRS requirements and shows exactly what\'s missing — your TIN, RC number, and the right tax fields on your products and customers. It doesn\'t yet submit invoices directly to NRS, since that needs an accredited provider StockFlow hasn\'t connected to yet — but you\'ll be ahead of the 2027/2028 enforcement dates either way.' },
  { q: 'Can I bring in my existing Excel or notebook records?',
    a: 'Yes, through the CSV import tool — bring in your products and opening stock without retyping everything by hand.' },
  { q: 'What happens with a fake bank-transfer alert now?',
    a: 'Connect your own Paystack account under Settings, and any invoice you send with a pay link confirms itself the moment the customer actually pays — no bank alert to read or trust. There\'s also a bank-alert matcher for payments outside a pay link.' },
  { q: 'What if I stop paying?',
    a: 'Your account moves to read-only rather than being deleted, so nothing you\'ve recorded is lost while you decide what to do next.' },
  { q: 'Do I need to install anything?',
    a: 'No. StockFlow runs in the browser on any phone, tablet or computer — nothing to install, and it works as an installable app on your phone\'s home screen if you want it there.' },
];

export default function Faq() {
  return (
    <div className="mkt-faq-page">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">FAQ</span>
        <h1>Questions people ask before they start.</h1>
      </section>

      <section className="mkt-section">
        <div className="mkt-faq-list">
          {FAQS.map(f => (
            <details key={f.q} className="mkt-faq-item">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p className="mkt-pricing__note">Still have a question? <Link to="/pricing">See pricing</Link> or reach us on WhatsApp from the footer below.</p>
      </section>
    </div>
  );
}

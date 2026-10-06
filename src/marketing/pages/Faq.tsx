import React from 'react';
import { Link } from 'react-router-dom';
import useMeta from '../useMeta';

const FAQS = [
  { q: "I run a shop and don't make anything. Is ProfixBook for me?",
    a: "Yes. When you sign up, choose \"I buy and resell stock\" and you get a shop version: a till-first dashboard, buying stock straight from suppliers, and no raw-material or production screens. Supermarkets, pharmacies, provision stores, boutiques and phone shops all use it this way." },
  { q: 'Can I use it on my phone?',
    a: 'Yes. It runs in the browser on any phone, tablet or laptop, and the till is designed to work one-handed on a phone. You can add it to your home screen like an app.' },
  { q: 'Can my staff use it without seeing my costs and profit?',
    a: 'Yes. Cashiers, storekeepers and accountants each get their own login and only see what their role needs. Cashiers never see what you paid for stock or your profit. The plan you choose sets how many people can log in.' },
  { q: 'I sell drugs, food or cosmetics. Does it handle expiry dates?',
    a: 'Yes. Turn on expiry tracking for a product and every delivery records its expiry date. The till can sell the earliest-expiring stock first, expired stock can be blocked from sale, and you get a list of what is about to expire so you can move it in time.' },
  { q: 'Does ProfixBook work with no internet?',
    a: 'Yes. Point of sale queues sales while you are offline and syncs for real the moment you are back online. The server is still the final word, so a real stock conflict is flagged for you to resolve rather than silently guessed at.' },
  { q: 'Can each branch have its own stock?',
    a: 'Yes. Every branch keeps completely separate stock. Moving stock between branches goes through a transfer that preserves the original FIFO cost, so your margins stay accurate wherever something ends up being sold.' },
  { q: 'Is ProfixBook ready for Nigeria\'s new e-invoicing rules?',
    a: 'ProfixBook scores your business\'s readiness against the real NRS requirements and shows exactly what is missing: your TIN, RC number, and the right tax fields on your products and customers. It does not yet submit invoices directly to NRS, since that needs an accredited provider ProfixBook has not connected to yet, but you will be ahead of the 2027/2028 enforcement dates either way.' },
  { q: 'Can I bring in my existing Excel or notebook records?',
    a: 'Yes, through the CSV import tool. Bring in your products and opening stock without retyping everything by hand.' },
  { q: 'What happens with a fake bank-transfer alert now?',
    a: 'Connect your own Paystack account under Settings, and any invoice you send with a pay link confirms itself the moment the customer actually pays. No bank alert to read or trust. There is also a bank-alert matcher for payments outside a pay link.' },
  { q: 'What if I stop paying?',
    a: 'Your account moves to read-only rather than being deleted, so nothing you have recorded is lost while you decide what to do next.' },
  { q: 'Do I need to install anything?',
    a: 'No. ProfixBook runs in the browser on any phone, tablet or computer. Nothing to install, and it works as an installable app on your phone\'s home screen if you want it there.' },
];

export default function Faq() {
  useMeta(
    'FAQ, ProfixBook',
    'Answers to what people ask before they start: shops and manufacturers, phones, staff access, expiry dates, offline selling, branches and e-invoicing.'
  );
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

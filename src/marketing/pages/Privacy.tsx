import React from 'react';
import { Link } from 'react-router-dom';
import useMeta from '../useMeta';

// DRAFT, see the same notice in Terms.tsx and LANDING_PAGE_PLAN.md section 6.
// Not reviewed by a lawyer yet; a reasonable starting point only.
export default function Privacy() {
  useMeta('Privacy Policy, StockFlow', 'What StockFlow collects, why, and how it\'s protected.');
  return (
    <div className="mkt-legal">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">Legal</span>
        <h1>Privacy Policy</h1>
        <p>Last updated 19 September 2026.</p>
      </section>

      <section className="mkt-section mkt-legal__body">
        <div className="mkt-legal__notice">
          <strong>This is a draft.</strong> It has not yet been reviewed by a lawyer. It's published so there's
          something real behind the link while that review happens. Treat it as a starting point, not a
          finished legal document.
        </div>

        <h2>1. What we collect</h2>
        <p>When you create an account: your name, email, phone number if you provide one, and your company name. When you use StockFlow: whatever you record about your own business, products, customers, suppliers, sales, purchases, stock movements and similar. We don't collect more than what running the software needs.</p>

        <h2>2. How we use it</h2>
        <p>To run the service you signed up for. That means showing you your own dashboard, processing your own sales, sending the WhatsApp messages and reminders you ask it to send, and answering questions you ask the Ask StockFlow assistant using your own business's data. We don't sell your data, and we don't share it with other StockFlow customers.</p>

        <h2>3. Who else sees it</h2>
        <p>A short, genuine list. We don't use more third parties than this:</p>
        <ul>
          <li><strong>Supabase</strong> hosts our database, authentication and file storage.</li>
          <li><strong>Paystack</strong> processes payments, both your subscription and, if you connect your own account, your customers' payments to you. StockFlow never sees your card details.</li>
          <li><strong>Groq</strong> powers the Ask StockFlow assistant, and only ever sees the specific question you ask and the data needed to answer it, never your whole database.</li>
        </ul>

        <h2>4. Security</h2>
        <p>Your data is scoped to your own business by the database itself, not just by the app's screens. Even a direct request for another business's data is refused at the database level. Sensitive secrets, like a payment provider key you connect, are stored in a vault your own account can't read back, not as plain text.</p>

        <h2>5. What happens if you stop paying</h2>
        <p>Your account moves to read-only. Nothing is deleted. You can export your data or choose a plan to start recording again at any time.</p>

        <h2>6. Your rights</h2>
        <p>Under Nigeria's Data Protection Act, you can ask what personal data we hold about you, ask us to correct it, or ask us to delete your account and its data entirely. Contact us to make any of these requests.</p>

        <h2>7. Cookies and local storage</h2>
        <p>StockFlow keeps you signed in using your browser's local storage, not tracking cookies. If you use the offline point-of-sale mode, sales you ring up while offline are also held in local storage until they sync.</p>

        <h2>8. Changes to this policy</h2>
        <p>We may update this policy as StockFlow changes. We'll post the new version here with an updated date.</p>

        <h2>9. Contact</h2>
        <p>Questions about your data? Reach us on WhatsApp from the <Link to="/">footer</Link>.</p>
      </section>
    </div>
  );
}

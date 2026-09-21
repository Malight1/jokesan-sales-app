import React from 'react';
import { Link } from 'react-router-dom';
import useMeta from '../useMeta';

// DRAFT, written to close the "no legal pages at all" gap so the footer
// links go somewhere real. This is a reasonable starting point, not a
// substitute for review by an actual lawyer before real customers sign up
// against it. See LANDING_PAGE_PLAN.md section 6. Swap this notice out
// once it's been reviewed.
export default function Terms() {
  useMeta('Terms of Service, StockFlow', 'The terms that apply when you use StockFlow.');
  return (
    <div className="mkt-legal">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">Legal</span>
        <h1>Terms of Service</h1>
        <p>Last updated 19 September 2026.</p>
      </section>

      <section className="mkt-section mkt-legal__body">
        <div className="mkt-legal__notice">
          <strong>This is a draft.</strong> It has not yet been reviewed by a lawyer. It's published so there's
          something real behind the link while that review happens. Treat it as a starting point, not a
          finished legal document.
        </div>

        <h2>1. What StockFlow is</h2>
        <p>StockFlow is inventory, manufacturing and sales software provided as a service ("StockFlow", "we", "us"). By creating an account or using StockFlow, you ("you", "your business") agree to these terms.</p>

        <h2>2. Accounts and trials</h2>
        <p>New accounts start with a 14-day free trial. No card is required to start a trial. After the trial (or if a paid subscription lapses), your account moves to read-only: you can still see and export everything you've recorded, but you can't record anything new until you choose a plan.</p>
        <p>You're responsible for what happens under your account, including the actions of any team member you invite. Keep your password private and tell us if you think someone else has access to your account.</p>

        <h2>3. Billing</h2>
        <p>Paid plans are billed monthly through Paystack. StockFlow never sees or stores your card details, Paystack handles that directly. You can change or cancel your plan at any time from Settings.</p>

        <h2>4. Your data</h2>
        <p>Everything you record in StockFlow (your products, customers, sales, stock and everything else) belongs to you. We don't sell it, and we don't use it to train anything beyond what's needed to answer your own questions inside the Ask StockFlow assistant, which only ever reads your own business's data on your own request.</p>

        <h2>5. Acceptable use</h2>
        <p>Don't use StockFlow to break the law, to store data you don't have the right to store, or to try to access another business's account or data. Don't attempt to disrupt or overload the service.</p>

        <h2>6. Availability</h2>
        <p>We aim to keep StockFlow available and working, including offline support at the till, but we can't promise it will never go down. We'll do our best to fix problems quickly when they happen.</p>

        <h2>7. Ending your account</h2>
        <p>You can stop using StockFlow at any time. If you'd like your data deleted rather than just left read-only, contact us and we'll act on that request.</p>

        <h2>8. Limitation of liability</h2>
        <p>StockFlow is provided as-is. To the extent the law allows, we're not liable for indirect or consequential losses arising from your use of the service. Nothing here limits liability where the law doesn't allow it to be limited.</p>

        <h2>9. Changes to these terms</h2>
        <p>We may update these terms as StockFlow changes. We'll post the new version here with an updated date.</p>

        <h2>10. Governing law</h2>
        <p>These terms are governed by the laws of the Federal Republic of Nigeria.</p>

        <h2>11. Contact</h2>
        <p>Questions about these terms? Reach us on WhatsApp from the <Link to="/">footer</Link>.</p>
      </section>
    </div>
  );
}

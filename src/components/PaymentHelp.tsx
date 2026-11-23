import React from 'react';
import { X, Copy, ExternalLink, PlayCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import { useToast } from '../lib/ToastContext';
import './PaymentHelp.scss';

export type HelpTopic = 'monnify' | 'opay' | 'paystack' | 'till' | 'overview';

// Walkthrough videos, when recorded. Set REACT_APP_HELP_VIDEO_<TOPIC> to a
// YouTube link or an .mp4 URL and the guide shows a player above the steps.
const VIDEO: Record<HelpTopic, string | undefined> = {
  monnify: process.env.REACT_APP_HELP_VIDEO_MONNIFY,
  opay: process.env.REACT_APP_HELP_VIDEO_OPAY,
  paystack: process.env.REACT_APP_HELP_VIDEO_PAYSTACK,
  till: process.env.REACT_APP_HELP_VIDEO_TILL,
  overview: process.env.REACT_APP_HELP_VIDEO_OVERVIEW,
};

interface Step { title: string; body: React.ReactNode; copy?: string; example?: string }
interface Guide {
  title: string; lead: string;
  needs?: string[];
  steps: Step[];
  done?: string[];
  trouble?: { q: string; a: string }[];
  link?: { label: string; href: string };
}

function guides(webhookUrl: string): Record<HelpTopic, Guide> {
  return {
    overview: {
      title: 'How online payments work',
      lead: 'Customers pay into your own Moniepoint, OPay or Paystack account, and ProfixBook marks the sale or invoice paid as soon as the provider confirms the money. ProfixBook never holds your money.',
      steps: [
        { title: 'Open a business account with a provider', body: 'Moniepoint (through Monnify), OPay or Paystack. Use the one you already bank with. The provider will check your ID and business details first. That is their rule, not ours.' },
        { title: 'Connect it here', body: 'Copy two or three keys from the provider\'s dashboard and paste them into ProfixBook. Takes about 5 minutes. Each provider has its own guide: tap the ? on its card.' },
        { title: 'Use it', body: <>At the till, tap <strong>Pay by transfer ✓</strong>: the customer gets an account number (or QR code) for that sale, and the sale completes only when the money lands. On invoices, tap <strong>Pay link</strong> to send a link on WhatsApp.</> },
        { title: 'See every payment', body: <>All confirmed payments appear under <strong>Money received</strong> in the menu, with who paid and what for.</> },
      ],
      trouble: [
        { q: 'Who pays the fee?', a: 'The provider takes a small fee from each payment before it reaches your account, just like when you use their POS or checkout elsewhere. ProfixBook adds no fee of its own.' },
        { q: 'Can I connect more than one?', a: 'Yes. Mark one as Default; the till shows a button for each so the customer can choose.' },
      ],
    },
    monnify: {
      title: 'Connect Moniepoint (Monnify)',
      lead: 'Monnify is Moniepoint\'s payment service for businesses. Once connected, customers can pay you by transfer, card or USSD and the money goes into your Moniepoint business account.',
      needs: [
        'A Monnify business account (separate from the Moniepoint app login). Sign up on monnify.com with your business details.',
        'Your account fully verified (ID and business documents). Until then, only test keys work.',
        'About 5 minutes, and a computer is easier than a phone for copying keys.',
      ],
      steps: [
        { title: 'Open your Monnify dashboard', body: 'Sign in at monnify.com. Make sure you are on your LIVE business, not the test (sandbox) one, unless you just want to try it first.' },
        { title: 'Find your keys under Developer', body: 'In the left menu, open Developer. You will see three things you need: the API key, the Secret key and the Contract code.', example: 'API key looks like MK_PROD_XXXXXXXXXX (test keys start MK_TEST_). Contract code is a 10-digit number.' },
        { title: 'Paste them into ProfixBook', body: <>Back here, tap <strong>Connect Moniepoint</strong> and paste each one into its box. ProfixBook checks them with Monnify straight away and tells you if anything is wrong.</> },
        { title: 'Add the webhook URL in Monnify', body: <>Still under Developer in Monnify, find <strong>Webhook URLs</strong> and paste this into <strong>Transaction Completion</strong>, then save. This lets Monnify tell ProfixBook when an invoice pay link is paid.</>, copy: webhookUrl },
        { title: 'Try it with a small payment', body: <>Ring up a small sale at the till, tap <strong>Moniepoint ✓</strong> (or Pay by transfer ✓), and send the amount to the account number shown. The till switches to "Money received" by itself.</> },
      ],
      done: ['Moniepoint shows "Connected" on the Payments page', 'After the first paid pay link, "Webhook working" gets a tick'],
      trouble: [
        { q: '"Monnify rejected those keys"', a: 'Check you copied the whole key with no spaces, and that the API key and secret key come from the same business. Test keys (MK_TEST_) and live keys can\'t be mixed.' },
        { q: '"Could not find specified contract"', a: 'The contract code doesn\'t match the keys. Copy it again from the same Developer page.' },
        { q: 'The till works but pay links don\'t mark invoices paid', a: 'The webhook URL is missing in Monnify (step 4). The till checks Monnify directly, so it works without it; pay links need it.' },
        { q: 'A pay link stopped working', a: 'Monnify links last 40 minutes. Send a new one from the invoice.' },
      ],
      link: { label: 'Monnify developer docs', href: 'https://developers.monnify.com/docs/' },
    },
    opay: {
      title: 'Connect OPay',
      lead: 'Customers pay with the OPay app, a bank transfer or a card, and the money goes into your OPay business (merchant) account.',
      needs: [
        'An OPay merchant (business) account with online payments switched on. Your normal OPay app account is not enough; OPay\'s business team can upgrade you.',
        'Your public key, secret key and merchant ID from the OPay Business dashboard.',
      ],
      steps: [
        { title: 'Open your OPay Business dashboard', body: 'Sign in to your OPay merchant dashboard on a computer.' },
        { title: 'Copy your keys', body: 'Open API Keys & Webhooks. Copy the Public key and the Secret key. Your Merchant ID is shown in the dashboard too (OPay support can tell you if you can\'t find it).', example: 'Public key starts OPAYPUB, secret key starts OPAYPRV, merchant ID is a long number like 256612345678901.' },
        { title: 'Paste them into ProfixBook', body: <>Tap <strong>Connect OPay</strong>, choose <strong>Real payments</strong> (or Testing if you have sandbox keys), and paste the three values. ProfixBook checks them with OPay before saving.</> },
        { title: 'No webhook to set', body: 'ProfixBook tells OPay where to confirm with every payment, so there is nothing to paste into OPay.' },
        { title: 'Try it with a small payment', body: <>At the till, tap <strong>OPay ✓</strong>. The customer scans the QR code with their phone and pays. The sale completes when OPay confirms.</> },
      ],
      done: ['OPay shows "Connected" on the Payments page'],
      trouble: [
        { q: '"OPay rejected those keys"', a: 'The secret key or merchant ID is wrong, or you picked Real payments with test keys (or the other way round).' },
        { q: '"merchant not configured with this function"', a: 'Online checkout isn\'t switched on for your OPay merchant account yet. Ask OPay\'s business support to enable Cashier / online payments.' },
      ],
      link: { label: 'OPay developer docs', href: 'https://doc.opaycheckout.com/' },
    },
    paystack: {
      title: 'Connect Paystack',
      lead: 'Customers pay by card, transfer, USSD or QR into your Paystack account.',
      needs: ['A Paystack account that has been activated for live payments.'],
      steps: [
        { title: 'Open your Paystack dashboard', body: 'Sign in at dashboard.paystack.com.' },
        { title: 'Copy your keys', body: 'Go to Settings → API Keys & Webhooks. Copy the Secret key and the Public key.', example: 'Live keys start sk_live_ and pk_live_ (test keys: sk_test_, pk_test_).' },
        { title: 'Paste them into ProfixBook', body: <>Tap <strong>Connect Paystack</strong> and paste both keys.</> },
        { title: 'Add the webhook URL in Paystack', body: <>On the same Paystack page, paste this into <strong>Webhook URL</strong> and save.</>, copy: webhookUrl },
        { title: 'Try it', body: 'Send yourself a pay link from a small invoice, or use Pay by transfer ✓ at the till.' },
      ],
      done: ['Paystack shows "Connected"', 'After the first payment, "Webhook working" gets a tick'],
      trouble: [{ q: '"Paystack rejected that secret key"', a: 'Copy it again from Settings → API Keys & Webhooks; make sure it is the secret key, not the public one.' }],
      link: { label: 'Paystack', href: 'https://dashboard.paystack.com' },
    },
    till: {
      title: 'Pay by transfer at the till',
      lead: 'The safe way to take a transfer: the till only completes the sale when the money has really arrived, so a fake alert or screenshot can\'t fool it.',
      steps: [
        { title: 'Add the items as normal', body: 'Pick the customer too if it\'s a regular.' },
        { title: 'Tap Pay by transfer ✓', body: 'If the shop has more than one account (e.g. Moniepoint and OPay), tap the one the customer wants to pay into. Then tap Show transfer details.' },
        { title: 'Show the customer the screen', body: 'Moniepoint: they transfer the exact amount to the account number shown (it works for this sale only, for 40 minutes). OPay or Paystack: they scan the QR code with their phone and pay.' },
        { title: 'Wait for "Money received"', body: 'The till checks by itself every few seconds. When the money lands it says Money received and finishes the sale. Then print or WhatsApp the receipt.' },
      ],
      trouble: [
        { q: 'The customer shows a screenshot but the till is still waiting', a: 'Don\'t hand over the goods yet. Tap "Customer says they paid" to check again. Transfers usually land within a minute. If it never arrives, the transfer didn\'t happen.' },
        { q: 'The customer sent the wrong amount', a: 'The sale won\'t complete. The money is recorded for the owner under Money received. Cancel and start again for the right amount, or ask the owner.' },
        { q: 'The account number expired', a: 'Tap Check again in case they paid, otherwise tap New account number.' },
      ],
    },
  };
}

function toEmbed(url: string): { kind: 'youtube' | 'video'; src: string } {
  const yt = url.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
  return yt ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${yt[1]}` } : { kind: 'video', src: url };
}

export default function PaymentHelp({ topic, webhookUrl, onClose, onConnect }: {
  topic: HelpTopic; webhookUrl: string; onClose: () => void; onConnect?: () => void;
}) {
  const toast = useToast();
  const g = guides(webhookUrl)[topic];
  const video = VIDEO[topic];
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied.'); } catch { toast.error('Could not copy. Press and hold to copy.'); }
  };

  return (
    <Modal onClose={onClose} maxWidth={620}>
      <div className="modal-header">
        <h2>{g.title}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body ph">
        <p className="ph-lead">{g.lead}</p>

        {video && (() => {
          const v = toEmbed(video);
          return (
            <div className="ph-video">
              {v.kind === 'youtube'
                ? <iframe src={v.src} title={`${g.title} video`} allow="encrypted-media; picture-in-picture" allowFullScreen />
                : <video src={v.src} controls preload="metadata"><track kind="captions" /></video>}
              <span><PlayCircle size={14} aria-hidden="true" /> Watch the short walkthrough, or follow the steps below.</span>
            </div>
          );
        })()}

        {g.needs && (
          <section className="ph-needs">
            <h3>Before you start</h3>
            <ul>{g.needs.map(n => <li key={n}>{n}</li>)}</ul>
          </section>
        )}

        <ol className="ph-steps">
          {g.steps.map((s, i) => (
            <li key={s.title}>
              <span className="ph-num" aria-hidden="true">{i + 1}</span>
              <div className="ph-step-body">
                <span className="ph-step-title">{s.title}</span>
                <p>{s.body}</p>
                {s.example && <p className="ph-example">{s.example}</p>}
                {s.copy && (
                  <div className="ph-copy">
                    <code>{s.copy}</code>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => copy(s.copy!)}><Copy size={13} /> Copy</button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        {g.done && (
          <section className="ph-done">
            <h3><CheckCircle2 size={15} aria-hidden="true" /> You're set up when</h3>
            <ul>{g.done.map(d => <li key={d}>{d}</li>)}</ul>
          </section>
        )}

        {g.trouble && (
          <section className="ph-trouble">
            <h3><AlertTriangle size={15} aria-hidden="true" /> If something goes wrong</h3>
            {g.trouble.map(t => (
              <details key={t.q}>
                <summary>{t.q}</summary>
                <p>{t.a}</p>
              </details>
            ))}
          </section>
        )}

        {g.link && (
          <a className="ph-link" href={g.link.href} target="_blank" rel="noreferrer">{g.link.label} <ExternalLink size={13} aria-hidden="true" /></a>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        {onConnect && <button type="button" className="btn-primary" onClick={onConnect}>I have my keys, connect now</button>}
      </div>
    </Modal>
  );
}

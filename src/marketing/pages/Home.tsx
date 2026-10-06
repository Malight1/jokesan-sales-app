import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CheckCircle2, Store, Factory, WifiOff, MessageCircle, CreditCard,
  ShieldCheck, Building2, UserPlus, PackagePlus, TrendingUp, Check,
} from 'lucide-react';
import ScreenshotFrame, { PhoneFrame } from '../ScreenshotFrame';
import PlanCards from '../PlanCards';
import Reveal from '../Reveal';
import useMeta from '../useMeta';

// Short, checkable claims only. Every one of these is a shipped feature.
const PROOF = [
  { icon: WifiOff, label: 'Sells with no network' },
  { icon: MessageCircle, label: 'WhatsApp invoices and reminders' },
  { icon: CreditCard, label: 'Paystack pay links' },
  { icon: ShieldCheck, label: 'NAFDAC batch and expiry tracking' },
  { icon: Building2, label: 'Multiple branches' },
];

type Audience = 'shop' | 'maker';

const AUDIENCES: Record<Audience, {
  tab: string; icon: typeof Store; who: string; title: string; points: string[];
  shot: { src: string; alt: string; w: number; h: number }; signup: string;
}> = {
  shop: {
    tab: 'I run a shop',
    icon: Store,
    who: 'Supermarkets, pharmacies, provision stores, boutiques, phone and spare-parts shops',
    title: 'Run the whole shop from the till.',
    points: [
      'Ring up a sale in seconds: tap, scan a barcode, or search. Cash, transfer or credit.',
      'Buy stock from a supplier and see your margin on every item before you save.',
      'Know what is running out, what has not sold in 30 days, and how much cash is sitting on your shelves.',
      'Sell on credit, then send a polite WhatsApp reminder in one tap.',
      'Expiry dates for drugs and food, and the option to sell the earliest-expiring stock first.',
    ],
    shot: { src: '/screenshots/retail-dashboard.webp', alt: 'ProfixBook shop dashboard: today’s takings, cash tied up in stock, who owes you', w: 1600, h: 1017 },
    signup: '/login?signup=1&type=retail',
  },
  maker: {
    tab: 'I make products',
    icon: Factory,
    who: 'Soap, cosmetics, food and drinks, bakeries, water, plastics, chemicals',
    title: 'From raw material to real profit.',
    points: [
      'Recipes turn raw materials into finished goods, costed layer by layer, so every sale shows its true margin.',
      'Batch numbers, expiry dates and NAFDAC-ready labels, with a full recall trace.',
      'Reorder suggestions for raw materials, worked out from how fast you actually use them.',
      'Separate stock per branch or depot, with transfers that keep the original cost.',
      'A storekeeper view that shows what to buy, what to produce and what is about to expire.',
    ],
    shot: { src: '/screenshots/storekeeper.webp', alt: 'ProfixBook storekeeper view: items to reorder or produce, and batches expiring soon', w: 1600, h: 922 },
    signup: '/login?signup=1&type=manufacturing',
  },
};

const PROBLEMS: { problem: string; solution: React.ReactNode }[] = [
  { problem: "I sell for what feels right. I don't actually know my margin.",
    solution: <>Every sale is costed from the exact stock it came from, so <b>profit is real</b>, not a guess.</> },
  { problem: 'Most inventory apps assume I make things. I just buy and sell.',
    solution: <>Pick <b>shop</b> when you sign up and you get a till-first dashboard. No raw materials, no production screens.</> },
  { problem: 'Someone sent a fake bank alert and I only found out at closing.',
    solution: <><b>Paystack pay links</b> confirm themselves the moment the money actually lands.</> },
  { problem: 'Customers owe me money and I am too shy to keep chasing them.',
    solution: <>See <b>who owes what and for how long</b>, then send a ready-made WhatsApp reminder.</> },
  { problem: 'Network goes and my sales stop.',
    solution: <>The till <b>keeps selling offline</b> and syncs everything when the network is back.</> },
  { problem: 'One branch runs out while another has too much.',
    solution: <><b>Stock per branch</b>, transfers between them, and alerts before anything runs out.</> },
];

const STEPS = [
  { icon: UserPlus, title: 'Sign up in two minutes', body: 'Tell us your business name and whether you run a shop or make products. No card needed.' },
  { icon: PackagePlus, title: 'Add your products', body: 'Type them in, scan their barcodes, or bring them all in from an Excel sheet at once.' },
  { icon: TrendingUp, title: 'Sell and see your profit', body: 'Start ringing up sales. Your dashboard shows takings, profit and who owes you from day one.' },
];

const MINI_FAQ = [
  { q: 'Does it work on my phone?', a: 'Yes. ProfixBook runs in the browser on any phone, tablet or laptop, and you can add it to your home screen like an app. Nothing to install.' },
  { q: 'Can my staff use it without seeing my profit?', a: 'Yes. Cashiers, storekeepers and accountants each get their own login and only see what their role needs. Costs and profit stay with you.' },
  { q: 'What happens after the 14-day trial?', a: 'Choose a plan to keep going. If you don’t, your account becomes read-only. Nothing is deleted.' },
];

function AudienceSwitcher() {
  const [active, setActive] = useState<Audience>('shop');
  const tabs = useRef<Record<Audience, HTMLButtonElement | null>>({ shop: null, maker: null });
  const order: Audience[] = ['shop', 'maker'];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = order[(order.indexOf(active) + 1) % order.length];
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <section id="who-its-for" className="mkt-section mkt-audience">
      <Reveal className="mkt-section__head">
        <span className="mkt-eyebrow">Who it's for</span>
        <h2>Built for how your business actually works.</h2>
        <p>A shop and a factory don't need the same screens. Tell us which you are and ProfixBook shapes itself around it.</p>
      </Reveal>

      <div className="mkt-audience__tabs" role="tablist" aria-label="Type of business" onKeyDown={onKey}>
        {order.map(id => {
          const a = AUDIENCES[id];
          return (
            <button
              key={id}
              ref={el => { tabs.current[id] = el; }}
              role="tab"
              id={`aud-tab-${id}`}
              aria-selected={active === id}
              aria-controls={`aud-panel-${id}`}
              tabIndex={active === id ? 0 : -1}
              className={active === id ? 'is-on' : ''}
              onClick={() => setActive(id)}
            >
              <a.icon size={18} aria-hidden="true" /> {a.tab}
            </button>
          );
        })}
      </div>

      {order.map(id => {
        const a = AUDIENCES[id];
        return (
          <div
            key={id}
            role="tabpanel"
            id={`aud-panel-${id}`}
            aria-labelledby={`aud-tab-${id}`}
            hidden={active !== id}
            className="mkt-audience__panel"
          >
            <div className="mkt-audience__copy">
              <p className="mkt-audience__who">{a.who}</p>
              <h3>{a.title}</h3>
              <ul>
                {a.points.map(p => <li key={p}><Check size={16} aria-hidden="true" /> <span>{p}</span></li>)}
              </ul>
              <Link to={a.signup} className="btn-primary btn-lg">Start free as {id === 'shop' ? 'a shop' : 'a manufacturer'} <ArrowRight size={16} /></Link>
            </div>
            <ScreenshotFrame src={a.shot.src} alt={a.shot.alt} width={a.shot.w} height={a.shot.h} className="mkt-audience__shot" />
          </div>
        );
      })}
    </section>
  );
}

export default function Home() {
  useMeta(
    'ProfixBook, Inventory & Sales for Nigerian Businesses',
    'Point of sale, stock, purchases and debtors in one place. Know your real profit. Built for Nigerian shops, supermarkets, pharmacies and manufacturers, and it keeps selling when the network drops.'
  );
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-hero__copy">
          <span className="mkt-hero__kicker">For shops, supermarkets, pharmacies and manufacturers</span>
          <h1>Know your real profit, whether you make it or resell it.</h1>
          <p>Sales, stock, purchases and debtors in one place. A till that keeps working when the network drops, and a dashboard that shows what you actually made.</p>
          <div className="mkt-hero__cta">
            <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
            <a href="#who-its-for" className="btn-secondary btn-lg">See it for your business</a>
          </div>
          <ul className="mkt-hero__trust">
            <li><CheckCircle2 size={15} aria-hidden="true" /> 14-day free trial</li>
            <li><CheckCircle2 size={15} aria-hidden="true" /> No card needed</li>
            <li><CheckCircle2 size={15} aria-hidden="true" /> Phone, tablet or laptop</li>
          </ul>
        </div>
        <div className="mkt-hero__visual">
          <ScreenshotFrame src="/screenshots/pos.webp" alt="ProfixBook point of sale with a customer's basket" width={1800} height={1125} eager className="mkt-hero__shot" />
          <PhoneFrame src="/screenshots/pos-mobile.webp" alt="The same till on a phone" width={700} height={1256} eager className="mkt-hero__phone" />
        </div>
      </section>

      <section className="mkt-proof" aria-label="What's included">
        <ul>
          {PROOF.map(p => <li key={p.label}><p.icon size={17} aria-hidden="true" /> {p.label}</li>)}
        </ul>
      </section>

      <AudienceSwitcher />

      <section id="how-it-helps" className="mkt-section mkt-section--alt">
        <Reveal className="mkt-section__head">
          <span className="mkt-eyebrow">Sound familiar?</span>
          <h2>Where Nigerian businesses quietly lose money.</h2>
          <p>And what ProfixBook does about each one.</p>
        </Reveal>
        <div className="mkt-pgrid">
          {PROBLEMS.map((p, i) => (
            <Reveal delay={Math.min(i, 5) * 60} key={i} className="mkt-pcard">
              <p className="mkt-pcard__problem">&ldquo;{p.problem}&rdquo;</p>
              <p className="mkt-pcard__solution"><CheckCircle2 size={16} aria-hidden="true" /> <span>{p.solution}</span></p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mkt-section">
        <Reveal className="mkt-section__head">
          <span className="mkt-eyebrow">Getting started</span>
          <h2>Selling today, not next month.</h2>
        </Reveal>
        <div className="mkt-steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 80} className="mkt-step">
              <span className="mkt-step__num" aria-hidden="true">{i + 1}</span>
              <s.icon size={22} aria-hidden="true" className="mkt-step__icon" />
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mkt-section mkt-section--alt">
        <Reveal className="mkt-owner">
          <div className="mkt-owner__copy">
            <span className="mkt-eyebrow">For the owner</span>
            <h2>See the money, not just the sales.</h2>
            <ul>
              <li><Check size={16} aria-hidden="true" /> <span>Sales, real profit and profit after expenses, this month against last.</span></li>
              <li><Check size={16} aria-hidden="true" /> <span>Who owes you, who you owe, and for how long.</span></li>
              <li><Check size={16} aria-hidden="true" /> <span>Every branch side by side, so you know which one is carrying the business.</span></li>
              <li><Check size={16} aria-hidden="true" /> <span>Staff get their own logins. Cashiers never see your costs.</span></li>
            </ul>
            <Link to="/product" className="mkt-link">See everything ProfixBook does <ArrowRight size={14} /></Link>
          </div>
          <ScreenshotFrame src="/screenshots/mfg-dashboard.webp" alt="Owner dashboard: sales, gross profit, money owed, and branches this month" width={1600} height={1397} className="mkt-owner__shot" />
        </Reveal>
      </section>

      <section className="mkt-section">
        <Reveal className="mkt-section__head">
          <span className="mkt-eyebrow">Pricing</span>
          <h2>Simple plans. Start free, upgrade when you grow.</h2>
        </Reveal>
        <PlanCards />
        <p className="mkt-pricing__note">Every plan starts with a 14-day free trial. Pay monthly or yearly. <Link to="/pricing">Compare plans <ArrowRight size={14} /></Link></p>
      </section>

      <section className="mkt-section mkt-section--alt">
        <Reveal className="mkt-section__head">
          <span className="mkt-eyebrow">Questions</span>
          <h2>What people ask before they start.</h2>
        </Reveal>
        <div className="mkt-faq-list">
          {MINI_FAQ.map(f => (
            <details key={f.q} className="mkt-faq-item">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p className="mkt-pricing__note"><Link to="/faq">More answers <ArrowRight size={14} /></Link></p>
      </section>

      <section className="mkt-final-cta">
        <Reveal>
          <h2>Stop guessing your profit.</h2>
          <p>Free for 14 days. Set up in minutes. No card required.</p>
          <div className="mkt-final-cta__actions">
            <Link to="/login?signup=1&type=retail" className="btn-primary btn-lg"><Store size={18} aria-hidden="true" /> Start as a shop</Link>
            <Link to="/login?signup=1&type=manufacturing" className="btn-secondary btn-lg mkt-final-cta__alt"><Factory size={18} aria-hidden="true" /> Start as a manufacturer</Link>
          </div>
        </Reveal>
      </section>
    </>
  );
}

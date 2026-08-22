import React, { useState, useMemo, useEffect } from 'react';
import { Search, Plus, Minus, Trash2, ShoppingCart, CheckCircle2, FileText, MessageCircle, X, CloudOff, ScanLine, Calculator, Delete } from 'lucide-react';
import {
  sales as salesApi, finishedGoods as goodsApi, customers as customersApi, lookups, branding,
  FinishedGood, Customer, Lookup,
} from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateInvoicePdf } from '../lib/invoice';
import { whatsappLink } from '../lib/whatsapp';
import { looksOffline } from '../lib/offlineCache';
import { enqueueSale } from '../lib/offlineQueue';
import { Loading, ErrorState } from '../components/DataStates';
import OfflineBanner from '../components/OfflineBanner';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import './POS.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

interface CartLine { good: FinishedGood; qty: number; }

// Round-number cash amounts a cashier would actually hand over (matches
// real naira notes), so "Cash given" is usually a tap instead of typing.
function quickCashOptions(total: number): number[] {
  if (total <= 0) return [];
  const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;
  const out = [total, roundUp(total, 500), roundUp(total, 1000), roundUp(total, 5000)];
  const seen = new Set<number>();
  return out.filter(v => (seen.has(v) ? false : (seen.add(v), true))).slice(0, 4);
}

function quickPartOptions(total: number): number[] {
  if (total <= 0) return [];
  const half = Math.round(total * 0.5 / 50) * 50;
  const out = [half, total];
  const seen = new Set<number>();
  return out.filter(v => v > 0 && (seen.has(v) ? false : (seen.add(v), true)));
}

// On-screen numeric pad — for tablet/touchscreen counters with no physical
// keyboard. Keeps its own typed-digit buffer (rather than formatting the
// numeric value back out) so "10" then "0" reads as "100", not "10.0".
function NumericKeypad({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [buf, setBuf] = useState(value === 0 ? '' : String(value));

  // Re-sync when the amount changes from outside (a quick-cash chip tap,
  // typing directly in the field, or the panel resetting) — not on every
  // keystroke, since that would fight the buffer mid-press.
  useEffect(() => {
    if ((parseFloat(buf) || 0) !== value) setBuf(value === 0 ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const press = (k: string) => {
    let next = buf;
    if (k === 'C') next = '';
    else if (k === '⌫') next = buf.slice(0, -1);
    else if (k === '.') next = buf.includes('.') ? buf : (buf === '' ? '0.' : buf + '.');
    else next = buf === '0' ? k : buf + k;
    setBuf(next);
    onChange(parseFloat(next) || 0);
  };

  return (
    <div className="numeric-keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => (
        <button key={k} type="button" onClick={() => press(k)}>
          {k === '⌫' ? <Delete size={18} /> : k}
        </button>
      ))}
      <button type="button" className="kp-clear" onClick={() => press('C')}>Clear</button>
    </div>
  );
}

export default function POS() {
  const toast = useToast();
  const { tenant } = useAuth();
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), [], { cacheKey: 'pos-goods' });
  const custQ = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'pos-customers' });
  const payQ = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const [checkingOut, setCheckingOut] = useState(false);

  const [search, setSearch] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [payTypeId, setPayTypeId] = useState('');
  const [tendered, setTendered] = useState(0);
  const [payMode, setPayMode] = useState<'full' | 'part' | 'credit'>('full');
  const [showKeypad, setShowKeypad] = useState(false);
  const [done, setDone] = useState<{ total: number; paid: number; subtotal: number; vat: number; vatRate: number; offline?: boolean } | null>(null);

  const goods = useMemo(() => goodsQ.data ?? [], [goodsQ.data]);
  const filtered = useMemo(
    () => goods.filter(g => g.name.toLowerCase().includes(search.toLowerCase())),
    [goods, search]
  );

  const subtotal = cart.reduce((s, l) => s + l.qty * l.good.selling_price, 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = subtotal * vatRate / 100;
  const total = subtotal + vatAmt;
  const paid = payMode === 'full' ? total : payMode === 'credit' ? 0 : Math.min(tendered, total);
  const change = payMode === 'full' && tendered > total ? tendered - total : 0;

  const addToCart = (g: FinishedGood) => {
    if (g.qty_balance <= 0) { toast.error(`${g.name} is out of stock.`); return; }
    setCart(c => {
      const ex = c.find(l => l.good.id === g.id);
      if (ex) {
        if (ex.qty >= g.qty_balance) { toast.error(`Only ${g.qty_balance} of ${g.name} in stock.`); return c; }
        return c.map(l => l.good.id === g.id ? { ...l, qty: l.qty + 1 } : l);
      }
      return [...c, { good: g, qty: 1 }];
    });
  };

  const handleScan = (code: string) => {
    setShowScanner(false);
    const match = goods.find(g => g.barcode === code);
    if (match) { addToCart(match); toast.success(`${match.name} added.`); }
    else toast.error(`No product matches barcode ${code}.`);
  };

  const setQty = (id: string, qty: number) => {
    setCart(c => c.flatMap(l => {
      if (l.good.id !== id) return [l];
      if (qty <= 0) return [];
      const capped = Math.min(qty, l.good.qty_balance);
      return [{ ...l, qty: capped }];
    }));
  };

  const clearSale = () => {
    setCart([]); setCustomerId(''); setTendered(0); setPayMode('full'); setShowKeypad(false);
  };

  const checkout = async () => {
    if (cart.length === 0) { toast.error('Cart is empty.'); return; }
    if (payMode !== 'credit' && !payTypeId) { toast.error('Select a payment method.'); return; }
    if (payMode === 'full' && tendered < total) { toast.error('Cash given is less than the total.'); return; }
    const payload = {
      customerId: customerId || null,
      date: new Date().toISOString().split('T')[0],
      paymentTypeId: payTypeId || null,
      amountPaid: paid,
      items: cart.map(l => ({ finished_good_id: l.good.id, quantity: l.qty, unit_price: l.good.selling_price })),
      vatRate,
    };
    setCheckingOut(true);
    try {
      await salesApi.create(payload);
      setDone({ total, paid, subtotal, vat: vatAmt, vatRate });
      goodsQ.refetch();
    } catch (e: any) {
      if (looksOffline(e)) {
        // Keep selling — the sale is queued locally and replayed through the
        // real FIFO engine the moment connectivity returns (useOnlineSync).
        // Stock shown here is decremented optimistically so the same items
        // aren't oversold twice before that sync happens.
        const label = `${cart.reduce((s, l) => s + l.qty, 0)} item(s) — ${fmt(total)} — ${customerId ? customerName(customerId) : 'Walk-in'}`;
        enqueueSale(payload, label);
        goodsQ.setData(prev => prev ? prev.map(g => {
          const line = cart.find(l => l.good.id === g.id);
          return line ? { ...g, qty_balance: g.qty_balance - line.qty } : g;
        }) : prev);
        toast.info('Offline — sale saved on this device and will sync automatically.');
        setDone({ total, paid, subtotal, vat: vatAmt, vatRate, offline: true });
      } else {
        toast.error(e.message ?? 'Sale failed.');
      }
    } finally {
      setCheckingOut(false);
    }
  };

  const customerName = (id: string) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };

  // ---- success screen ----
  if (done) {
    const cust = custQ.data?.find(c => c.id === customerId);
    const receiptItems = cart.map(l => ({ name: l.good.name, qty: l.qty, unitPrice: l.good.selling_price, amount: l.qty * l.good.selling_price }));
    const invNo = 'INV-' + Date.now().toString().slice(-8);
    const sendWa = () => {
      const lines = [
        `Hello ${customerId ? customerName(customerId) : 'there'}! 🧾`, '',
        `*${tenant?.name ?? 'Receipt'}*`,
        `Total: ₦${done.total.toLocaleString()}`,
        `Paid: ₦${done.paid.toLocaleString()}`,
        done.total - done.paid > 0 ? `Balance: ₦${(done.total - done.paid).toLocaleString()}` : `Status: PAID ✅`,
        '', 'Thank you!',
      ];
      window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
    };
    const dl = async () => {
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      await generateInvoicePdf({
        companyName: tenant?.name ?? 'My Business', invoiceNo: invNo,
        date: new Date().toISOString().split('T')[0],
        customerName: customerId ? customerName(customerId) : 'Walk-in Customer',
        customerPhone: cust?.phone, customerAddress: cust?.address,
        items: receiptItems, total: done.total, paid: done.paid, balance: done.total - done.paid,
        subtotal: done.subtotal, vatAmount: done.vat, vatRate: done.vatRate,
        tin: tenant?.tin, logoDataUrl: logo,
      });
    };
    return (
      <div className="pos-success">
        {done.offline ? <CloudOff size={54} color="#d97706" /> : <CheckCircle2 size={54} color="#16a34a" />}
        <h1 style={done.offline ? { color: '#d97706' } : undefined}>{done.offline ? 'Saved Offline' : 'Sale Complete'}</h1>
        {done.offline && <p style={{ color: '#64748b', fontSize: '0.85rem', maxWidth: 320, textAlign: 'center' }}>No network right now — this sale is queued on this device and will sync automatically the moment you're back online.</p>}
        <div className="success-figures">
          <div><span>Total</span><strong>{fmt(done.total)}</strong></div>
          <div><span>Paid</span><strong>{fmt(done.paid)}</strong></div>
          {change > 0 && <div className="change"><span>Change</span><strong>{fmt(change)}</strong></div>}
          {done.total - done.paid > 0 && <div className="bal"><span>Balance</span><strong>{fmt(done.total - done.paid)}</strong></div>}
        </div>
        <div className="success-actions">
          <button className="btn-secondary" onClick={dl}><FileText size={16} /> Invoice PDF</button>
          <button className="btn-secondary" onClick={sendWa}><MessageCircle size={16} /> WhatsApp Receipt</button>
        </div>
        <button className="btn-primary big" onClick={() => { setDone(null); clearSale(); }}>New Sale</button>
      </div>
    );
  }

  if (goodsQ.loading) return <Loading label="Loading products…" />;
  if (goodsQ.error) return <ErrorState message={goodsQ.error} onRetry={goodsQ.refetch} />;

  return (
    <div className="pos">
      {/* Product grid */}
      <div className="pos-products">
        {goodsQ.isOffline && <OfflineBanner label="product list" />}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.85rem' }}>
          <div className="pos-search" style={{ marginBottom: 0, flex: 1 }}>
            <Search size={16} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" autoFocus />
          </div>
          <button className="btn-secondary" onClick={() => setShowScanner(true)} title="Scan barcode"><ScanLine size={16} /> Scan</button>
        </div>
        <div className="product-grid">
          {filtered.map(g => (
            <button key={g.id} className={`product-tile ${g.qty_balance <= 0 ? 'out' : ''}`} onClick={() => addToCart(g)} disabled={g.qty_balance <= 0}>
              <div className="p-name">{g.name}</div>
              <div className="p-price">{fmt(g.selling_price)}</div>
              <div className={`p-stock ${g.qty_balance <= 0 ? 'zero' : g.qty_balance <= g.min_stock_level ? 'low' : ''}`}>
                {g.qty_balance <= 0 ? 'Out of stock' : `${g.qty_balance} in stock`}
              </div>
            </button>
          ))}
          {filtered.length === 0 && <p style={{ color: '#94a3b8', gridColumn: '1/-1', padding: '2rem', textAlign: 'center' }}>No products found.</p>}
        </div>
      </div>

      {/* Cart */}
      <div className="pos-cart">
        <div className="cart-head">
          <ShoppingCart size={18} /> <h2>Current Sale</h2>
          {cart.length > 0 && <button className="clear-btn" onClick={clearSale} title="Clear"><Trash2 size={15} /></button>}
        </div>

        <div className="cart-lines">
          {cart.length === 0 ? (
            <div className="cart-empty"><ShoppingCart size={28} /><p>Tap a product to start</p></div>
          ) : cart.map(l => (
            <div key={l.good.id} className="cart-line">
              <div className="cl-info">
                <div className="cl-name">{l.good.name}</div>
                <div className="cl-price">{fmt(l.good.selling_price)} each</div>
              </div>
              <div className="cl-qty">
                <button onClick={() => setQty(l.good.id, l.qty - 1)}><Minus size={13} /></button>
                <span>{l.qty}</span>
                <button onClick={() => setQty(l.good.id, l.qty + 1)}><Plus size={13} /></button>
              </div>
              <div className="cl-amount">{fmt(l.qty * l.good.selling_price)}</div>
              <button className="cl-remove" onClick={() => setQty(l.good.id, 0)}><X size={13} /></button>
            </div>
          ))}
        </div>

        {cart.length > 0 && (
          <div className="cart-checkout">
            {vatRate > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#64748b' }}>
                <span>Subtotal · VAT {vatRate}%</span><span>{fmt(subtotal)} · {fmt(vatAmt)}</span>
              </div>
            )}
            <div className="cart-total"><span>Total</span><strong>{fmt(total)}</strong></div>

            <select className="cust-select" value={customerId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">Walk-in customer</option>
              {custQ.data?.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name} — {c.company_store}</option>)}
            </select>

            <div className="pay-modes">
              {(['full', 'part', 'credit'] as const).map(m => (
                <button key={m} className={payMode === m ? 'active' : ''} onClick={() => setPayMode(m)}>
                  {m === 'full' ? 'Paid Full' : m === 'part' ? 'Part Pay' : 'Credit'}
                </button>
              ))}
            </div>

            <div className="field-label">Payment method</div>
            <select className="cust-select" value={payTypeId} onChange={e => setPayTypeId(e.target.value)}>
              <option value="">Payment method…</option>
              {payQ.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            {payMode === 'full' && (
              <div className="tender-panel">
                <div className="field-label">
                  Cash given
                  <button
                    type="button"
                    className={`kp-toggle${showKeypad ? ' active' : ''}`}
                    onClick={() => setShowKeypad(k => !k)}
                    aria-label="Toggle on-screen keypad"
                    title="On-screen keypad"
                  >
                    <Calculator size={14} /> Keypad
                  </button>
                </div>
                <div className="amount-field">
                  <span className="affix">₦</span>
                  <NumberInput
                    className="tender-input"
                    value={tendered}
                    onChange={setTendered}
                    placeholder="0"
                    onKeyDown={e => { if (e.key === 'Enter' && tendered >= total) checkout(); }}
                  />
                </div>
                <div className="quick-amounts">
                  {quickCashOptions(total).map((v, i) => (
                    <button
                      key={v}
                      type="button"
                      className={tendered === v ? 'active' : ''}
                      onClick={() => setTendered(v)}
                    >
                      {i === 0 ? 'Exact' : fmt(v)}
                    </button>
                  ))}
                </div>
                {showKeypad && <NumericKeypad value={tendered} onChange={setTendered} />}
                {tendered > 0 && tendered < total && (
                  <div className="tender-feedback short">Still short by <strong>{fmt(total - tendered)}</strong></div>
                )}
                {tendered >= total && tendered > 0 && (
                  change > 0
                    ? <div className="tender-feedback change">Change due <strong>{fmt(change)}</strong></div>
                    : <div className="tender-feedback exact">Exact amount — no change due</div>
                )}
              </div>
            )}
            {payMode === 'part' && (
              <div className="tender-panel">
                <div className="field-label">
                  Amount paid now
                  <button
                    type="button"
                    className={`kp-toggle${showKeypad ? ' active' : ''}`}
                    onClick={() => setShowKeypad(k => !k)}
                    aria-label="Toggle on-screen keypad"
                    title="On-screen keypad"
                  >
                    <Calculator size={14} /> Keypad
                  </button>
                </div>
                <div className="amount-field">
                  <span className="affix">₦</span>
                  <NumberInput className="tender-input" value={tendered} onChange={setTendered} placeholder="0" />
                </div>
                <div className="quick-amounts">
                  {quickPartOptions(total).map(v => (
                    <button key={v} type="button" className={tendered === v ? 'active' : ''} onClick={() => setTendered(v)}>
                      {v === total ? 'Full' : fmt(v)}
                    </button>
                  ))}
                </div>
                {showKeypad && <NumericKeypad value={tendered} onChange={setTendered} />}
                <div className="tender-feedback balance">Balance remaining <strong>{fmt(total - Math.min(tendered, total))}</strong></div>
              </div>
            )}

            <button
              className="btn-primary checkout-btn"
              onClick={checkout}
              disabled={
                checkingOut ||
                (payMode !== 'credit' && !payTypeId) ||
                (payMode === 'full' && tendered < total)
              }
            >
              {checkingOut
                ? 'Processing…'
                : payMode !== 'credit' && !payTypeId
                  ? 'Select payment method'
                  : payMode === 'full' && tendered < total
                    ? 'Enter cash given'
                    : `Charge ${fmt(total)}`}
            </button>
          </div>
        )}
      </div>

      {showScanner && <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />}
    </div>
  );
}

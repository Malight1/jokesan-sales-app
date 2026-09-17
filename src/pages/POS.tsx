import React, { useState, useMemo, useEffect } from 'react';
import { Search, Plus, Minus, Trash2, ShoppingCart, CheckCircle2, FileText, MessageCircle, X, CloudOff, ScanLine, Calculator, Delete, Undo2, Tag } from 'lucide-react';
import {
  sales as salesApi, finishedGoods as goodsApi, customers as customersApi, lookups, branding, stock, pricing, productUnits,
  FinishedGood, Customer, Lookup, StockLevel, SalesOrder, PriceList, PriceListItem, CustomerType, ProductUnit,
} from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { hasFeature } from '../lib/features';
import { resolvePriceLocal, PriceContext } from '../lib/pricing';
import { generateInvoicePdf } from '../lib/invoice';
import { whatsappLink } from '../lib/whatsapp';
import { looksOffline } from '../lib/offlineCache';
import { enqueueSale } from '../lib/offlineQueue';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct, decrementAt } from '../lib/branchStock';
import { Loading, ErrorState } from '../components/DataStates';
import OfflineBanner from '../components/OfflineBanner';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import Modal from '../components/Modal';
import ApprovalModal from '../components/ApprovalModal';
import LinePriceModal from '../components/LinePriceModal';
import TillHeader from '../components/TillHeader';
import OpenTillScreen from '../components/OpenTillScreen';
import { useTillGate } from '../lib/useTillGate';
import { ReturnModal } from './Sales';
import './POS.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const NEEDS_APPROVAL = /manager'?s? pin/i;

// unitPrice defaults to the resolved list price; `manual` marks a line the
// cashier has hand-priced, so switching the customer later re-prices
// everything EXCEPT what was deliberately discounted.
interface CartLine { good: FinishedGood; qty: number; unitPrice: number; manual?: boolean; discountReason?: string; }

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
  const { multi, myBranchId, myBranchName } = useBranches();
  const till = useTillGate();
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), [], { cacheKey: 'pos-goods' });
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(myBranchId), [myBranchId],
    { cacheKey: `pos-levels-${myBranchId ?? 'default'}` });
  const custQ = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'pos-customers' });
  const payQ = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const tiersEnabled = hasFeature(tenant?.plan, 'price_tiers');
  const listsQ = useQuery<PriceList[]>(() => tiersEnabled ? pricing.lists() : Promise.resolve([]), [tiersEnabled], { cacheKey: 'pos-price-lists' });
  const priceItemsQ = useQuery<PriceListItem[]>(() => tiersEnabled ? pricing.allItems() : Promise.resolve([]), [tiersEnabled], { cacheKey: 'pos-price-items' });
  const custTypesQ = useQuery<CustomerType[]>(() => tiersEnabled ? pricing.customerTypes() : Promise.resolve([]), [tiersEnabled], { cacheKey: 'pos-cust-types' });
  const [checkingOut, setCheckingOut] = useState(false);

  const [search, setSearch] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [payTypeId, setPayTypeId] = useState('');
  const [tendered, setTendered] = useState(0);
  const [payMode, setPayMode] = useState<'full' | 'part' | 'credit'>('full');
  const [showKeypad, setShowKeypad] = useState(false);
  const [discountLine, setDiscountLine] = useState<CartLine | null>(null);
  const [orderDiscount, setOrderDiscount] = useState(0);
  const [showOrderDiscount, setShowOrderDiscount] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [done, setDone] = useState<{
    total: number; paid: number; subtotal: number; vat: number; vatRate: number;
    offline?: boolean; docNo?: string | null;
  } | null>(null);

  const priceCtx: PriceContext = useMemo(() => ({
    priceListItems: priceItemsQ.data ?? [],
    defaultListId: listsQ.data?.find(l => l.is_default && l.is_active)?.id ?? null,
    customers: custQ.data ?? [],
    customerTypes: custTypesQ.data ?? [],
  }), [priceItemsQ.data, listsQ.data, custQ.data, custTypesQ.data]);
  const resolvedPrice = (g: FinishedGood, qty: number) => resolvePriceLocal(g.id, qty, customerId || null, priceCtx, g.selling_price);

  // Picking a customer reprices every line to their tier — except one the
  // cashier has already hand-discounted, which stays exactly as set.
  useEffect(() => {
    setCart(c => c.map(l => l.manual ? l : { ...l, unitPrice: resolvedPrice(l.good, l.qty) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, priceItemsQ.data, listsQ.data]);

  // Returns, found by invoice number rather than a full sales list — POS
  // never loads one. Needs a connection: unlike a sale, a return checks
  // FIFO batches and balances live, so it can't be queued offline.
  const [showFindReturn, setShowFindReturn] = useState(false);
  const [findDocNo, setFindDocNo] = useState('');
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [returnSale, setReturnSale] = useState<SalesOrder | null>(null);

  const goods = useMemo(() => goodsQ.data ?? [], [goodsQ.data]);
  // What THIS branch can sell. The company total on the product row would
  // let the Lagos till try to sell stock that's sitting in Abuja, and
  // expired or recalled stock can't be sold at all (0022) — the server
  // refuses both, so the till must show the same number it enforces.
  const here = useMemo(
    () => qtyByProduct((levelsQ.data ?? []).filter(l => l.product_kind === 'finished_good'), myBranchId, 'sellable'),
    [levelsQ.data, myBranchId],
  );
  const avail = (g: FinishedGood) => (levelsQ.data ? here.get(g.id) ?? 0 : g.qty_balance);
  const where = multi ? `at ${myBranchName}` : 'in stock';
  const filtered = useMemo(
    () => goods.filter(g => g.name.toLowerCase().includes(search.toLowerCase())),
    [goods, search]
  );

  const cartSubtotal = cart.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const subtotal = Math.max(cartSubtotal - orderDiscount, 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = subtotal * vatRate / 100;
  const total = subtotal + vatAmt;
  const paid = payMode === 'full' ? total : payMode === 'credit' ? 0 : Math.min(tendered, total);
  const change = payMode === 'full' && tendered > total ? tendered - total : 0;
  const totalDiscount = cart.reduce((s, l) => s + Math.max((resolvedPrice(l.good, l.qty) - l.unitPrice) * l.qty, 0), 0) + orderDiscount;

  // qtyToAdd > 1 is a unit scan ("Carton" = 12) — the line still holds
  // plain base-unit pieces, same as always; the unit only decided how
  // many pieces landed in the cart in one tap.
  const addToCart = (g: FinishedGood, qtyToAdd: number = 1) => {
    if (avail(g) <= 0) { toast.error(`${g.name} is out of stock${multi ? ` at ${myBranchName}` : ''}.`); return; }
    setCart(c => {
      const ex = c.find(l => l.good.id === g.id);
      const base = ex ? ex.qty : 0;
      const nextQty = Math.min(base + qtyToAdd, avail(g));
      if (nextQty <= base) { toast.error(`Only ${avail(g)} of ${g.name} ${where}.`); return c; }
      if (ex) {
        return c.map(l => l.good.id === g.id ? { ...l, qty: nextQty, unitPrice: l.manual ? l.unitPrice : resolvedPrice(g, nextQty) } : l);
      }
      return [...c, { good: g, qty: nextQty, unitPrice: resolvedPrice(g, nextQty) }];
    });
  };

  const { data: unitsData } = useQuery<ProductUnit[]>(() => productUnits.list(), [], { cacheKey: 'pos-units' });

  const handleScan = (code: string) => {
    setShowScanner(false);
    const match = goods.find(g => g.barcode === code);
    if (match) { addToCart(match); toast.success(`${match.name} added.`); return; }

    const unit = unitsData?.find(u => u.barcode === code && u.product_kind === 'finished_good');
    const unitProduct = unit && goods.find(g => g.id === unit.product_id);
    if (unit && unitProduct) {
      addToCart(unitProduct, unit.factor);
      toast.success(`Added 1 ${unit.name} of ${unitProduct.name} (${unit.factor} ${unitProduct.unit ?? ''}).`);
      return;
    }
    toast.error(`No product matches barcode ${code}.`);
  };

  const setQty = (id: string, qty: number) => {
    setCart(c => c.flatMap(l => {
      if (l.good.id !== id) return [l];
      if (qty <= 0) return [];
      const capped = Math.min(qty, avail(l.good));
      // A quantity break can change the resolved price — unless this line
      // was hand-priced, in which case the cashier's own number sticks.
      return [{ ...l, qty: capped, unitPrice: l.manual ? l.unitPrice : resolvedPrice(l.good, capped) }];
    }));
  };

  const clearSale = () => {
    setCart([]); setCustomerId(''); setTendered(0); setPayMode('full'); setShowKeypad(false);
    setOrderDiscount(0); setShowOrderDiscount(false);
  };

  const applyLinePrice = (fgId: string, unitPrice: number, reason: string) => {
    setCart(c => c.map(l => l.good.id === fgId
      ? { ...l, unitPrice, manual: unitPrice !== resolvedPrice(l.good, l.qty), discountReason: reason || undefined }
      : l));
    setDiscountLine(null);
  };

  const buildPayload = (approval?: { userId: string; pin: string }) => ({
    customerId: customerId || null,
    date: new Date().toISOString().split('T')[0],
    paymentTypeId: payTypeId || null,
    amountPaid: paid,
    items: cart.map(l => ({
      finished_good_id: l.good.id, quantity: l.qty, unit_price: l.unitPrice,
      ...(l.manual && l.discountReason ? { discount_reason: l.discountReason } : {}),
    })),
    vatRate,
    // Pinned so a sale queued offline replays at the branch it was rung up
    // at, even if this device later signs in somewhere else.
    branchId: myBranchId,
    ...(orderDiscount > 0 ? { orderDiscount } : {}),
    ...(approval ? { approval } : {}),
  });

  const checkout = async (approval?: { userId: string; pin: string }) => {
    if (cart.length === 0) { toast.error('Cart is empty.'); return; }
    if (payMode !== 'credit' && !payTypeId) { toast.error('Select a payment method.'); return; }
    if (payMode === 'full' && tendered < total) { toast.error('Cash given is less than the total.'); return; }
    const payload = buildPayload(approval);
    setCheckingOut(true);
    if (approval) { setApproving(true); setApprovalError(null); }
    try {
      const saleId = await salesApi.create(payload);
      // The server issues the invoice number (0021); the receipt must carry
      // the same one the Sales page and the tax records show.
      const docNo = await salesApi.docNo(saleId).catch(() => null);
      setNeedsApproval(false);
      setDone({ total, paid, subtotal, vat: vatAmt, vatRate, docNo });
      goodsQ.refetch();
      levelsQ.refetch();
    } catch (e: any) {
      if (!approval && NEEDS_APPROVAL.test(e.message ?? '')) {
        setNeedsApproval(true);
        return;
      }
      if (approval) {
        setApprovalError(e.message ?? 'Could not approve that discount.');
        return;
      }
      if (looksOffline(e)) {
        // Keep selling — the sale is queued locally and replayed through the
        // real FIFO engine the moment connectivity returns (useOnlineSync).
        // Stock shown here is decremented optimistically so the same items
        // aren't oversold twice before that sync happens.
        const label = `${cart.reduce((s, l) => s + l.qty, 0)} item(s) — ${fmt(total)} — ${customerId ? customerName(customerId) : 'Walk-in'}`;
        enqueueSale(payload, label);
        levelsQ.setData(prev => prev ? decrementAt(prev, myBranchId, cart.map(l => ({ productId: l.good.id, qty: l.qty }))) : prev);
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
      if (approval) setApproving(false);
    }
  };

  const customerName = (id: string) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };
  const customerNameOrNull = (id: string | null) => id ? customerName(id) : 'Walk-in';
  const productName = (id: string) => goods.find(g => g.id === id)?.name ?? '—';
  const returnInvoiceNo = (s: SalesOrder) => s.doc_no || 'INV-' + s.id.slice(0, 8).toUpperCase();

  const findReturn = async () => {
    if (!findDocNo.trim()) return;
    setFinding(true);
    setFindError(null);
    try {
      const sale = await salesApi.findByDocNo(findDocNo);
      if (!sale) { setFindError(`No sale found for "${findDocNo.trim()}".`); return; }
      if (sale.voided) { setFindError(`${returnInvoiceNo(sale)} was voided — there's nothing left to return.`); return; }
      setShowFindReturn(false);
      setFindDocNo('');
      setReturnSale(sale);
    } catch (e: any) {
      setFindError(e.message ?? 'Could not look that up.');
    } finally {
      setFinding(false);
    }
  };

  // ---- success screen ----
  if (done) {
    const cust = custQ.data?.find(c => c.id === customerId);
    const receiptItems = cart.map(l => ({ name: l.good.name, qty: l.qty, unitPrice: l.unitPrice, amount: l.qty * l.unitPrice }));
    // Offline, the number is issued when the sale syncs.
    const invNo = done.docNo ?? (done.offline ? 'Pending sync' : 'Receipt');
    const sendWa = () => {
      const lines = [
        `Hello ${customerId ? customerName(customerId) : 'there'}! 🧾`, '',
        `*${tenant?.name ?? 'Receipt'}*${done.docNo ? ` · ${done.docNo}` : ''}`,
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
        {done.docNo && <p style={{ color: '#64748b', fontSize: '0.9rem', fontVariantNumeric: 'tabular-nums' }}>Invoice {done.docNo}</p>}
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
  if (till.blocked) return <OpenTillScreen onOpened={till.refetch} />;

  return (
    <div className="pos-page">
    {till.shift && <TillHeader shift={till.shift} onChanged={till.refetch} />}
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
          <button className="btn-secondary" onClick={() => { setFindDocNo(''); setFindError(null); setShowFindReturn(true); }} title="Return an item">
            <Undo2 size={16} /> Returns
          </button>
        </div>
        <div className="product-grid">
          {filtered.map(g => (
            <button key={g.id} className={`product-tile ${avail(g) <= 0 ? 'out' : ''}`} onClick={() => addToCart(g)} disabled={avail(g) <= 0}>
              <div className="p-name">{g.name}</div>
              <div className="p-price">{fmt(g.selling_price)}</div>
              <div className={`p-stock ${avail(g) <= 0 ? 'zero' : avail(g) <= g.min_stock_level ? 'low' : ''}`}>
                {avail(g) <= 0 ? 'Out of stock' : `${avail(g)} ${multi ? 'here' : 'in stock'}`}
              </div>
            </button>
          ))}
          {filtered.length === 0 && <p style={{ color: '#94a3b8', gridColumn: '1/-1', padding: '2rem', textAlign: 'center' }}>No products found.</p>}
        </div>
      </div>

      {/* Cart */}
      <div className="pos-cart">
        <div className="cart-head">
          <ShoppingCart size={18} /> <h2>Current Sale{multi ? ` · ${myBranchName}` : ''}</h2>
          {cart.length > 0 && <button className="clear-btn" onClick={clearSale} title="Clear"><Trash2 size={15} /></button>}
        </div>

        <div className="cart-lines">
          {cart.length === 0 ? (
            <div className="cart-empty"><ShoppingCart size={28} /><p>Tap a product to start</p></div>
          ) : cart.map(l => {
            const list = resolvedPrice(l.good, l.qty);
            const discounted = l.unitPrice < list;
            return (
              <div key={l.good.id} className="cart-line">
                <div className="cl-info">
                  <div className="cl-name">{l.good.name}</div>
                  <div className="cl-price">
                    {fmt(l.unitPrice)} each
                    {discounted && <span style={{ color: '#94a3b8', textDecoration: 'line-through', marginLeft: 5 }}>{fmt(list)}</span>}
                  </div>
                </div>
                <div className="cl-qty">
                  <button onClick={() => setQty(l.good.id, l.qty - 1)}><Minus size={13} /></button>
                  <span>{l.qty}</span>
                  <button onClick={() => setQty(l.good.id, l.qty + 1)}><Plus size={13} /></button>
                </div>
                <div className="cl-amount">{fmt(l.qty * l.unitPrice)}</div>
                {tiersEnabled && (
                  <button className="cl-remove" title="Change price" aria-label={`Change price for ${l.good.name}`}
                          onClick={() => setDiscountLine(l)}>
                    <Tag size={13} />
                  </button>
                )}
                <button className="cl-remove" onClick={() => setQty(l.good.id, 0)}><X size={13} /></button>
              </div>
            );
          })}
        </div>

        {cart.length > 0 && (
          <div className="cart-checkout">
            {tiersEnabled && (showOrderDiscount || orderDiscount > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', flexShrink: 0 }}>Order discount ₦</span>
                <NumberInput value={orderDiscount} onChange={v => setOrderDiscount(Math.max(0, Math.min(v, cartSubtotal)))} style={{ flex: 1 }} />
              </div>
            )}
            {tiersEnabled && !showOrderDiscount && orderDiscount === 0 && (
              <button type="button" className="btn-ghost btn-sm" style={{ marginBottom: 6 }} onClick={() => setShowOrderDiscount(true)}>
                <Tag size={13} /> Add order discount
              </button>
            )}
            {totalDiscount > 0 && (
              <div style={{ fontSize: '0.8rem', color: '#16a34a', marginBottom: 4 }}>You're giving {fmt(totalDiscount)} off</div>
            )}
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
              onClick={() => checkout()}
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

      {showFindReturn && (
        <Modal onClose={() => setShowFindReturn(false)} maxWidth={380}>
          <div className="modal-header">
            <h2>Find a sale to return</h2>
            <button className="close-btn" onClick={() => setShowFindReturn(false)} aria-label="Close"><X size={18} /></button>
          </div>
          <div className="modal-body">
            {findError && <ErrorState message={findError} />}
            <div className="form-group">
              <label>Invoice number</label>
              <input value={findDocNo} autoFocus placeholder="e.g. INV-000123"
                     onChange={e => setFindDocNo(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') findReturn(); }} />
              <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Printed on the receipt.</small>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={() => setShowFindReturn(false)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={finding || !findDocNo.trim()} onClick={findReturn}>
              {finding ? 'Looking…' : 'Find sale'}
            </button>
          </div>
        </Modal>
      )}

      {returnSale && (
        <ReturnModal
          sale={returnSale}
          customerName={customerNameOrNull}
          productName={productName}
          companyName={tenant?.name ?? 'My Business'}
          invoiceNo={returnInvoiceNo(returnSale)}
          payTypes={payQ.data ?? []}
          hasCustomer={!!returnSale.customer_id}
          onClose={() => setReturnSale(null)}
          onDone={() => { setReturnSale(null); goodsQ.refetch(); levelsQ.refetch(); }}
        />
      )}

      {discountLine && (
        <LinePriceModal
          productName={discountLine.good.name}
          qty={discountLine.qty}
          unit={discountLine.good.unit ?? undefined}
          currentPrice={discountLine.unitPrice}
          listPrice={resolvedPrice(discountLine.good, discountLine.qty)}
          reason={discountLine.discountReason}
          onSave={(price, reason) => applyLinePrice(discountLine.good.id, price, reason)}
          onClose={() => setDiscountLine(null)}
        />
      )}

      {needsApproval && (
        <ApprovalModal
          pending={approving}
          error={approvalError}
          onCancel={() => { setNeedsApproval(false); setApprovalError(null); }}
          onApprove={(managerId, pin) => checkout({ userId: managerId, pin })}
        />
      )}
    </div>
    </div>
  );
}

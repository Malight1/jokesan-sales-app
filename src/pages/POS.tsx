import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search, Plus, Minus, Trash2, ShoppingCart, CheckCircle2, FileText, MessageCircle, X, CloudOff, ScanLine,
  Calculator, Delete, Undo2, Tag, ChevronUp, UserRound, AlertTriangle, PauseCircle, PlayCircle,
} from 'lucide-react';
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
import { HeldSale, listHeld, holdSale, removeHeld, restoreLines, heldAgo, heldByLabel } from '../lib/heldSales';
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
const IS_CASH = /cash/i;
const IS_CREDIT = /credit/i;

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
  return half > 0 && half < total ? [half] : [];
}

// No product photos exist, so each product gets a stable coloured initials
// swatch instead: something to recognise at a glance on a busy counter
// without reading every name. Restrained palette, same colour every time.
const SWATCH_HUES = [214, 162, 26, 262, 340, 88, 190, 44];
function swatch(name: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = SWATCH_HUES[h % SWATCH_HUES.length];
  return { background: `hsl(${hue} 70% 93%)`, color: `hsl(${hue} 55% 30%)` };
}
function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(w => /^[A-Za-z]/.test(w));
  return ((words[0]?.[0] ?? name[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
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
        <button key={k} type="button" onClick={() => press(k)} aria-label={k === '⌫' ? 'Delete digit' : k}>
          {k === '⌫' ? <Delete size={18} /> : k}
        </button>
      ))}
      <button type="button" className="kp-clear" onClick={() => press('C')}>Clear</button>
    </div>
  );
}

export default function POS() {
  const toast = useToast();
  const { tenant, profile } = useAuth();
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
  const { data: unitsData } = useQuery<ProductUnit[]>(() => productUnits.list(), [], { cacheKey: 'pos-units' });
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
  const [confirmClear, setConfirmClear] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);          // the cart sheet, on phones only
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const [done, setDone] = useState<{
    total: number; paid: number; subtotal: number; vat: number; vatRate: number; change: number;
    offline?: boolean; docNo?: string | null;
  } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);

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

  // "Credit" is a way of NOT paying, so it's the credit pay mode below,
  // not a payment method beside Cash and Transfer. Offering it twice (a
  // mode AND a method) is how a cash sale gets filed as credit by mistake.
  // Cash leads: it's the default and the most common way a counter gets paid.
  const payChips = useMemo(() => (payQ.data ?? [])
    .filter(p => !IS_CREDIT.test(p.name))
    .sort((a, b) => Number(IS_CASH.test(b.name)) - Number(IS_CASH.test(a.name))), [payQ.data]);
  const creditTypeId = useMemo(() => (payQ.data ?? []).find(p => IS_CREDIT.test(p.name))?.id ?? '', [payQ.data]);
  // Most counter sales are cash, so start there instead of on a blank
  // dropdown that has to be answered before every single sale.
  const defaultPayId = useMemo(() => (payChips.find(p => IS_CASH.test(p.name)) ?? payChips[0])?.id ?? '', [payChips]);
  useEffect(() => {
    if (!payTypeId && defaultPayId && payMode !== 'credit') setPayTypeId(defaultPayId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPayId]);
  const payType = (payQ.data ?? []).find(p => p.id === payTypeId);
  const isCash = !!payType && IS_CASH.test(payType.name);

  // Returns, found by invoice number rather than a full sales list — POS
  // never loads one. Needs a connection: unlike a sale, a return checks
  // FIFO batches and balances live, so it can't be queued offline.
  const [showFindReturn, setShowFindReturn] = useState(false);
  const [findDocNo, setFindDocNo] = useState('');
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [returnSale, setReturnSale] = useState<SalesOrder | null>(null);

  // Held sales: a customer steps away to fetch money, the cashier parks
  // their basket and serves the next person. Kept on this device, per
  // business and branch (see lib/heldSales).
  const [held, setHeld] = useState<HeldSale[]>(() => listHeld(tenant?.id, myBranchId));
  const [showHeld, setShowHeld] = useState(false);
  const [armDiscard, setArmDiscard] = useState<string | null>(null);
  useEffect(() => { setHeld(listHeld(tenant?.id, myBranchId)); }, [tenant?.id, myBranchId]);
  useEffect(() => {
    if (!armDiscard) return;
    const t = setTimeout(() => setArmDiscard(null), 3000);
    return () => clearTimeout(t);
  }, [armDiscard]);

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
  const q = search.trim().toLowerCase();
  // Sellable first: an out-of-stock tile at the top of the grid is a tile
  // nobody can tap. Matches the barcode too, so a typed code finds it.
  const filtered = useMemo(() => {
    const hits = goods.filter(g => !q || g.name.toLowerCase().includes(q) || (g.barcode ?? '') === search.trim());
    return [...hits.filter(g => avail(g) > 0), ...hits.filter(g => avail(g) <= 0)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goods, q, here, levelsQ.data]);
  const firstSellable = filtered.find(g => avail(g) > 0);
  const inCart = useMemo(() => new Map(cart.map(l => [l.good.id, l.qty])), [cart]);

  const itemCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartSubtotal = cart.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const subtotal = Math.max(cartSubtotal - orderDiscount, 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = subtotal * vatRate / 100;
  const total = subtotal + vatAmt;
  const paid = payMode === 'full' ? total : payMode === 'credit' ? 0 : Math.min(tendered, total);
  // Cash given is optional: left blank it means exact money. Change only
  // exists for cash; a transfer is for the amount, full stop.
  const change = payMode === 'full' && isCash && tendered > total ? tendered - total : 0;
  const totalDiscount = cart.reduce((s, l) => s + Math.max((resolvedPrice(l.good, l.qty) - l.unitPrice) * l.qty, 0), 0) + orderDiscount;

  // The one reason the sale can't go through yet, if there is one — shown
  // on the charge button itself so the cashier never has to guess.
  const blocker: string | null =
    cart.length === 0 ? 'Add items to start a sale'
    : payMode !== 'credit' && !payTypeId ? 'Choose how they are paying'
    : payMode !== 'full' && !customerId ? 'Pick the customer who owes'
    : payMode === 'part' && tendered <= 0 ? 'Enter the amount paid now'
    : payMode === 'full' && isCash && tendered > 0 && tendered < total ? `Short by ${fmt(total - tendered)}`
    : null;

  // Flash + scroll to the line that just changed, so a tap on a tile has a
  // visible answer in the cart even when the cart is long.
  const bump = (id: string) => setFlash(f => ({ id, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!flash) return;
    linesRef.current?.querySelector<HTMLElement>(`[data-line="${flash.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [flash]);

  // qtyToAdd > 1 is a unit scan ("Carton" = 12) — the line still holds
  // plain base-unit pieces, same as always; the unit only decided how
  // many pieces landed in the cart in one tap.
  // The current quantity is read inside the updater, from the latest cart,
  // not from this render: two quick taps on the same tile must add two.
  const addToCart = (g: FinishedGood, qtyToAdd: number = 1) => {
    const max = avail(g);
    if (max <= 0) { toast.error(`${g.name} is out of stock${multi ? ` at ${myBranchName}` : ''}.`); return; }
    setCart(c => {
      const ex = c.find(l => l.good.id === g.id);
      const base = ex ? ex.qty : 0;
      const nextQty = Math.min(base + qtyToAdd, max);
      if (nextQty <= base) { toast.error(`Only ${max} of ${g.name} ${where}.`); return c; }
      return ex
        ? c.map(l => l.good.id === g.id ? { ...l, qty: nextQty, unitPrice: l.manual ? l.unitPrice : resolvedPrice(g, nextQty) } : l)
        : [...c, { good: g, qty: nextQty, unitPrice: resolvedPrice(g, nextQty) }];
    });
    bump(g.id);
  };

  // A barcode, from the camera or from a USB scanner typing into search.
  // Returns false when nothing matches, so the caller can decide what to say.
  const addByCode = (code: string): boolean => {
    const match = goods.find(g => g.barcode && g.barcode === code);
    if (match) { addToCart(match); return true; }
    const unit = unitsData?.find(u => u.barcode === code && u.product_kind === 'finished_good');
    const unitProduct = unit && goods.find(g => g.id === unit.product_id);
    if (unit && unitProduct) {
      addToCart(unitProduct, unit.factor);
      toast.success(`Added 1 ${unit.name} of ${unitProduct.name} (${unit.factor} ${unitProduct.unit ?? ''}).`);
      return true;
    }
    return false;
  };

  const handleScan = (code: string) => {
    setShowScanner(false);
    if (!addByCode(code)) toast.error(`No product matches barcode ${code}.`);
  };

  // Enter in search: an exact barcode first (a USB scanner is just a
  // keyboard that types the code and presses Enter), otherwise the first
  // sellable match, which the hint under the field names beforehand.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setSearch(''); return; }
    if (e.key !== 'Enter') return;
    const code = search.trim();
    if (!code) return;
    e.preventDefault();
    if (addByCode(code)) { setSearch(''); return; }
    if (firstSellable) { addToCart(firstSellable); setSearch(''); return; }
    toast.error(`Nothing in stock matches "${code}".`);
  };

  // +1 / -1 from the LATEST quantity, so rapid taps on the stepper count.
  const stepQty = (id: string, delta: number) => {
    setCart(c => c.flatMap(l => {
      if (l.good.id !== id) return [l];
      const qty = l.qty + delta;
      if (qty <= 0) return [];
      const capped = Math.min(qty, avail(l.good));
      if (qty > capped) { toast.error(`Only ${avail(l.good)} of ${l.good.name} ${where}.`); return [l]; }
      // A quantity break can change the resolved price — unless this line
      // was hand-priced, in which case the cashier's own number sticks.
      return [{ ...l, qty: capped, unitPrice: l.manual ? l.unitPrice : resolvedPrice(l.good, capped) }];
    }));
  };

  const clearSale = () => {
    setCart([]); setCustomerId(''); setTendered(0); setPayMode('full'); setPayTypeId(defaultPayId);
    setShowKeypad(false); setOrderDiscount(0); setShowOrderDiscount(false); setConfirmClear(false); setCartOpen(false);
  };

  // Emptying a full cart is one stray tap otherwise: the first tap arms,
  // the second clears, and it disarms itself if nobody follows through.
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const pickMethod = (id: string) => {
    setPayTypeId(id);
    if (payMode === 'credit') setPayMode('full');
  };
  const pickCredit = () => { setPayMode('credit'); setPayTypeId(creditTypeId); setTendered(0); setShowKeypad(false); };

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

  const customerName = (id: string) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };
  const customerLabel = (c: Customer) => {
    const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
    return n && c.company_store ? `${n} (${c.company_store})` : n || c.company_store || 'Customer';
  };
  const customerNameOrNull = (id: string | null) => id ? customerName(id) : 'Walk-in';

  const snapshotCurrent = () => ({
    customerId,
    label: customerId ? customerName(customerId) : 'Walk-in',
    orderDiscount,
    total,
    ...(profile?.id ? { heldBy: { id: profile.id, name: profile.full_name?.trim() || profile.email || 'A colleague' } } : {}),
    lines: cart.map(l => ({
      goodId: l.good.id, name: l.good.name, qty: l.qty, unitPrice: l.unitPrice,
      manual: l.manual, discountReason: l.discountReason,
    })),
  });

  const holdCurrent = () => {
    if (!tenant?.id || cart.length === 0) return;
    setHeld(holdSale(tenant.id, myBranchId, snapshotCurrent()));
    clearSale();
    toast.success('Sale held. Serve the next customer, then tap Held to pick it up again.');
    searchRef.current?.focus();
  };

  // Resuming while another sale is on the till holds that one first, so
  // nothing is ever lost by switching between customers.
  const resumeHeld = (h: HeldSale) => {
    if (!tenant?.id) return;
    let list = removeHeld(tenant.id, myBranchId, h.id);
    const swapped = cart.length > 0;
    if (swapped) list = holdSale(tenant.id, myBranchId, snapshotCurrent());
    setHeld(list);

    const restored = restoreLines(h.lines, goods, avail);
    const custId = h.customerId && custQ.data && !custQ.data.some(c => c.id === h.customerId) ? '' : h.customerId;
    const lines = restored.lines.map(l => ({
      ...l,
      unitPrice: l.manual ? l.unitPrice : resolvePriceLocal(l.good.id, l.qty, custId || null, priceCtx, l.good.selling_price),
    }));
    const restoredSubtotal = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
    setCart(lines);
    setCustomerId(custId);
    setOrderDiscount(Math.min(h.orderDiscount, restoredSubtotal));
    setShowOrderDiscount(h.orderDiscount > 0);
    setTendered(0); setPayMode('full'); setPayTypeId(defaultPayId);
    setShowKeypad(false); setConfirmClear(false); setShowHeld(false);

    const changes = [
      restored.dropped.length ? `No longer in stock: ${restored.dropped.join(', ')}.` : '',
      restored.reduced.length ? `Cut to what's left: ${restored.reduced.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    if (lines.length === 0) toast.error(`Nothing from ${h.label}'s sale is in stock any more.`);
    else if (changes) toast.error(`Resumed ${h.label}'s sale. ${changes}`);
    else {
      const by = heldByLabel(h, profile?.id);
      toast.success(`Resumed ${h.label}'s sale${by && by !== 'you' ? `, held by ${by}` : ''}.${swapped ? ' The one you were on is now held.' : ''}`);
    }
  };

  const discardHeld = (id: string) => {
    if (!tenant?.id) return;
    if (armDiscard !== id) { setArmDiscard(id); return; }
    setHeld(removeHeld(tenant.id, myBranchId, id));
    setArmDiscard(null);
  };
  const productName = (id: string) => goods.find(g => g.id === id)?.name ?? 'Unknown product';
  const returnInvoiceNo = (s: SalesOrder) => s.doc_no || 'INV-' + s.id.slice(0, 8).toUpperCase();

  const checkout = async (approval?: { userId: string; pin: string }) => {
    if (blocker) { toast.error(blocker); return; }
    const payload = buildPayload(approval);
    const receipt = { total, paid, subtotal, vat: vatAmt, vatRate, change };
    setCheckingOut(true);
    if (approval) { setApproving(true); setApprovalError(null); }
    try {
      const saleId = await salesApi.create(payload);
      // The server issues the invoice number (0021); the receipt must carry
      // the same one the Sales page and the tax records show.
      const docNo = await salesApi.docNo(saleId).catch(() => null);
      setNeedsApproval(false);
      setDone({ ...receipt, docNo });
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
        const label = `${itemCount} item(s) · ${fmt(total)} · ${customerId ? customerName(customerId) : 'Walk-in'}`;
        enqueueSale(payload, label);
        levelsQ.setData(prev => prev ? decrementAt(prev, myBranchId, cart.map(l => ({ productId: l.good.id, qty: l.qty }))) : prev);
        goodsQ.setData(prev => prev ? prev.map(g => {
          const line = cart.find(l => l.good.id === g.id);
          return line ? { ...g, qty_balance: g.qty_balance - line.qty } : g;
        }) : prev);
        toast.info('Offline. Sale saved on this device and will sync automatically.');
        setDone({ ...receipt, offline: true });
      } else {
        toast.error(e.message ?? 'Sale failed.');
      }
    } finally {
      setCheckingOut(false);
      if (approval) setApproving(false);
    }
  };

  // Keyboard: "/" jumps to search from anywhere on the till, Ctrl/Cmd+Enter
  // charges. Read through a ref so the listener always sees this render's
  // cart and totals, not the ones from when it was attached.
  const keysRef = useRef({ charge: () => {}, canCharge: false, busy: false });
  keysRef.current = {
    charge: () => checkout(),
    canCharge: !blocker && !checkingOut,
    busy: !!(done || showScanner || showFindReturn || returnSale || discountLine || needsApproval || showHeld),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keysRef.current;
      if (k.busy) return;
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && k.canCharge) { e.preventDefault(); k.charge(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const findReturn = async () => {
    if (!findDocNo.trim()) return;
    setFinding(true);
    setFindError(null);
    try {
      const sale = await salesApi.findByDocNo(findDocNo);
      if (!sale) { setFindError(`No sale found for "${findDocNo.trim()}".`); return; }
      if (sale.voided) { setFindError(`${returnInvoiceNo(sale)} was voided, so there's nothing left to return.`); return; }
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
    const balance = done.total - done.paid;
    // Offline, the number is issued when the sale syncs.
    const invNo = done.docNo ?? (done.offline ? 'Pending sync' : 'Receipt');
    const sendWa = () => {
      const lines = [
        `Hello ${customerId ? customerName(customerId) : 'there'}! 🧾`, '',
        `*${tenant?.name ?? 'Receipt'}*${done.docNo ? ` · ${done.docNo}` : ''}`,
        `Total: ₦${done.total.toLocaleString()}`,
        `Paid: ₦${done.paid.toLocaleString()}`,
        balance > 0 ? `Balance: ₦${balance.toLocaleString()}` : `Status: PAID ✅`,
        '', 'Thank you!',
      ];
      window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
    };
    const dl = async () => {
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      await generateInvoicePdf({
        companyName: tenant?.name ?? 'My Business', invoiceNo: invNo,
        companyAddress: tenant?.address,
        date: new Date().toISOString().split('T')[0],
        customerName: customerId ? customerName(customerId) : 'Walk-in Customer',
        customerPhone: cust?.phone, customerAddress: cust?.address,
        items: receiptItems, total: done.total, paid: done.paid, balance,
        subtotal: done.subtotal, vatAmount: done.vat, vatRate: done.vatRate,
        tin: tenant?.tin, logoDataUrl: logo,
        bankDetails: balance > 0 ? tenant?.bank_details : null,
      });
    };
    return (
      <div className="pos-success">
        <div className={`ps-card${done.offline ? ' is-offline' : ''}`}>
          <div className="ps-icon" aria-hidden="true">{done.offline ? <CloudOff size={30} /> : <CheckCircle2 size={30} />}</div>
          <h1>{done.offline ? 'Saved offline' : 'Sale complete'}</h1>
          {done.docNo && <p className="ps-sub">Invoice {done.docNo}</p>}
          {done.offline && <p className="ps-note">No network right now. This sale is queued on this device and syncs by itself the moment you're back online.</p>}

          {/* The one number the cashier acts on next, so it's the biggest. */}
          {done.change > 0 && (
            <div className="ps-change" role="status">
              <span>Give change</span>
              <strong>{fmt(done.change)}</strong>
            </div>
          )}

          <dl className="ps-figures">
            <div><dt>Total</dt><dd>{fmt(done.total)}</dd></div>
            <div><dt>Paid</dt><dd>{fmt(done.paid)}</dd></div>
            {balance > 0 && <div className="is-owed"><dt>Owed by {customerName(customerId)}</dt><dd>{fmt(balance)}</dd></div>}
          </dl>

          <div className="ps-actions">
            <button className="btn-secondary" onClick={dl}><FileText size={16} /> Invoice PDF</button>
            <button className="btn-secondary" onClick={sendWa}><MessageCircle size={16} /> WhatsApp receipt</button>
          </div>
          <button className="btn-primary ps-next" autoFocus onClick={() => { setDone(null); clearSale(); }}>
            New sale <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    );
  }

  if (goodsQ.loading) return <Loading label="Loading products…" />;
  if (goodsQ.error) return <ErrorState message={goodsQ.error} onRetry={goodsQ.refetch} />;
  if (till.blocked) return <OpenTillScreen onOpened={till.refetch} />;

  const needsCustomer = payMode !== 'full' && !customerId;
  const chargeLabel = checkingOut ? 'Processing…'
    : blocker ?? (payMode === 'credit' ? 'Sell on credit'
      : payMode === 'part' ? `Take ${fmt(paid)} now` : 'Charge');

  return (
    <div className="pos-page">
      {till.shift && <TillHeader shift={till.shift} onChanged={till.refetch} />}
      <div className="pos">
        {/* ---------------- products ---------------- */}
        <section className="pos-products" aria-label="Products">
          {goodsQ.isOffline && <OfflineBanner label="product list" />}
          <div className="pos-toolbar">
            <label className="pos-search">
              <Search size={18} aria-hidden="true" />
              <span className="sr-only">Search products or scan a barcode</span>
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="Search or scan a barcode"
                autoFocus
                autoComplete="off"
              />
              {search
                ? <button type="button" className="pos-search__clear" onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label="Clear search"><X size={16} /></button>
                : <kbd className="pos-search__kbd" aria-hidden="true">/</kbd>}
            </label>
            <button className="pos-tool" onClick={() => setShowScanner(true)} title="Scan with the camera" aria-label="Scan with the camera">
              <ScanLine size={18} aria-hidden="true" /> <span>Scan</span>
            </button>
            <button className="pos-tool" onClick={() => { setFindDocNo(''); setFindError(null); setShowFindReturn(true); }} title="Return an item" aria-label="Return an item">
              <Undo2 size={18} aria-hidden="true" /> <span>Returns</span>
            </button>
            {held.length > 0 && (
              <button className="pos-tool pos-tool--held" onClick={() => setShowHeld(true)}
                      title="Sales on hold" aria-label={`Held sales, ${held.length}`}>
                <PauseCircle size={18} aria-hidden="true" /> <span>Held</span>
                <b className="pos-tool__count" aria-hidden="true">{held.length}</b>
              </button>
            )}
          </div>

          <p className="pos-hint" aria-live="polite">
            {q
              ? firstSellable
                ? <>Press <kbd>Enter</kbd> to add <strong>{firstSellable.name}</strong></>
                : filtered.length ? 'Everything that matches is out of stock.' : ' '
              : `${goods.length} product${goods.length === 1 ? '' : 's'}${multi ? ` · stock shown for ${myBranchName}` : ''}`}
          </p>

          <div className="product-grid">
            {filtered.map(g => {
              const n = avail(g);
              const out = n <= 0;
              const low = !out && n <= g.min_stock_level;
              const count = inCart.get(g.id) ?? 0;
              const stockText = out ? 'Out of stock' : low ? `Only ${n} left` : `${n} ${multi ? 'here' : 'in stock'}`;
              return (
                <button
                  key={g.id}
                  className={`ptile${out ? ' is-out' : ''}${count ? ' in-cart' : ''}`}
                  onClick={() => addToCart(g)}
                  disabled={out}
                  aria-label={`${g.name}, ${fmt(resolvedPrice(g, 1))}, ${stockText}${count ? `, ${count} in sale` : ''}`}
                >
                  <span className="ptile-top">
                    <span className="ptile-swatch" style={swatch(g.name)} aria-hidden="true">{initials(g.name)}</span>
                    {count > 0 && <span className="ptile-count" aria-hidden="true">{count}</span>}
                  </span>
                  <span className="ptile-name">{g.name}</span>
                  <span className="ptile-price">{fmt(resolvedPrice(g, 1))}</span>
                  <span className={`ptile-stock${out ? ' is-zero' : low ? ' is-low' : ''}`}>
                    {(out || low) && <AlertTriangle size={11} aria-hidden="true" />}{stockText}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="pos-noresults">
                {goods.length === 0
                  ? <p>No products yet. Add some under Products, then they appear here.</p>
                  : <>
                      <p>Nothing matches "{search.trim()}".</p>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => { setSearch(''); searchRef.current?.focus(); }}>Clear search</button>
                    </>}
              </div>
            )}
          </div>
        </section>

        {/* ---------------- current sale ---------------- */}
        <section className={`pos-cart${cartOpen ? ' is-open' : ''}${cart.length ? ' has-items' : ''}`} aria-label="Current sale">
          <header className="cart-head">
            <button type="button" className="cart-close" onClick={() => setCartOpen(false)} aria-label="Back to products"><X size={20} /></button>
            <h2>Current sale{multi ? <small> · {myBranchName}</small> : null}</h2>
            {itemCount > 0 && <span className="cart-count">{itemCount} item{itemCount === 1 ? '' : 's'}</span>}
            {cart.length > 0 && (
              <button type="button" className="cart-hold" onClick={holdCurrent}
                      title="Hold this sale and serve the next customer" aria-label="Hold this sale">
                <PauseCircle size={15} aria-hidden="true" /><span>Hold</span>
              </button>
            )}
            {cart.length > 0 && (
              <button
                type="button"
                className={`cart-clear${confirmClear ? ' is-armed' : ''}`}
                onClick={() => (confirmClear ? clearSale() : setConfirmClear(true))}
                aria-label={confirmClear ? 'Tap again to clear the sale' : 'Clear sale'}
              >
                <Trash2 size={15} />{confirmClear && <span>Clear all?</span>}
              </button>
            )}
          </header>

          <div className="cart-lines" ref={linesRef}>
            {cart.length === 0 ? (
              <div className="cart-empty">
                <ShoppingCart size={30} aria-hidden="true" />
                <p>Tap a product, or scan a barcode, to start a sale.</p>
                {held.length > 0 && (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setShowHeld(true)}>
                    <PauseCircle size={14} aria-hidden="true" /> {held.length} sale{held.length === 1 ? '' : 's'} on hold
                  </button>
                )}
              </div>
            ) : cart.map(l => {
              const list = resolvedPrice(l.good, l.qty);
              const discounted = l.unitPrice < list;
              const atMax = l.qty >= avail(l.good);
              return (
                <div
                  key={l.good.id + (flash?.id === l.good.id ? `-${flash.n}` : '')}
                  data-line={l.good.id}
                  className={`cart-line${flash?.id === l.good.id ? ' is-flash' : ''}`}
                >
                  <div className="cl-info">
                    <div className="cl-name" title={l.good.name}>{l.good.name}</div>
                    <div className="cl-price">
                      <span>{fmt(l.unitPrice)} each</span>
                      {discounted && <s>{fmt(list)}</s>}
                      {tiersEnabled && (
                        <button type="button" className="cl-edit" onClick={() => setDiscountLine(l)}
                                aria-label={`Change price for ${l.good.name}`}>
                          <Tag size={11} aria-hidden="true" />{l.manual ? 'Edit' : 'Price'}
                        </button>
                      )}
                    </div>
                    {l.manual && l.discountReason && <div className="cl-reason">{l.discountReason}</div>}
                  </div>
                  <div className="cl-qty" role="group" aria-label={`Quantity of ${l.good.name}`}>
                    <button type="button" onClick={() => stepQty(l.good.id, -1)}
                            aria-label={l.qty === 1 ? `Remove ${l.good.name}` : `One less ${l.good.name}`}>
                      {l.qty === 1 ? <Trash2 size={13} /> : <Minus size={14} />}
                    </button>
                    <span aria-live="polite">{l.qty}</span>
                    <button type="button" onClick={() => stepQty(l.good.id, 1)} disabled={atMax}
                            aria-label={`One more ${l.good.name}`} title={atMax ? `That's all ${where}` : undefined}>
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="cl-amount">{fmt(l.qty * l.unitPrice)}</div>
                </div>
              );
            })}
          </div>

          {cart.length > 0 && (
            <>
              <div className="cart-checkout">
                {/* The total itself lives in the pinned footer; this is only
                    the breakdown behind it, when there is one. */}
                {(totalDiscount > 0 || vatRate > 0 || tiersEnabled) && <div className="co-totals">
                  {(totalDiscount > 0 || vatRate > 0) && (
                    <div className="co-row"><span>Subtotal</span><span>{fmt(cartSubtotal)}</span></div>
                  )}
                  {totalDiscount > 0 && (
                    <div className="co-row is-saving"><span>Discount</span><span>−{fmt(totalDiscount)}</span></div>
                  )}
                  {vatRate > 0 && (
                    <div className="co-row"><span>VAT {vatRate}%</span><span>{fmt(vatAmt)}</span></div>
                  )}
                  {tiersEnabled && (showOrderDiscount || orderDiscount > 0 ? (
                    <div className="co-discount">
                      <label htmlFor="pos-order-discount">Order discount</label>
                      <div className="co-money">
                        <span aria-hidden="true">₦</span>
                        <NumberInput id="pos-order-discount" value={orderDiscount}
                                     onChange={v => setOrderDiscount(Math.max(0, Math.min(v, cartSubtotal)))} placeholder="0" />
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="co-link" onClick={() => setShowOrderDiscount(true)}>
                      <Tag size={13} /> Add order discount
                    </button>
                  ))}
                </div>}

                <div className="co-field">
                  <label htmlFor="pos-customer"><UserRound size={13} aria-hidden="true" /> Customer</label>
                  <select id="pos-customer" className={`co-select${needsCustomer ? ' is-needed' : ''}`}
                          value={customerId} onChange={e => setCustomerId(e.target.value)}
                          aria-describedby={needsCustomer ? 'pos-customer-help' : undefined}>
                    <option value="">Walk-in customer</option>
                    {custQ.data?.map(c => <option key={c.id} value={c.id}>{customerLabel(c)}</option>)}
                  </select>
                  {needsCustomer && (
                    <p id="pos-customer-help" className="co-help is-warn">
                      Pick who is buying. An unpaid balance needs a name, or it never shows up under who owes you.
                    </p>
                  )}
                </div>

                <div className="co-field">
                  <span className="co-label" id="pos-pay-label">Payment</span>
                  <div className="pay-chips" role="radiogroup" aria-labelledby="pos-pay-label">
                    {payChips.map(p => (
                      <button key={p.id} type="button" role="radio"
                              aria-checked={payMode !== 'credit' && payTypeId === p.id}
                              className={payMode !== 'credit' && payTypeId === p.id ? 'is-on' : ''}
                              onClick={() => pickMethod(p.id)}>
                        {p.name}
                      </button>
                    ))}
                    <button type="button" role="radio" aria-checked={payMode === 'credit'}
                            className={`is-credit${payMode === 'credit' ? ' is-on' : ''}`} onClick={pickCredit}>
                      Credit
                    </button>
                  </div>
                  {payMode !== 'credit' && (
                    <label className="co-switch">
                      <input type="checkbox" checked={payMode === 'part'}
                             onChange={e => { setPayMode(e.target.checked ? 'part' : 'full'); setTendered(0); }} />
                      <span>Paying part now, rest later</span>
                    </label>
                  )}
                </div>

                {payMode === 'full' && isCash && (
                  <div className="tender-panel">
                    <div className="tp-head">
                      <label htmlFor="pos-tendered">Cash given <em>optional</em></label>
                      <button type="button" className={`kp-toggle${showKeypad ? ' is-on' : ''}`}
                              onClick={() => setShowKeypad(k => !k)} aria-pressed={showKeypad}>
                        <Calculator size={14} /> Keypad
                      </button>
                    </div>
                    <div className="amount-field">
                      <span className="affix" aria-hidden="true">₦</span>
                      <NumberInput id="pos-tendered" className="tender-input" value={tendered} onChange={setTendered}
                                   placeholder={total.toLocaleString()}
                                   onKeyDown={e => { if (e.key === 'Enter' && !blocker) checkout(); }} />
                    </div>
                    <div className="quick-amounts">
                      {quickCashOptions(total).map((v, i) => (
                        <button key={v} type="button" className={tendered === v ? 'is-on' : ''} onClick={() => setTendered(v)}>
                          {i === 0 ? 'Exact' : fmt(v)}
                        </button>
                      ))}
                    </div>
                    {showKeypad && <NumericKeypad value={tendered} onChange={setTendered} />}
                    {tendered > 0 && tendered < total && (
                      <div className="tender-feedback is-short">Short by <strong>{fmt(total - tendered)}</strong></div>
                    )}
                    {change > 0 && <div className="tender-feedback is-change">Give change <strong>{fmt(change)}</strong></div>}
                  </div>
                )}

                {payMode === 'part' && (
                  <div className="tender-panel">
                    <div className="tp-head">
                      <label htmlFor="pos-part">Amount paid now</label>
                      <button type="button" className={`kp-toggle${showKeypad ? ' is-on' : ''}`}
                              onClick={() => setShowKeypad(k => !k)} aria-pressed={showKeypad}>
                        <Calculator size={14} /> Keypad
                      </button>
                    </div>
                    <div className="amount-field">
                      <span className="affix" aria-hidden="true">₦</span>
                      <NumberInput id="pos-part" className="tender-input" value={tendered}
                                   onChange={v => setTendered(Math.min(v, total))} placeholder="0" />
                    </div>
                    {quickPartOptions(total).length > 0 && (
                      <div className="quick-amounts">
                        {quickPartOptions(total).map(v => (
                          <button key={v} type="button" className={tendered === v ? 'is-on' : ''} onClick={() => setTendered(v)}>
                            Half · {fmt(v)}
                          </button>
                        ))}
                      </div>
                    )}
                    {showKeypad && <NumericKeypad value={tendered} onChange={v => setTendered(Math.min(v, total))} />}
                    <div className="tender-feedback is-balance">
                      Left owing <strong>{fmt(total - Math.min(tendered, total))}</strong>
                    </div>
                  </div>
                )}

                {payMode === 'credit' && (
                  <div className="tender-feedback is-balance">
                    Nothing paid today. <strong>{fmt(total)}</strong> goes on {customerId ? customerName(customerId) : 'the customer'}'s account.
                  </div>
                )}
              </div>

              <div className="co-foot">
                <div className="co-sum">
                  <span>Total</span>
                  <strong>{fmt(total)}</strong>
                </div>
                <button className={`checkout-btn${blocker ? ' is-blocked' : ''}`}
                        onClick={() => checkout()} disabled={checkingOut || !!blocker}>
                  <span>{chargeLabel}</span>
                  {!blocker && !checkingOut && <kbd>Ctrl ↵</kbd>}
                </button>
              </div>
            </>
          )}
        </section>

        {/* Phones: the sale lives in a sheet, and this bar is how you get there. */}
        {cart.length > 0 && !cartOpen && (
          <button type="button" className="pos-mobilebar" onClick={() => setCartOpen(true)}>
            <span className="mb-count">{itemCount}</span>
            <span className="mb-label">View sale</span>
            <strong>{fmt(total)}</strong>
            <ChevronUp size={18} aria-hidden="true" />
          </button>
        )}

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
                <label htmlFor="pos-find-doc">Invoice number</label>
                <input id="pos-find-doc" value={findDocNo} autoFocus placeholder="e.g. INV-000123"
                       onChange={e => setFindDocNo(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') findReturn(); }} />
                <small style={{ color: '#64748b', fontSize: '0.75rem' }}>Printed on the receipt.</small>
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

        {showHeld && (
          <Modal onClose={() => setShowHeld(false)} maxWidth={560}>
            <div className="modal-header">
              <h2>Held sales</h2>
              <button className="close-btn" onClick={() => setShowHeld(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="modal-body">
              {held.length === 0 ? (
                <p className="held-empty">Nothing on hold. Tap Hold on a sale to park it while you serve someone else.</p>
              ) : (
                <ul className="held-list">
                  {held.map(h => {
                    const items = h.lines.reduce((sum, l) => sum + l.qty, 0);
                    const preview = h.lines.slice(0, 2).map(l => `${l.qty} × ${l.name}`).join(', ')
                      + (h.lines.length > 2 ? `, +${h.lines.length - 2} more` : '');
                    const armed = armDiscard === h.id;
                    return (
                      <li key={h.id} className="held-row">
                        <div className="held-info">
                          <div className="held-top">
                            <strong>{h.label}</strong>
                            <span>{heldAgo(h.heldAt)}{heldByLabel(h, profile?.id) ? ` · held by ${heldByLabel(h, profile?.id)}` : ''}</span>
                          </div>
                          <div className="held-items" title={preview}>{preview}</div>
                        </div>
                        <div className="held-total">
                          {fmt(h.total)}
                          <small>{items} item{items === 1 ? '' : 's'}</small>
                        </div>
                        <div className="held-actions">
                          <button type="button" className="btn-primary btn-sm" onClick={() => resumeHeld(h)}>
                            <PlayCircle size={15} aria-hidden="true" /> Resume
                          </button>
                          <button type="button" className={`held-discard${armed ? ' is-armed' : ''}`} onClick={() => discardHeld(h.id)}
                                  aria-label={armed ? `Tap again to discard ${h.label}'s sale` : `Discard ${h.label}'s sale`}>
                            <Trash2 size={14} aria-hidden="true" />{armed && <span>Discard?</span>}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="held-note">
                Held sales are saved on this device, shared by everyone who signs in on it. They don’t reserve stock, so an item
                can sell out before you resume. A resumed sale counts in the shift of whoever charges it.
                {cart.length > 0 && ' Resuming one holds the sale you’re on now.'}
              </p>
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

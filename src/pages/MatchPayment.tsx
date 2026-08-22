import React, { useRef, useState } from 'react';
import { Landmark, Wand2, CheckCircle2, ArrowRight, RefreshCcw, ImagePlus, Loader2, X } from 'lucide-react';
import { sales as salesApi, customers as customersApi, lookups, SalesOrder, Customer, Lookup } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import NumberInput from '../components/NumberInput';
import { parseBankAlert, rankMatches, ParsedAlert, MatchCandidate } from '../lib/bankAlert';
import { extractTextFromImage } from '../lib/ocr';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function MatchPayment() {
  const toast = useToast();
  const salesQ = useQuery<SalesOrder[]>(() => salesApi.list(), []);
  const custQ = useQuery<Customer[]>(() => customersApi.list(), []);
  const payTypesQ = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const payMut = useMutation(salesApi.addPayment);

  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedAlert | null>(null);
  const [matches, setMatches] = useState<MatchCandidate[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAmount, setConfirmAmount] = useState(0);
  const [payTypeId, setPayTypeId] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const custName = (id: string | null) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };

  const runMatch = (overrideText?: string) => {
    const source = overrideText ?? text;
    if (!source.trim()) { toast.error('Paste the bank alert text, or drop a screenshot, first.'); return; }
    const p = parseBankAlert(source);
    setParsed(p);
    if (p.amount == null) { toast.error("Couldn't find an amount in that text — try a clearer screenshot or pasting the full alert."); setMatches([]); return; }

    const unpaid = (salesQ.data ?? []).filter(s => !s.voided && s.balance > 0);
    const pool = unpaid.map(s => ({
      id: s.id, customerName: custName(s.customer_id), balance: s.balance, totalAmount: s.total_amount, date: s.transaction_date,
    }));
    const ranked = rankMatches(p, pool);
    setMatches(ranked);
    if (ranked.length === 0) toast.info('No matching unpaid invoices found — you can still record it manually from Sales.');
  };

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error('That file is not an image.'); return; }
    setImagePreview(URL.createObjectURL(file));
    setParsed(null);
    setMatches([]);
    setOcrRunning(true);
    try {
      const extracted = await extractTextFromImage(file);
      if (!extracted.trim()) {
        toast.error("Couldn't read any text from that screenshot — try a clearer crop, or paste the alert text instead.");
        return;
      }
      setText(extracted);
      runMatch(extracted);
    } catch {
      toast.error('Failed to read the screenshot. Try a clearer image or paste the text instead.');
    } finally {
      setOcrRunning(false);
    }
  };

  const clearAll = () => {
    setText(''); setParsed(null); setMatches([]); setImagePreview(null);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    handleImageFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleImageFile(file);
  };

  const openConfirm = (m: MatchCandidate) => {
    setConfirmId(m.saleId);
    setConfirmAmount(Math.min(parsed?.amount ?? m.balance, m.balance));
    setPayTypeId(payTypesQ.data?.find(p => /bank|transfer/i.test(p.name))?.id ?? payTypesQ.data?.[0]?.id ?? '');
  };

  const confirmPayment = async () => {
    if (!confirmId) return;
    const res = await payMut.mutate(confirmId, confirmAmount, payTypeId || null, 'Matched from bank alert');
    if (res !== null) {
      toast.success('Payment recorded.');
      setConfirmId(null);
      clearAll();
      salesQ.refetch();
    } else {
      toast.error(payMut.error ?? 'Failed to record payment.');
    }
  };

  if (salesQ.loading) return <Loading label="Loading sales…" />;
  if (salesQ.error) return <ErrorState message={salesQ.error} onRetry={salesQ.refetch} />;

  const confirmSale = matches.find(m => m.saleId === confirmId);

  return (
    <div className="match-payment-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Match Bank Payment</h1>
          <p>Drop a screenshot, or paste a bank alert — we'll find which invoice it pays</p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: '0.75rem' }}>
          <Landmark size={18} color="#2563eb" style={{ marginTop: 2, flexShrink: 0 }} />
          <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>
            No bank connection needed. Drop in the payment screenshot your customer sent (WhatsApp or bank app) — we read it automatically. Or paste/type the alert text below if you'd rather.
          </p>
        </div>

        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !ocrRunning && fileInputRef.current?.click()}
          style={{
            border: `1.5px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
            borderRadius: 10,
            padding: imagePreview ? '0.6rem' : '1.25rem 0.75rem',
            marginBottom: '0.75rem',
            textAlign: 'center',
            cursor: ocrRunning ? 'default' : 'pointer',
            background: dragOver ? '#eff6ff' : '#f8fafc',
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ''; }}
          />
          {ocrRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#2563eb', fontSize: '0.85rem', fontWeight: 600 }}>
              <Loader2 size={16} className="spin" /> Reading screenshot…
            </div>
          ) : imagePreview ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src={imagePreview} alt="Payment screenshot" style={{ height: 56, borderRadius: 6, border: '1px solid #e2e8f0' }} />
              <span style={{ fontSize: '0.8rem', color: '#64748b', flex: 1, textAlign: 'left' }}>Screenshot read — check the text below and edit if anything looks wrong.</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={e => { e.stopPropagation(); setImagePreview(null); }}
                aria-label="Remove screenshot"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: '#64748b' }}>
              <ImagePlus size={20} color="#94a3b8" />
              <span style={{ fontSize: '0.82rem' }}><strong>Click to upload</strong>, drag a screenshot here, or paste with Ctrl+V</span>
            </div>
          )}
        </div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onPaste={handlePaste}
          placeholder="…or paste the bank alert text here"
          rows={4}
          style={{ width: '100%', padding: '0.6rem 0.75rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="btn-primary" onClick={() => runMatch()} disabled={ocrRunning}><Wand2 size={15} /> Find Matching Invoice</button>
          {(parsed || matches.length > 0 || imagePreview) && (
            <button className="btn-ghost btn-sm" onClick={clearAll}>
              <RefreshCcw size={13} /> Clear
            </button>
          )}
        </div>
      </div>

      {parsed && (
        <div className="card" style={{ maxWidth: 640, marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>We understood this as:</h3>
          <div style={{ display: 'flex', gap: '1.5rem' }}>
            <div><span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Amount</span><br /><strong style={{ fontSize: '1.1rem' }}>{parsed.amount != null ? fmt(parsed.amount) : '— not found'}</strong></div>
            <div><span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Sender</span><br /><strong style={{ fontSize: '1.1rem' }}>{parsed.senderName ?? '— not found'}</strong></div>
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ marginBottom: '0.75rem' }}>Possible matches</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {matches.map(m => (
              <div key={m.saleId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0.9rem', border: '1px solid #e2e8f0', borderRadius: 10, background: m.score >= 100 ? '#f0fdf4' : '#fff' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{m.customerName}</div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{m.date} · Balance {fmt(m.balance)} of {fmt(m.totalAmount)}</div>
                </div>
                <button className="btn-primary btn-sm" onClick={() => openConfirm(m)}>
                  Confirm <ArrowRight size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {parsed && matches.length === 0 && parsed.amount != null && (
        <Empty message="No unpaid invoices match this alert. Check Sales to record it manually if needed." />
      )}

      {confirmId && confirmSale && (
        <Modal onClose={() => setConfirmId(null)} maxWidth={400}>
            <div className="modal-header">
              <h2>Confirm Payment</h2>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
                Recording a payment for <strong>{confirmSale.customerName}</strong>'s invoice (balance {fmt(confirmSale.balance)}).
              </p>
              <div className="form-group">
                <label>Amount (₦)</label>
                <NumberInput value={confirmAmount} onChange={setConfirmAmount} />
              </div>
              <div className="form-group">
                <label>Payment Type</label>
                <select value={payTypeId} onChange={e => setPayTypeId(e.target.value)}>
                  <option value="">— select —</option>
                  {payTypesQ.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setConfirmId(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmPayment} disabled={payMut.pending}>
                {payMut.pending ? 'Saving…' : <><CheckCircle2 size={15} /> Record Payment</>}
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}

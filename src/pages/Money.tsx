import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ArrowLeftRight, Banknote, Landmark, Wallet, Pencil, X, Ban, FileCheck2 } from 'lucide-react';
import { money, bank, BankStatementSummary, MoneyAccount, MoneyAccountFlow, MoneyLine, MoneyEntryKind, CashFlow, PaymentTypeAccount } from '../lib/api';
import { CATEGORY_LABEL, ENTRY_KINDS, KIND_LABEL, naira } from '../lib/money';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { useBranches } from '../lib/useBranches';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column } from '../components/DataTable';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import StatementUploadModal from '../components/StatementUploadModal';
import PlanLock from '../components/PlanLock';
import { hasFeature } from '../lib/features';
import './Money.scss';

const today = () => new Date().toISOString().slice(0, 10);
const prettyDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const KIND_ICON = { cash: Banknote, bank: Landmark, wallet: Wallet } as const;

// Bank & Cash (migration 0061): what each account holds right now, every
// naira in and out of it, and the tools to record money that isn't a
// sale or an expense: moving money between accounts, owner money, loans.
export default function Money() {
  const { profile, tenant } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const allowed = hasFeature(tenant, 'accounting');
  const flowQ = useQuery<CashFlow>(() => money.cashFlow(null, today()), [], { cacheKey: 'money-overview' });
  const typesQ = useQuery<PaymentTypeAccount[]>(() => money.paymentTypes(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<MoneyAccount> | null>(null);
  const [entryKind, setEntryKind] = useState<MoneyEntryKind | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null | false>(false);
  const statementsQ = useQuery<BankStatementSummary[]>(() => bank.list(), []);

  const accounts = flowQ.data?.accounts ?? [];
  const live = accounts.filter(a => a.is_active || showInactive);
  const current = accounts.find(a => a.id === (selected ?? live[0]?.id)) ?? null;
  const total = accounts.filter(a => a.is_active).reduce((s, a) => s + Number(a.closing || 0), 0);
  const byKind = (k: string) => accounts.filter(a => a.is_active && a.kind === k).reduce((s, a) => s + Number(a.closing || 0), 0);
  const needsStart = accounts.filter(a => a.is_active && !a.opening_date);

  const refresh = () => { flowQ.refetch(); typesQ.refetch(); statementsQ.refetch(); };

  if (!allowed) return (
    <div className="money">
      <div className="page-header"><div className="page-title"><h1>Bank &amp; Cash</h1><p>Where your money is right now, and every naira that went in or out.</p></div></div>
      <PlanLock feature="accounting" title="Bank & Cash">
        <p>See where your money is right now, in every cash drawer, bank account and POS wallet, and every naira that went in or out.</p>
        <ul>
          <li>Record money moved between accounts, owner money and loans</li>
          <li>Check your bank or Moniepoint statement against ProfixBook</li>
          <li>Cash flow and balance sheet reports, and the accountant pack</li>
        </ul>
        <p>ProfixBook already keeps track of this in the background, so everything is there the day you upgrade.</p>
      </PlanLock>
    </div>
  );
  if (flowQ.loading && !flowQ.data) return <Loading label="Adding up your money…" />;
  if (flowQ.error) return <ErrorState message={flowQ.error} onRetry={flowQ.refetch} />;

  return (
    <div className="money">
      <div className="page-header">
        <div className="page-title">
          <h1>Bank &amp; Cash</h1>
          <p>Where your money is right now, and every naira that went in or out.</p>
        </div>
        <div className="money-head-actions">
          <button type="button" className="btn-secondary" onClick={() => setEditing({ kind: 'bank', opening_balance: 0, opening_date: today(), is_active: true })}>
            <Plus size={16} /> Add account
          </button>
          <button type="button" className="btn-primary" onClick={() => setEntryKind('transfer')}>
            <ArrowLeftRight size={16} /> Record money
          </button>
        </div>
      </div>

      <section className="money-total" aria-label="All your money">
        <div>
          <span className="money-total-label">All your money</span>
          <strong className="money-total-value">{naira(total)}</strong>
        </div>
        <dl className="money-total-split">
          <div><dt>Cash</dt><dd>{naira(byKind('cash'))}</dd></div>
          <div><dt>Bank</dt><dd>{naira(byKind('bank'))}</dd></div>
          <div><dt>Wallets</dt><dd>{naira(byKind('wallet'))}</dd></div>
        </dl>
      </section>

      {needsStart.length > 0 && (
        <div className="money-note">
          <strong>Set a starting balance for each account.</strong>{' '}
          ProfixBook only knows the money that went through it. Enter what an account held on a day you choose,
          and its balance counts from there. Still to do: {needsStart.map(a => a.name).join(', ')}.
        </div>
      )}

      <div className="money-accounts">
        {live.map(a => {
          const Icon = KIND_ICON[a.kind];
          const on = current?.id === a.id;
          return (
            <button key={a.id} type="button" className={`money-acct${on ? ' is-on' : ''}${a.is_active ? '' : ' is-off'}`}
                    onClick={() => setSelected(a.id)} aria-pressed={on}>
              <span className="money-acct-top">
                <span className={`money-acct-icon is-${a.kind}`}><Icon size={16} aria-hidden="true" /></span>
                <span className="money-acct-name">{a.name}</span>
              </span>
              <strong className={`money-acct-bal${Number(a.closing) < 0 ? ' is-neg' : ''}`}>{naira(a.closing)}</strong>
              <span className="money-acct-sub">
                {KIND_LABEL[a.kind]}
                {a.is_default && ' · main account'}
                {!a.is_active && ' · switched off'}
                {!a.opening_date && a.is_active && ' · no starting balance'}
              </span>
            </button>
          );
        })}
      </div>
      {accounts.some(a => !a.is_active) && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setShowInactive(v => !v)}>
          {showInactive ? 'Hide switched-off accounts' : 'Show switched-off accounts'}
        </button>
      )}

      {current && <AccountLines account={current} onEdit={() => setEditing(current)} onChanged={refresh}
                                onCheck={current.kind !== 'cash' ? () => setUploadFor(current.id) : undefined} />}

      <Statements list={statementsQ.data ?? []} onUpload={() => setUploadFor(current && current.kind !== 'cash' ? current.id : null)} />

      <PaymentRouting types={typesQ.data ?? []} accounts={accounts.filter(a => a.is_active)} canEdit={isAdmin} onChanged={refresh} />

      {uploadFor !== false && (
        <StatementUploadModal accounts={accounts.filter(a => a.is_active)} defaultAccount={uploadFor} onClose={() => setUploadFor(false)} />
      )}
      {editing && <AccountModal account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {entryKind && (
        <EntryModal initialKind={entryKind} accounts={accounts.filter(a => a.is_active)} defaultFrom={current?.id ?? null}
                    onClose={() => setEntryKind(null)} onSaved={() => { setEntryKind(null); refresh(); }} />
      )}
    </div>
  );
}

function AccountLines({ account, onEdit, onChanged, onCheck }: { account: MoneyAccountFlow; onEdit: () => void; onChanged: () => void; onCheck?: () => void }) {
  const toast = useToast();
  const linesQ = useQuery<MoneyLine[]>(() => money.lines(account.id), [account.id, account.closing]);
  const [voidFor, setVoidFor] = useState<MoneyLine | null>(null);
  const [voiding, setVoiding] = useState(false);

  // Movements before the starting date are history the starting balance
  // already covers; they are shown greyed, not counted.
  const counts = (l: MoneyLine) => !account.opening_date || l.entry_date >= account.opening_date;

  const confirmVoid = async () => {
    if (!voidFor) return;
    setVoiding(true);
    try {
      await money.voidEntry(voidFor.source_id);
      toast.success('Entry voided. It no longer counts in any balance.');
      onChanged();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not void that entry.');
    } finally {
      setVoiding(false);
      setVoidFor(null);
    }
  };

  const columns: Column<MoneyLine>[] = [
    { key: 'entry_date', header: 'Date', value: l => l.entry_date, render: l => prettyDate(l.entry_date) },
    { key: 'description', header: 'What', value: l => l.description ?? '',
      render: l => <span className={counts(l) ? undefined : 'money-before'}>{l.description}</span> },
    { key: 'category', header: 'Kind', value: l => CATEGORY_LABEL[l.category] ?? l.category,
      render: l => <span className="badge-gray">{CATEGORY_LABEL[l.category] ?? l.category}</span> },
    { key: 'in', header: 'In', align: 'right', value: l => (l.amount > 0 ? l.amount : 0),
      render: l => l.amount > 0 ? <span className={`money-in${counts(l) ? '' : ' money-before'}`}>{naira(l.amount)}</span> : null },
    { key: 'out', header: 'Out', align: 'right', value: l => (l.amount < 0 ? -l.amount : 0),
      render: l => l.amount < 0 ? <span className={counts(l) ? undefined : 'money-before'}>{naira(-l.amount)}</span> : null },
  ];

  return (
    <section className="card money-lines">
      <div className="money-lines-head">
        <div>
          <h3>{account.name}</h3>
          <p>
            {account.opening_date
              ? <>Started with {naira(account.opening_balance)} on {prettyDate(account.opening_date)}. Now {naira(account.closing)}.</>
              : <>No starting balance yet, so this is only the money ProfixBook has seen. Now {naira(account.closing)}.</>}
            {account.bank_name && account.kind !== 'cash' && <> {account.bank_name}{account.account_number ? ` ${account.account_number}` : ''}.</>}
          </p>
        </div>
        <div className="money-lines-actions">
          {onCheck && <button type="button" className="btn-secondary btn-sm" onClick={onCheck}><FileCheck2 size={14} /> Check statement</button>}
          <button type="button" className="btn-secondary btn-sm" onClick={onEdit}><Pencil size={14} /> Edit account</button>
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={linesQ.data ?? null}
        loading={linesQ.loading}
        error={linesQ.error}
        onRetry={linesQ.refetch}
        getRowKey={l => String(l.id)}
        searchKeys={[l => l.description ?? '', l => CATEGORY_LABEL[l.category] ?? '']}
        searchPlaceholder="Search movements…"
        exportName={`money-${account.name}`}
        exportTitle={account.name}
        rowActions={[{ icon: <Ban size={15} />, label: 'Void entry', variant: 'danger', onClick: setVoidFor,
                       show: l => l.source_table === 'money_entries' }]}
        emptyMessage="No money has gone in or out of this account yet."
      />
      {voidFor && (
        <ConfirmDialog
          title="Void entry"
          message={<>Void "{voidFor.description}" for {naira(Math.abs(voidFor.amount))}? It stops counting in every balance. A void can't be undone.</>}
          confirmLabel="Void entry"
          pending={voiding}
          onConfirm={confirmVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}
    </section>
  );
}

// Bank statements uploaded for checking (migration 0063).
function Statements({ list, onUpload }: { list: BankStatementSummary[]; onUpload: () => void }) {
  return (
    <section className="card money-statements">
      <div className="money-lines-head">
        <div>
          <h3>Bank statements</h3>
          <p>Upload a statement from your bank or Moniepoint app to check it against ProfixBook. Lost payments and charges nobody recorded show up straight away.</p>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={onUpload}><FileCheck2 size={14} /> Check a statement</button>
      </div>
      {list.length === 0 ? (
        <p className="money-muted">No statements checked yet.</p>
      ) : (
        <ul className="money-st-list">
          {list.map(s => (
            <li key={s.id}>
              <Link to={`/money/statements/${s.id}`} className="money-st-row">
                <span className="money-st-name">
                  <strong>{s.account_name}</strong>
                  <small>{prettyDate(s.period_from)} to {prettyDate(s.period_to)}{s.file_name ? ` · ${s.file_name}` : ''}</small>
                </span>
                {s.status === 'done'
                  ? <span className="badge-success">Finished</span>
                  : s.open > 0 ? <span className="badge-warning">{s.open} of {s.lines} to check</span>
                  : <span className="badge-primary">Ready to finish</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PaymentRouting({ types, accounts, canEdit, onChanged }: {
  types: PaymentTypeAccount[]; accounts: MoneyAccountFlow[]; canEdit: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const main = accounts.find(a => a.is_default);
  const automatic = (t: PaymentTypeAccount) => t.method_group === 'store_credit'
    ? 'Not real money, so not counted'
    : t.method_group === 'cash' ? 'The cash drawer of the branch' : `${main?.name ?? 'The main account'}`;
  // Store credit and "Credit" (sold on account) move no money.
  const shown = types.filter(t => t.method_group !== 'store_credit' && !/credit/i.test(t.name));

  const change = async (t: PaymentTypeAccount, value: string) => {
    setSaving(t.id);
    try {
      await money.setPaymentTypeAccount(t.id, value || null);
      toast.success(`${t.name} payments now land in ${value ? accounts.find(a => a.id === value)?.name : automatic(t).toLowerCase()}.`);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save that.');
    } finally {
      setSaving(null);
    }
  };

  if (shown.length === 0) return null;
  return (
    <section className="card money-routing">
      <h3>Where payments land</h3>
      <p>Which account each payment method goes into, for sales, supplier payments and expenses. Payments confirmed by Moniepoint, OPay or Paystack always go into that wallet.</p>
      <div className="money-routing-list">
        {shown.map(t => (
          <label key={t.id} className="money-routing-row">
            <span>{t.name}</span>
            <select value={t.money_account_id ?? ''} disabled={!canEdit || saving === t.id} onChange={e => change(t, e.target.value)}>
              <option value="">Automatic: {automatic(t)}</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      {!canEdit && <p className="money-muted">Only the owner can change this.</p>}
    </section>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: Partial<MoneyAccount>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { active } = useBranches();
  const isNew = !account.id;
  const [form, setForm] = useState({
    name: account.name ?? '', kind: account.kind ?? 'bank', bank_name: account.bank_name ?? '', account_number: account.account_number ?? '',
    opening_balance: Number(account.opening_balance ?? 0), opening_date: account.opening_date ?? today(),
    is_default: !!account.is_default, is_active: account.is_active ?? true, branch_id: account.branch_id ?? '',
  });
  const [setStart, setSetStart] = useState(isNew || !!account.opening_date);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = !!account.is_till || !!account.provider;   // made by ProfixBook; kind stays

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Give the account a name.'); return; }
    setPending(true); setError(null);
    try {
      await money.saveAccount({
        ...(account.id ? { id: account.id } : {}),
        name: form.name.trim(),
        ...(locked ? {} : { kind: form.kind as MoneyAccount['kind'] }),
        bank_name: form.kind === 'cash' ? null : form.bank_name.trim() || null,
        account_number: form.kind === 'cash' ? null : form.account_number.trim() || null,
        opening_balance: setStart ? form.opening_balance : 0,
        opening_date: setStart ? form.opening_date : null,
        ...(form.kind !== 'cash' && !account.is_default ? { is_default: form.is_default } : {}),
        ...(form.kind === 'cash' && !account.is_till ? { branch_id: form.branch_id || null } : {}),
        is_active: form.is_active,
      });
      toast.success(isNew ? 'Account added.' : 'Account saved.');
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save the account.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={480}>
      <div className="modal-header">
        <h2>{isNew ? 'Add account' : 'Edit account'}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorState message={error} />}
          {!locked && (
            <div className="form-group">
              <label>What kind of account?</label>
              <div className="money-kind-toggle">
                {(['cash', 'bank', 'wallet'] as const).map(k => (
                  <button key={k} type="button" className={form.kind === k ? 'active' : ''} onClick={() => setForm(f => ({ ...f, kind: k }))}>
                    {k === 'cash' ? 'Cash (safe, petty cash)' : k === 'bank' ? 'Bank account' : 'Wallet (POS, app)'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="acct-name">Name</label>
            <input id="acct-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                   placeholder={form.kind === 'cash' ? 'e.g. Office safe' : form.kind === 'bank' ? 'e.g. GTBank current account' : 'e.g. Palmpay POS'} />
          </div>
          {form.kind !== 'cash' && (
            <div className="grid-2">
              <div className="form-group">
                <label htmlFor="acct-bank">{form.kind === 'bank' ? 'Bank' : 'Provider'}</label>
                <input id="acct-bank" value={form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label htmlFor="acct-no">Account number</label>
                <input id="acct-no" inputMode="numeric" value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
              </div>
            </div>
          )}
          {form.kind === 'cash' && !account.is_till && active.length > 1 && (
            <div className="form-group">
              <label htmlFor="acct-branch">Branch</label>
              <select id="acct-branch" value={form.branch_id} onChange={e => setForm(f => ({ ...f, branch_id: e.target.value }))}>
                <option value="">Not tied to a branch</option>
                {active.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}

          <hr className="divider" />
          <label className="money-check">
            <input type="checkbox" checked={setStart} onChange={e => setSetStart(e.target.checked)} />
            <span>Set a starting balance</span>
          </label>
          {setStart && (
            <div className="grid-2">
              <div className="form-group">
                <label htmlFor="acct-open">Money in it (₦)</label>
                <NumberInput id="acct-open" value={form.opening_balance} onChange={v => setForm(f => ({ ...f, opening_balance: v }))} />
              </div>
              <div className="form-group">
                <label htmlFor="acct-open-date">On this day</label>
                <input id="acct-open-date" type="date" value={form.opening_date} max={today()} onChange={e => setForm(f => ({ ...f, opening_date: e.target.value }))} />
              </div>
            </div>
          )}
          <small className="money-muted">
            Count the cash, or check the bank app, at the start of a day. Money ProfixBook recorded before that day is already in this figure, so it won't be counted again.
          </small>

          {form.kind !== 'cash' && !account.is_default && (
            <label className="money-check">
              <input type="checkbox" checked={form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} />
              <span>Main account: transfers and card payments land here unless you choose otherwise</span>
            </label>
          )}
          {!isNew && !account.is_default && (
            <label className="money-check">
              <input type="checkbox" checked={!form.is_active} onChange={e => setForm(f => ({ ...f, is_active: !e.target.checked }))} />
              <span>Switch this account off (it stays in your history)</span>
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : isNew ? 'Add account' : 'Save account'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EntryModal({ initialKind, accounts, defaultFrom, onClose, onSaved }: {
  initialKind: MoneyEntryKind; accounts: MoneyAccountFlow[]; defaultFrom: string | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<MoneyEntryKind>(initialKind);
  const [from, setFrom] = useState(defaultFrom ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = useMemo(() => ENTRY_KINDS.find(k => k.id === kind)!, [kind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0) { setError('Enter an amount above zero.'); return; }
    if (spec.from && !from) { setError('Pick the account the money came out of.'); return; }
    if (spec.to && !to) { setError('Pick the account the money went into.'); return; }
    if (spec.from && spec.to && from === to) { setError('Pick two different accounts.'); return; }
    setPending(true); setError(null);
    try {
      await money.addEntry({ kind, from_account: spec.from ? from : null, to_account: spec.to ? to : null, amount, entry_date: date, note: note.trim() || null });
      toast.success('Recorded.');
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not record that.');
    } finally {
      setPending(false);
    }
  };

  const picker = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={e => set(e.target.value)}>
        <option value="">Choose an account</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({naira(a.closing)})</option>)}
      </select>
    </div>
  );

  return (
    <Modal onClose={onClose} maxWidth={500}>
      <div className="modal-header">
        <h2>Record money</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorState message={error} />}
          <div className="form-group">
            <label htmlFor="entry-kind">What happened?</label>
            <select id="entry-kind" value={kind} onChange={e => setKind(e.target.value as MoneyEntryKind)}>
              {ENTRY_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <small className="money-muted">{spec.hint}</small>
          </div>
          <div className={spec.from && spec.to ? 'grid-2' : undefined}>
            {spec.from && picker('entry-from', 'From', from, setFrom)}
            {spec.to && picker('entry-to', 'Into', to, setTo)}
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="entry-amount">Amount (₦)</label>
              <NumberInput id="entry-amount" value={amount} onChange={setAmount} />
            </div>
            <div className="form-group">
              <label htmlFor="entry-date">Date</label>
              <input id="entry-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="entry-note">Note (optional)</label>
            <input id="entry-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Deposit slip 00412" />
          </div>
          <small className="money-muted">Sales, supplier payments and expenses are recorded on their own pages, and show up here by themselves.</small>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Record'}</button>
        </div>
      </form>
    </Modal>
  );
}

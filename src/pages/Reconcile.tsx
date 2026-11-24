import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Link2, Plus, X, Undo2, CircleCheck } from 'lucide-react';
import { bank, BankLine, BankMatch, BankStatementView, BankAddKind, lookups, Lookup } from '../lib/api';
import { CATEGORY_LABEL, naira } from '../lib/money';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import './Reconcile.scss';

const prettyDate = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const signed = (n: number) => (n > 0 ? '+' : '−') + naira(Math.abs(n));

type Filter = 'todo' | 'matched' | 'ignored' | 'all';

// Checking a bank statement against ProfixBook (migration 0063).
export default function Reconcile() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const q = useQuery<BankStatementView>(() => bank.view(id), [id]);
  const [filter, setFilter] = useState<Filter>('todo');
  const [matchFor, setMatchFor] = useState<BankLine | null>(null);
  const [addFor, setAddFor] = useState<BankLine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (q.loading && !q.data) return <Loading label="Opening the statement…" />;
  if (q.error) return <ErrorState message={q.error} onRetry={q.refetch} />;
  const st = q.data!;
  const done = st.status === 'done';
  const counts = {
    todo: st.lines.filter(l => l.status === 'open').length,
    matched: st.lines.filter(l => l.status === 'matched').length,
    ignored: st.lines.filter(l => l.status === 'ignored').length,
    all: st.lines.length,
  };
  const shown = st.lines.filter(l => filter === 'all' || (filter === 'todo' ? l.status === 'open' : l.status === filter));
  const finished = counts.matched + counts.ignored;
  const diff = st.statement_closing === null ? null : Number(st.statement_closing) - Number(st.book_closing);
  const missingTotal = st.missing.reduce((s, m) => s + Number(m.amount), 0);

  const act = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast.success(ok); q.refetch(); }
    catch (e: any) { toast.error(e?.message ?? 'Could not do that.'); }
    finally { setBusy(null); }
  };

  const finish = () => act('finish', () => bank.finish(st.id), 'Statement checked and finished.');
  const reopen = () => act('reopen', () => bank.reopen(st.id), 'Statement reopened.');
  const remove = async () => {
    setBusy('remove');
    try { await bank.remove(st.id); toast.success('Upload removed.'); navigate('/money'); }
    catch (e: any) { toast.error(e?.message ?? 'Could not remove it.'); setBusy(null); setConfirmRemove(false); }
  };

  return (
    <div className="rc">
      <Link to="/money" className="rc-back"><ArrowLeft size={14} aria-hidden="true" /> Bank &amp; Cash</Link>
      <div className="page-header">
        <div className="page-title">
          <h1>{st.account.name} statement</h1>
          <p>
            {prettyDate(st.period_from)} to {prettyDate(st.period_to)}
            {st.file_name && <> · {st.file_name}</>}
            {done && <> · <span className="badge-success">Finished</span></>}
          </p>
        </div>
        <div className="rc-head-actions">
          {!done && (
            <>
              <button type="button" className="btn-ghost" onClick={() => setConfirmRemove(true)}>Remove upload</button>
              <button type="button" className="btn-primary" onClick={finish} disabled={counts.todo > 0 || busy === 'finish'}
                      title={counts.todo > 0 ? 'Match, add or skip every line first' : undefined}>
                <CircleCheck size={16} aria-hidden="true" /> Finish
              </button>
            </>
          )}
          {done && isAdmin && <button type="button" className="btn-secondary" onClick={reopen} disabled={busy === 'reopen'}>Reopen</button>}
        </div>
      </div>

      <section className="rc-summary" aria-label="Balances">
        <div>
          <span className="rc-sum-label">Bank statement says</span>
          <strong>{st.statement_closing === null ? 'Not in the file' : naira(st.statement_closing)}</strong>
          <span className="rc-sum-sub">on {prettyDate(st.period_to)}</span>
        </div>
        <div>
          <span className="rc-sum-label">ProfixBook says</span>
          <strong>{naira(st.book_closing)}</strong>
          <span className="rc-sum-sub">on the same day</span>
        </div>
        <div className={diff !== null && Math.abs(diff) >= 0.01 ? 'is-off' : diff !== null ? 'is-ok' : undefined}>
          <span className="rc-sum-label">Difference</span>
          <strong>{diff === null ? 'Unknown' : Math.abs(diff) < 0.01 ? 'None' : naira(Math.abs(diff))}</strong>
          <span className="rc-sum-sub">
            {diff === null ? 'The file has no balance column'
              : Math.abs(diff) < 0.01 ? 'They agree'
              : diff > 0 ? 'More in the bank than in ProfixBook' : 'Less in the bank than in ProfixBook'}
          </span>
        </div>
        <div className="rc-progress">
          <span className="rc-sum-label">Lines checked</span>
          <strong>{finished} of {counts.all}</strong>
          <span className="rc-bar" aria-hidden="true"><span style={{ width: `${counts.all ? (finished / counts.all) * 100 : 0}%` }} /></span>
        </div>
      </section>

      <section className="card rc-lines">
        <div className="rc-lines-head">
          <h3>On the bank statement</h3>
          <div className="rc-chips" role="group" aria-label="Show">
            {([['todo', 'To check'], ['matched', 'Matched'], ['ignored', 'Skipped'], ['all', 'All']] as [Filter, string][]).map(([f, label]) => (
              <button key={f} type="button" className={filter === f ? 'is-on' : ''} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {label} <span className="rc-count">{counts[f]}</span>
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="rc-empty">
            {filter === 'todo' ? (done ? 'This statement is finished.' : 'Every line is matched or skipped. You can finish this statement.') : 'Nothing here.'}
          </p>
        ) : (
          <ul className="rc-list">
            {shown.map(l => (
              <li key={l.id} className={`rc-line is-${l.status}`}>
                <div className="rc-line-what">
                  <span className="rc-line-date">{prettyDate(l.date)}</span>
                  <span className="rc-line-desc">{l.description || 'No description'}</span>
                  {l.reference && <span className="rc-line-ref">Ref {l.reference}</span>}
                </div>
                <strong className={`rc-line-amt${l.amount > 0 ? ' rc-in' : ''}`}>{signed(l.amount)}</strong>
                <div className="rc-line-state">
                  {l.status === 'matched' && l.match && (
                    <>
                      <span className="rc-state-ok"><Check size={14} aria-hidden="true" /> {l.matched_how === 'added' ? 'Added to ProfixBook' : 'Matched'}</span>
                      <span className="rc-state-detail">
                        {l.match.description ?? CATEGORY_LABEL[l.match.category] ?? 'Recorded'}, {shortDate(l.match.date)}
                        {Math.abs(Number(l.match.amount) - Number(l.amount)) >= 0.01 && <> · recorded as {naira(Math.abs(l.match.amount))}</>}
                      </span>
                    </>
                  )}
                  {l.status === 'open' && <span className="rc-state-todo">Not found in ProfixBook</span>}
                  {l.status === 'ignored' && <span className="rc-state-skip">Skipped</span>}
                </div>
                {!done && (
                  <div className="rc-line-actions">
                    {l.status === 'open' && (
                      <>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setMatchFor(l)}><Link2 size={14} aria-hidden="true" /> Match</button>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setAddFor(l)}><Plus size={14} aria-hidden="true" /> Add</button>
                        <button type="button" className="btn-ghost btn-sm" disabled={busy === l.id}
                                onClick={() => act(l.id, () => bank.ignore(l.id, true))}>Skip</button>
                      </>
                    )}
                    {l.status === 'matched' && l.matched_how !== 'added' && (
                      <button type="button" className="btn-ghost btn-sm" disabled={busy === l.id} onClick={() => act(l.id, () => bank.unmatch(l.id))}>Unmatch</button>
                    )}
                    {l.status === 'ignored' && (
                      <button type="button" className="btn-ghost btn-sm" disabled={busy === l.id} onClick={() => act(l.id, () => bank.ignore(l.id, false))}>
                        <Undo2 size={14} aria-hidden="true" /> Undo
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card rc-missing">
        <h3>In ProfixBook, not on the statement</h3>
        <p className="rc-hint">
          {st.missing.length === 0
            ? 'Everything ProfixBook recorded for this account in these dates is on the statement.'
            : <>Recorded in ProfixBook for this account between these dates, but the bank doesn't show them. Check each one:
                a transfer a customer said they sent that never arrived, or a payment recorded in the wrong account. If one is on the
                statement under a different amount or date, use Match on that line.</>}
        </p>
        {st.missing.length > 0 && (
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead><tr><th>Date</th><th>What</th><th>Kind</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {st.missing.map(m => (
                  <tr key={`${m.table}:${m.id}`}>
                    <td className="nowrap">{prettyDate(m.date)}</td>
                    <td>{m.description}</td>
                    <td><span className="badge-gray">{CATEGORY_LABEL[m.category] ?? m.category}</span></td>
                    <td className={`r${m.amount > 0 ? ' rc-in' : ''}`}>{signed(Number(m.amount))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Total ({st.missing.length})</td><td className="r">{signed(missingTotal)}</td></tr></tfoot>
            </table>
          </div>
        )}
      </section>

      {matchFor && <MatchModal line={matchFor} onClose={() => setMatchFor(null)} onDone={() => { setMatchFor(null); q.refetch(); }} />}
      {addFor && <AddModal line={addFor} onClose={() => setAddFor(null)} onDone={() => { setAddFor(null); q.refetch(); }} />}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove upload"
          message="Remove this statement and its matches? Anything you added to ProfixBook from it stays recorded. You can upload the file again."
          confirmLabel="Remove upload"
          pending={busy === 'remove'}
          onConfirm={remove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

function MatchModal({ line, onClose, onDone }: { line: BankLine; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery<BankMatch[]>(() => bank.candidates(line.id), [line.id]);
  const [pick, setPick] = useState<string>('');
  const [pending, setPending] = useState(false);
  const list = q.data ?? [];

  const submit = async () => {
    const m = list.find(c => `${c.table}:${c.id}` === pick);
    if (!m) return;
    setPending(true);
    try { await bank.match(line.id, m); toast.success('Matched.'); onDone(); }
    catch (e: any) { toast.error(e?.message ?? 'Could not match it.'); setPending(false); }
  };

  return (
    <Modal onClose={onClose} maxWidth={600}>
      <div className="modal-header">
        <h2>Match this line</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        <div className="rc-line-card">
          <span>{prettyDate(line.date)} · {line.description || 'No description'}</span>
          <strong className={line.amount > 0 ? 'rc-in' : undefined}>{signed(line.amount)}</strong>
        </div>
        <p className="rc-hint">Pick what this is in ProfixBook. Closest amounts first, from the same account, within a month.</p>
        {q.loading && !q.data && <Loading label="Looking for matches…" />}
        {q.error && <ErrorState message={q.error} onRetry={q.refetch} />}
        {q.data && list.length === 0 && (
          <p className="rc-empty">Nothing in this account looks like it. If ProfixBook doesn't have it, close this and use Add.</p>
        )}
        {list.length > 0 && (
          <div className="rc-pick" role="radiogroup" aria-label="Movements in ProfixBook">
            {list.map(c => {
              const key = `${c.table}:${c.id}`;
              const off = Math.abs(Number(c.amount) - Number(line.amount));
              return (
                <label key={key} className={`rc-pick-row${pick === key ? ' is-on' : ''}`}>
                  <input type="radio" name="rc-pick" value={key} checked={pick === key} onChange={() => setPick(key)} />
                  <span className="rc-pick-what">
                    <span>{c.description ?? CATEGORY_LABEL[c.category]}</span>
                    <small>{prettyDate(c.date)} · {CATEGORY_LABEL[c.category] ?? c.category}{off >= 0.01 && <> · {naira(off)} different</>}</small>
                  </span>
                  <strong className={c.amount > 0 ? 'rc-in' : undefined}>{signed(Number(c.amount))}</strong>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={!pick || pending}>{pending ? 'Matching…' : 'Match'}</button>
      </div>
    </Modal>
  );
}

const OUT_KINDS: { id: BankAddKind; label: string; hint: string }[] = [
  { id: 'expense', label: 'A bank charge or other expense', hint: 'SMS alerts, card fees, stamp duty, or a cost paid from this account.' },
  { id: 'owner_out', label: 'Owner took money out', hint: 'Money taken for personal use. Not a business cost.' },
  { id: 'loan_repay', label: 'Loan repayment', hint: 'Paying back a loan. Put any interest on the Expenses page.' },
  { id: 'vat_paid', label: 'VAT paid to the tax office', hint: 'Lowers the VAT you owe. Not an expense.' },
];
const IN_KINDS: { id: BankAddKind; label: string; hint: string }[] = [
  { id: 'other_in', label: 'Other money in', hint: 'Interest from the bank, a refund from a supplier, anything that isn’t a sale.' },
  { id: 'owner_in', label: 'Owner put money in', hint: 'Your own money going into the business. Not profit.' },
  { id: 'loan_in', label: 'Loan received', hint: 'Money borrowed that you will pay back.' },
];

function AddModal({ line, onClose, onDone }: { line: BankLine; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const out = line.amount < 0;
  const kinds = out ? OUT_KINDS : IN_KINDS;
  const [kind, setKind] = useState<BankAddKind>(kinds[0].id);
  const [type, setType] = useState('');
  const [note, setNote] = useState(line.description ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typesQ = useQuery<Lookup[]>(() => lookups.expenseTypes(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      await bank.add(line.id, kind, kind === 'expense' ? type || null : null, note.trim() || null);
      toast.success('Added to ProfixBook and matched.');
      onDone();
    } catch (err: any) {
      setError(err?.message ?? 'Could not add it.');
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={540}>
      <div className="modal-header">
        <h2>Add to ProfixBook</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorState message={error} />}
          <div className="rc-line-card">
            <span>{prettyDate(line.date)} · {line.description || 'No description'}</span>
            <strong className={line.amount > 0 ? 'rc-in' : undefined}>{signed(line.amount)}</strong>
          </div>
          <fieldset className="rc-kinds">
            <legend>{out ? 'What was this money for?' : 'Where did this money come from?'}</legend>
            {kinds.map(k => (
              <label key={k.id} className={`rc-kind${kind === k.id ? ' is-on' : ''}`}>
                <input type="radio" name="rc-kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
                <span><strong>{k.label}</strong><small>{k.hint}</small></span>
              </label>
            ))}
          </fieldset>
          {kind === 'expense' && (
            <div className="form-group">
              <label htmlFor="rc-type">Expense type</label>
              <select id="rc-type" value={type} onChange={e => setType(e.target.value)}>
                <option value="">No type</option>
                {(typesQ.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="rc-note">Note</label>
            <input id="rc-note" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
          </div>
          <small className="rc-muted">
            {out
              ? 'If it was a supplier payment, record it on the purchase instead, then come back and use Match.'
              : 'If it was a customer paying for a sale, record the payment on the sale instead, then come back and use Match.'}
          </small>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Adding…' : 'Add and match'}</button>
        </div>
      </form>
    </Modal>
  );
}

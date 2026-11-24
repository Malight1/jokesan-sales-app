import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Upload, FileSpreadsheet } from 'lucide-react';
import { bank, MoneyAccountFlow } from '../lib/api';
import { readGrid, findHeader, guessColumns, buildRows, closingBalance, ColumnMap, Grid, NO_COLUMN } from '../lib/bankStatement';
import { naira } from '../lib/money';
import { useToast } from '../lib/ToastContext';
import Modal from './Modal';
import { ErrorState } from './DataStates';
import '../pages/Reconcile.scss';

const prettyDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const FIELDS: { key: keyof ColumnMap; label: string; need?: boolean }[] = [
  { key: 'date', label: 'Date', need: true },
  { key: 'description', label: 'Description' },
  { key: 'credit', label: 'Money in' },
  { key: 'debit', label: 'Money out' },
  { key: 'amount', label: 'Amount (+ in, − out)' },
  { key: 'balance', label: 'Balance' },
  { key: 'reference', label: 'Reference' },
];

// Upload a bank or wallet statement for one account (migration 0063).
// The file is read here in the browser; only the lines go to ProfixBook.
export default function StatementUploadModal({ accounts, defaultAccount, onClose }: {
  accounts: MoneyAccountFlow[]; defaultAccount: string | null; onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState(defaultAccount ?? accounts.find(a => a.kind !== 'cash')?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (f: File) => {
    setError(null);
    try {
      const g = await readGrid(f);
      if (g.length < 2) { setError('That file looks empty.'); return; }
      const h = findHeader(g);
      setFile(f); setGrid(g); setHeaderIdx(h); setMap(guessColumns(g[h]));
    } catch {
      setError('Could not read that file. Download the statement from your bank as CSV or Excel and try again.');
    }
  };

  const headers = useMemo(() => (grid ? grid[headerIdx].map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`) : []), [grid, headerIdx]);
  const built = useMemo(() => (grid && map ? buildRows(grid, headerIdx, map) : null), [grid, headerIdx, map]);
  const rows = built?.rows ?? [];
  const moneyIn = rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const moneyOut = rows.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const dates = rows.map(r => r.date).sort();
  const hasMoney = !!map && (map.debit >= 0 || map.credit >= 0 || map.amount >= 0);

  const setCol = (key: keyof ColumnMap, v: number) => setMap(m => {
    if (!m) return m;
    const next = { ...m, [key]: v };
    // One way of reading money at a time.
    if (key === 'amount' && v >= 0) { next.debit = NO_COLUMN; next.credit = NO_COLUMN; }
    if ((key === 'debit' || key === 'credit') && v >= 0) next.amount = NO_COLUMN;
    return next;
  });

  const submit = async () => {
    if (!accountId) { setError('Pick the account this statement is for.'); return; }
    if (!map || map.date < 0 || !hasMoney) { setError('Choose the date column and at least one money column.'); return; }
    if (rows.length === 0) { setError('No lines with a date and an amount were found. Check the columns below.'); return; }
    setPending(true); setError(null);
    try {
      const r = await bank.upload(accountId, file?.name ?? 'statement', rows, closingBalance(rows));
      toast.success(`${r.lines} lines uploaded. ${r.matched} matched by themselves${r.skipped ? `, ${r.skipped} already uploaded before` : ''}.`);
      navigate(`/money/statements/${r.id}`);
    } catch (e: any) {
      setError(e?.message ?? 'Could not upload the statement.');
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={760}>
      <div className="modal-header">
        <h2>Check a bank statement</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p className="rc-intro">
          Download the statement from your bank or Moniepoint app as CSV or Excel. ProfixBook matches each line
          to what you recorded, and shows you what is missing on either side.
        </p>
        <div className="form-group">
          <label htmlFor="st-account">Which account is it for?</label>
          <select id="st-account" value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {!grid ? (
          <label className="rc-drop">
            <input type="file" accept=".csv,.xlsx,.xls" className="rc-file" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            <Upload size={26} aria-hidden="true" />
            <strong>Choose the statement file</strong>
            <span>CSV or Excel</span>
          </label>
        ) : (
          <>
            <div className="rc-file-row">
              <FileSpreadsheet size={18} aria-hidden="true" />
              <span className="rc-file-name">{file?.name}</span>
              <label className="btn-ghost btn-sm rc-change">
                Change file
                <input type="file" accept=".csv,.xlsx,.xls" className="rc-file" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              </label>
            </div>

            <h3 className="rc-sub">Columns in your file</h3>
            <p className="rc-hint">We guessed these. Change any that are wrong. Use either "Money in" and "Money out", or one "Amount" column.</p>
            <div className="rc-cols">
              {FIELDS.map(f => (
                <div key={f.key} className="form-group">
                  <label htmlFor={`col-${f.key}`}>{f.label}</label>
                  <select id={`col-${f.key}`} value={map?.[f.key] ?? NO_COLUMN} onChange={e => setCol(f.key, Number(e.target.value))}>
                    <option value={NO_COLUMN}>{f.need ? 'Choose a column' : 'Not in this file'}</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {rows.length > 0 ? (
              <>
                <dl className="rc-preview-sum">
                  <div><dt>Lines</dt><dd>{rows.length}</dd></div>
                  <div><dt>Dates</dt><dd>{prettyDate(dates[0])} to {prettyDate(dates[dates.length - 1])}</dd></div>
                  <div><dt>Money in</dt><dd className="rc-in">{naira(moneyIn)}</dd></div>
                  <div><dt>Money out</dt><dd>{naira(moneyOut)}</dd></div>
                </dl>
                <div className="rc-table-wrap">
                  <table className="rc-table">
                    <thead><tr><th>Date</th><th>Description</th><th className="r">In</th><th className="r">Out</th></tr></thead>
                    <tbody>
                      {rows.slice(0, 6).map((r, i) => (
                        <tr key={i}>
                          <td className="nowrap">{prettyDate(r.date)}</td>
                          <td>{r.description || <span className="rc-muted">No description</span>}</td>
                          <td className="r rc-in">{r.amount > 0 ? naira(r.amount) : ''}</td>
                          <td className="r">{r.amount < 0 ? naira(-r.amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > 6 && <p className="rc-hint">and {rows.length - 6} more lines.</p>}
                {built && built.skipped > 0 && <p className="rc-hint">{built.skipped} rows without a date or amount were left out, such as opening and closing balance rows.</p>}
              </>
            ) : (
              <p className="rc-warn">No lines with a date and an amount yet. Check the Date and money columns above.</p>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={pending || rows.length === 0 || !accountId}>
          {pending ? 'Uploading…' : rows.length ? `Upload ${rows.length} lines` : 'Upload'}
        </button>
      </div>
    </Modal>
  );
}

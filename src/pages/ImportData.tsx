import React, { useState } from 'react';
import { Upload, FileSpreadsheet, Download, ArrowRight, ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useToast } from '../lib/ToastContext';
import { ENTITIES, EntityDef, parseSpreadsheet, autoGuess, downloadTemplate } from '../lib/importer';
import './ImportData.scss';

type Step = 1 | 2 | 3 | 4;
interface Result { imported: number; errors: { row: number; reason: string }[]; }

export default function ImportData() {
  const toast = useToast();
  const [step, setStep] = useState<Step>(1);
  const [entity, setEntity] = useState<EntityDef>(ENTITIES[0]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // field.key -> source header
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  const reset = () => {
    setStep(1); setRows([]); setHeaders([]); setMapping({}); setResult(null); setProgress(0);
  };

  const onFile = async (file: File) => {
    try {
      const parsed = await parseSpreadsheet(file);
      if (parsed.length === 0) { toast.error('That file has no rows.'); return; }
      const hdrs = Object.keys(parsed[0]);
      setRows(parsed);
      setHeaders(hdrs);
      // auto-guess mapping
      const guess: Record<string, string> = {};
      entity.fields.forEach(f => { guess[f.key] = autoGuess(f, hdrs); });
      setMapping(guess);
      setStep(3);
      toast.success(`Loaded ${parsed.length} rows.`);
    } catch (e: any) {
      toast.error(e.message ?? 'Could not read that file.');
    }
  };

  const mappedRow = (raw: Record<string, any>) => {
    const out: Record<string, any> = {};
    entity.fields.forEach(f => {
      const src = mapping[f.key];
      out[f.key] = src ? String(raw[src] ?? '').trim() : '';
    });
    return out;
  };

  const requiredOk = entity.fields.filter(f => f.required).every(f => mapping[f.key]);

  const runImport = async () => {
    setImporting(true);
    const errors: Result['errors'] = [];
    let imported = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = mappedRow(rows[i]);
      const missing = entity.fields.find(f => f.required && !row[f.key]);
      if (missing) { errors.push({ row: i + 2, reason: `Missing ${missing.label}` }); }
      else {
        try { await entity.create(row); imported++; }
        catch (e: any) { errors.push({ row: i + 2, reason: e.message ?? 'Insert failed' }); }
      }
      setProgress(Math.round(((i + 1) / rows.length) * 100));
    }
    setResult({ imported, errors });
    setImporting(false);
    setStep(4);
    if (imported > 0) toast.success(`${imported} ${entity.label.toLowerCase()} imported.`);
  };

  return (
    <div className="import-page">
      <div className="page-header">
        <div className="page-title"><h1>Import Data</h1><p>Bring your existing records into StockFlow from Excel or CSV</p></div>
      </div>

      <div className="import-steps">
        {['Choose', 'Upload', 'Map columns', 'Done'].map((label, i) => (
          <div key={label} className={`step-pill ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}>
            <span className="step-num">{step > i + 1 ? <CheckCircle2 size={14} /> : i + 1}</span> {label}
          </div>
        ))}
      </div>

      {/* STEP 1 — choose entity */}
      {step === 1 && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>What do you want to import?</h3>
          <div className="entity-grid">
            {ENTITIES.map(e => (
              <button key={e.id} className={`entity-tile ${entity.id === e.id ? 'selected' : ''}`} onClick={() => setEntity(e)}>
                <FileSpreadsheet size={22} />
                <span>{e.label}</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem' }}>
            <button className="btn-ghost btn-sm" onClick={() => downloadTemplate(entity)}>
              <Download size={14} /> Download {entity.label} template
            </button>
            <button className="btn-primary" onClick={() => setStep(2)}>Next <ArrowRight size={15} /></button>
          </div>
        </div>
      )}

      {/* STEP 2 — upload */}
      {step === 2 && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Upload your {entity.label} file</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>Excel (.xlsx) or CSV. The first row should be your column headers.</p>
          <label className="dropzone">
            <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            <Upload size={30} />
            <strong>Click to choose a file</strong>
            <span>or drag it here</span>
          </label>
          <div style={{ marginTop: '1.25rem' }}>
            <button className="btn-secondary" onClick={() => setStep(1)}><ArrowLeft size={15} /> Back</button>
          </div>
        </div>
      )}

      {/* STEP 3 — map columns + preview */}
      {step === 3 && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Match your columns</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            We matched them automatically — adjust any that are wrong. {rows.length} rows ready.
          </p>

          <div className="map-list">
            {entity.fields.map(f => (
              <div key={f.key} className="map-row">
                <div className="map-target">
                  {f.label}{f.required && <span style={{ color: '#dc2626' }}> *</span>}
                </div>
                <ArrowRight size={14} color="#94a3b8" />
                <select value={mapping[f.key] ?? ''} onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value }))}>
                  <option value="">— skip —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>

          {!requiredOk && (
            <div className="alert alert-warning" style={{ marginTop: '1rem', fontSize: '0.82rem' }}>
              <AlertTriangle size={15} /> Map all required fields (marked *) to continue.
            </div>
          )}

          <h4 style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.85rem', color: '#475569' }}>Preview (first 3 rows)</h4>
          <div className="table-wrapper">
            <table>
              <thead><tr>{entity.fields.map(f => <th key={f.key}>{f.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 3).map((r, i) => {
                  const m = mappedRow(r);
                  return <tr key={i}>{entity.fields.map(f => <td key={f.key} data-label={f.label}>{m[f.key] || <span style={{ color: '#cbd5e1' }}>—</span>}</td>)}</tr>;
                })}
              </tbody>
            </table>
          </div>

          {importing && (
            <div className="progress-wrap">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
              <span>{progress}% — importing…</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem' }}>
            <button className="btn-secondary" onClick={() => setStep(2)} disabled={importing}><ArrowLeft size={15} /> Back</button>
            <button className="btn-primary" onClick={runImport} disabled={!requiredOk || importing}>
              {importing ? 'Importing…' : `Import ${rows.length} ${entity.label}`}
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 — result */}
      {step === 4 && result && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <CheckCircle2 size={40} color="#16a34a" style={{ marginBottom: '0.75rem' }} />
          <h2 style={{ marginBottom: '0.35rem' }}>{result.imported} {entity.label} imported</h2>
          {result.errors.length > 0
            ? <p style={{ color: '#d97706', fontSize: '0.9rem' }}>{result.errors.length} row{result.errors.length !== 1 ? 's' : ''} skipped.</p>
            : <p style={{ color: '#64748b', fontSize: '0.9rem' }}>Every row imported cleanly. 🎉</p>}

          {result.errors.length > 0 && (
            <div className="table-wrapper" style={{ marginTop: '1.25rem', textAlign: 'left', maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
              <table>
                <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                <tbody>{result.errors.slice(0, 50).map((e, i) => <tr key={i}><td data-label="Row">{e.row}</td><td data-label="Reason">{e.reason}</td></tr>)}</tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.5rem' }}>
            <button className="btn-secondary" onClick={reset}>Import Another</button>
          </div>
        </div>
      )}
    </div>
  );
}

import React from 'react';
import { CustomFieldDef } from '../lib/api';
import NumberInput from './NumberInput';

// Renders one input per tenant-defined custom field (migration 0032,
// Phase 6e). Values are a plain { [key]: value } object — the shape the
// custom_fields jsonb column and set_custom_fields() both expect.
export default function CustomFieldsSection({ defs, values, onChange, title = 'Custom fields' }: {
  defs: CustomFieldDef[] | null | undefined;
  values: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  title?: string;
}) {
  if (!defs || defs.length === 0) return null;
  const set = (key: string, v: any) => onChange({ ...values, [key]: v });

  return (
    <div>
      <hr className="divider" />
      <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>{title}</p>
      <div className="grid-2">
        {defs.map(d => (
          <div className="form-group" key={d.id}>
            <label>{d.label}{d.required && ' *'}</label>
            {d.type === 'number' ? (
              <NumberInput value={values[d.key] ?? 0} onChange={v => set(d.key, v)} />
            ) : d.type === 'date' ? (
              <input type="date" value={values[d.key] ?? ''} onChange={e => set(d.key, e.target.value)} required={d.required} />
            ) : d.type === 'select' ? (
              <select value={values[d.key] ?? ''} onChange={e => set(d.key, e.target.value)} required={d.required}>
                <option value="">— select —</option>
                {(d.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input value={values[d.key] ?? ''} onChange={e => set(d.key, e.target.value)} required={d.required} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@labelconsole/ui';
import { api, ApiError, Button, FieldInput, useToast, type FieldSpec } from '@labelconsole/ui/client';
import type { ContractTerms } from '../schema';

const KINDS = [
  { value: 'expiry', label: 'Term ends' },
  { value: 'option', label: 'Option' },
  { value: 'renewal', label: 'Renewal' },
  { value: 'notice', label: 'Notice deadline' },
  { value: 'payment', label: 'Payment' },
  { value: 'other', label: 'Other' },
];

const EMPTY: ContractTerms = {
  agreementType: null,
  parties: [],
  effectiveDate: null,
  termDescription: null,
  termEndDate: null,
  territory: null,
  royaltyArtistPct: null,
  royaltyLabelPct: null,
  royaltyBasis: null,
  advanceAmount: null,
  advanceCurrency: null,
  recoupment: null,
  options: [],
  keyDates: [],
  releasesCovered: [],
  notes: null,
};

const SCALARS: FieldSpec[] = [
  { name: 'agreementType', label: 'Agreement type', placeholder: 'Exclusive recording agreement' },
  { name: 'territory', label: 'Territory', placeholder: 'World' },
  { name: 'effectiveDate', label: 'Effective from', type: 'date' },
  { name: 'termEndDate', label: 'Term ends', type: 'date' },
  { name: 'termDescription', label: 'Term', placeholder: '3 years, or 2 albums' },
  { name: 'royaltyBasis', label: 'Royalty basis', placeholder: 'Net receipts' },
  { name: 'royaltyArtistPct', label: 'Artist share %', type: 'number', step: '0.1', min: 0, max: 100 },
  { name: 'royaltyLabelPct', label: 'Label share %', type: 'number', step: '0.1', min: 0, max: 100 },
  { name: 'advanceAmount', label: 'Advance', type: 'number', step: '0.01', min: 0 },
  { name: 'advanceCurrency', label: 'Currency', placeholder: 'USD' },
  { name: 'recoupment', label: 'Recoupment', type: 'textarea', rows: 2 },
  { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 },
];

type Scalar = Exclude<keyof ContractTerms, 'parties' | 'options' | 'keyDates' | 'releasesCovered'>;

/**
 * Review AI-extracted contract terms, edit anything that is wrong, and confirm.
 * Confirming is what creates key dates and links artists; extraction alone never does.
 */
export function TermsReview({ documentId, initial, artistOptions, confirmed, disabled }: { documentId: string; initial: ContractTerms | null; artistOptions: Array<{ value: string; label: string }>; confirmed: boolean; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [t, setT] = useState<ContractTerms>({ ...EMPTY, ...(initial ?? {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof ContractTerms>(k: K, v: ContractTerms[K]) => setT((s) => ({ ...s, [k]: v }));

  const scalarValue = (k: Scalar) => t[k] ?? '';
  const setScalar = (f: FieldSpec, v: unknown) => {
    const k = f.name as Scalar;
    const val = v === '' || v == null ? null : f.type === 'number' ? Number(v) : String(v);
    set(k, val as never);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api(`/documents/${documentId}/confirm-terms`, {
        body: {
          ...t,
          advanceCurrency: t.advanceCurrency ? t.advanceCurrency.toUpperCase().slice(0, 3) : null,
          parties: t.parties.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), role: p.role.trim() || 'party', artistId: p.artistId || null })),
          keyDates: t.keyDates.filter((k) => k.date),
          options: t.options.filter((o) => o.description.trim()),
          releasesCovered: t.releasesCovered.filter(Boolean),
        },
      });
      toast('Terms confirmed. Key dates and reminders are set.');
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.details && 'fieldErrors' in e.details) {
        const fe = (e.details.fieldErrors ?? {}) as Record<string, string[]>;
        setFieldErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.split('.')[0], v[0]])));
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lc-stack" style={{ gap: 20 }}>
      <div className="lc-form-grid">
        {SCALARS.map((f) => (
          <FieldInput key={f.name} f={{ ...f }} value={scalarValue(f.name as Scalar)} error={fieldErrors[f.name]} onChange={(v) => setScalar(f, v)} />
        ))}
      </div>

      <ListEditor
        title="Parties"
        empty="No parties found. Add the artist and the label."
        rows={t.parties}
        onChange={(rows) => set('parties', rows)}
        blank={{ name: '', role: 'artist', artistId: null }}
        render={(p, up) => (
          <>
            <input className="lc-input" placeholder="Name" value={p.name} onChange={(e) => up({ ...p, name: e.target.value })} />
            <input className="lc-input" placeholder="Role" value={p.role} onChange={(e) => up({ ...p, role: e.target.value })} style={{ maxWidth: 140 }} />
            <select className="lc-select" value={p.artistId ?? ''} onChange={(e) => up({ ...p, artistId: e.target.value || null })} title="Link to an artist on the roster" style={{ maxWidth: 200 }}>
              <option value="">Not on roster</option>
              {artistOptions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </>
        )}
      />

      <ListEditor
        title="Key dates"
        empty="No dates. Reminders go out 90, 30 and 7 days before each one."
        rows={t.keyDates}
        onChange={(rows) => set('keyDates', rows)}
        blank={{ kind: 'notice' as ContractTerms['keyDates'][number]['kind'], date: '', description: '' }}
        render={(k, up) => (
          <>
            <select className="lc-select" value={k.kind} onChange={(e) => up({ ...k, kind: e.target.value as typeof k.kind })} style={{ maxWidth: 170 }}>
              {KINDS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input className="lc-input" type="date" value={k.date} onChange={(e) => up({ ...k, date: e.target.value })} style={{ maxWidth: 170 }} />
            <input className="lc-input" placeholder="What happens" value={k.description} onChange={(e) => up({ ...k, description: e.target.value })} />
          </>
        )}
      />

      <ListEditor
        title="Options"
        empty="No options in this agreement."
        rows={t.options}
        onChange={(rows) => set('options', rows)}
        blank={{ description: '', exerciseBy: null }}
        render={(o, up) => (
          <>
            <input className="lc-input" placeholder="e.g. Option for a second album" value={o.description} onChange={(e) => up({ ...o, description: e.target.value })} />
            <input className="lc-input" type="date" value={o.exerciseBy ?? ''} onChange={(e) => up({ ...o, exerciseBy: e.target.value || null })} style={{ maxWidth: 170 }} title="Exercise by" />
          </>
        )}
      />

      <FieldInput f={{ name: 'releasesCovered', label: 'Releases covered', type: 'tags', full: true, hint: 'Comma separated titles' }} value={t.releasesCovered.join(', ')} onChange={(v) => set('releasesCovered', String(v).split(',').map((s) => s.trim()).filter(Boolean))} />

      {error && <div className="lc-field-error">{error}</div>}
      {!disabled && (
        <div className="lc-form-actions">
          <Button variant="primary" icon="task_alt" label={confirmed ? 'Save changes' : 'Confirm terms'} loading={busy} onClick={confirm} />
        </div>
      )}
    </div>
  );
}

function ListEditor<T>({ title, rows, onChange, blank, render, empty }: { title: string; rows: T[]; onChange: (rows: T[]) => void; blank: T; render: (row: T, update: (next: T) => void) => React.ReactNode; empty: string }) {
  return (
    <div className="lc-stack" style={{ gap: 8 }}>
      <div className="lc-row" style={{ justifyContent: 'space-between' }}>
        <span className="lc-field-label">{title}</span>
        <Button size="xs" icon="add" label="Add" onClick={() => onChange([...rows, { ...blank }])} />
      </div>
      {rows.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>{empty}</span>}
      {rows.map((row, i) => (
        <div key={i} className="lc-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          {render(row, (next) => onChange(rows.map((r, j) => (j === i ? next : r))))}
          <button type="button" className="lc-icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}

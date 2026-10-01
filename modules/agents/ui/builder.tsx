'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, ApiError, Button, useToast } from '@labelconsole/ui/client';
import type { ApprovalPolicy } from '../schema';

type ToolInfo = { name: string; module: string; description: string; risk: string; requiresApproval: boolean };
type Option = { value: string; label: string };
export type BuilderValues = {
  name: string;
  goal: string;
  instructions: string;
  model: string;
  effort: string;
  role: string;
  toolAllowlist: string[];
  approvalPolicy: ApprovalPolicy;
  budget: { perRunUsd: number; perDayUsd: number };
  maxSteps: number;
  maxRuntimeSec: number;
  webResearch: boolean;
  status: string;
};

const RISKS: Array<{ key: keyof ApprovalPolicy['risk']; label: string }> = [
  { key: 'read', label: 'Read data' },
  { key: 'write', label: 'Change records' },
  { key: 'external', label: 'Contact people outside the label' },
  { key: 'destructive', label: 'Delete things' },
  { key: 'spend', label: 'Spend money' },
];

/** Edit an agent: goal, instructions, model, role, tools, approval policy, budget and limits. */
export function AgentBuilder({ agentId, initial, models, roles, tools, disabled }: { agentId: string; initial: BuilderValues; models: Option[]; roles: Option[]; tools: ToolInfo[]; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<BuilderValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BuilderValues>(k: K, val: BuilderValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const byModule = useMemo(() => {
    const m = new Map<string, ToolInfo[]>();
    for (const t of tools) m.set(t.module, [...(m.get(t.module) ?? []), t]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/agents/${agentId}`, { method: 'PATCH', body: v });
      toast('Agent saved');
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.details && 'fieldErrors' in e.details) {
        const fe = (e.details.fieldErrors ?? {}) as Record<string, string[]>;
        setError(Object.entries(fe).map(([k, msgs]) => `${k}: ${msgs[0]}`).join(' · ') || e.message);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lc-stack" style={{ gap: 22 }}>
      <div className="lc-form-grid">
        <label className="lc-field">
          <span className="lc-field-label">Name</span>
          <input className="lc-input" value={v.name} disabled={disabled} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Status</span>
          <select className="lc-select" value={v.status} disabled={disabled} onChange={(e) => set('status', e.target.value)}>
            <option value="active">Active</option>
            <option value="paused">Paused (no new runs)</option>
          </select>
        </label>
        <label className="lc-field" style={{ gridColumn: '1 / -1' }}>
          <span className="lc-field-label">Goal</span>
          <textarea className="lc-textarea" rows={2} value={v.goal} disabled={disabled} onChange={(e) => set('goal', e.target.value)} />
        </label>
        <label className="lc-field" style={{ gridColumn: '1 / -1' }}>
          <span className="lc-field-label">Instructions from the label</span>
          <textarea className="lc-textarea" rows={4} value={v.instructions} disabled={disabled} placeholder="House style, who to notify, what never to do…" onChange={(e) => set('instructions', e.target.value)} />
          <span className="lc-field-hint">Added to the agent type&apos;s own instructions.</span>
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Model</span>
          <select className="lc-select" value={v.model} disabled={disabled} onChange={(e) => set('model', e.target.value)}>
            {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Effort</span>
          <select className="lc-select" value={v.effort} disabled={disabled} onChange={(e) => set('effort', e.target.value)}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <span className="lc-field-hint">Higher effort reasons more and costs more.</span>
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Acts with the role</span>
          <select className="lc-select" value={v.role} disabled={disabled} onChange={(e) => set('role', e.target.value)}>
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <span className="lc-field-hint">Never more than its owner can do.</span>
        </label>
        <label className="lc-check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={v.webResearch} disabled={disabled} onChange={(e) => set('webResearch', e.target.checked)} />
          Allow web research (Claude web search)
        </label>
      </div>

      <div className="lc-stack" style={{ gap: 10 }}>
        <span className="lc-field-label">Approvals</span>
        <div className="lc-form-grid">
          {RISKS.map((r) => (
            <label key={r.key} className="lc-field">
              <span className="lc-field-hint" style={{ marginTop: 0 }}>{r.label}</span>
              <select className="lc-select" value={v.approvalPolicy.risk[r.key]} disabled={disabled} onChange={(e) => set('approvalPolicy', { ...v.approvalPolicy, risk: { ...v.approvalPolicy.risk, [r.key]: e.target.value as 'auto' } })}>
                <option value="auto">Do it</option>
                <option value="approve">Ask a person first</option>
                <option value="deny">Never</option>
              </select>
            </label>
          ))}
        </div>
        <span className="lc-field-hint">Tools marked “always asks” wait for a person whatever this says.</span>
      </div>

      <div className="lc-stack" style={{ gap: 10 }}>
        <span className="lc-field-label">Tools ({v.toolAllowlist.length})</span>
        {byModule.map(([mod, list]) => (
          <div key={mod} className="lc-stack" style={{ gap: 4 }}>
            <span className="lc-section-label">{mod}</span>
            {list.map((t) => (
              <label key={t.name} className="lc-check" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" disabled={disabled} checked={v.toolAllowlist.includes(t.name)} onChange={(e) => set('toolAllowlist', e.target.checked ? [...v.toolAllowlist, t.name] : v.toolAllowlist.filter((x) => x !== t.name))} />
                <span className="lc-cell-stack">
                  <span className="lc-mono" style={{ fontSize: 12 }}>
                    {t.name} <span className="lc-muted">· {t.risk}{t.requiresApproval ? ' · always asks' : ''}</span>
                  </span>
                  <span className="lc-cell-sub">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="lc-form-grid">
        <label className="lc-field">
          <span className="lc-field-label">Budget per run (USD)</span>
          <input className="lc-input" type="number" step="0.05" min={0.01} value={v.budget.perRunUsd} disabled={disabled} onChange={(e) => set('budget', { ...v.budget, perRunUsd: Number(e.target.value) })} />
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Budget per day (USD)</span>
          <input className="lc-input" type="number" step="0.5" min={0.01} value={v.budget.perDayUsd} disabled={disabled} onChange={(e) => set('budget', { ...v.budget, perDayUsd: Number(e.target.value) })} />
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Max steps per run</span>
          <input className="lc-input" type="number" min={1} max={200} value={v.maxSteps} disabled={disabled} onChange={(e) => set('maxSteps', Number(e.target.value))} />
        </label>
        <label className="lc-field">
          <span className="lc-field-label">Max active minutes per run</span>
          <input className="lc-input" type="number" min={1} max={360} value={Math.round(v.maxRuntimeSec / 60)} disabled={disabled} onChange={(e) => set('maxRuntimeSec', Number(e.target.value) * 60)} />
        </label>
      </div>
      {error && <div className="lc-field-error">{error}</div>}
      {!disabled && (
        <div className="lc-form-actions">
          <Button variant="primary" icon="save" label="Save agent" loading={busy} onClick={save} />
        </div>
      )}
    </div>
  );
}

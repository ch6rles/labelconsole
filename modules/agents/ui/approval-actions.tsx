'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, Button, Modal, useToast } from '@labelconsole/ui/client';

/** Approve, edit-then-approve, or reject an agent's pending action. */
export function ApprovalActions({ id, payload, compact }: { id: string; payload: unknown; compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null);
  const [json, setJson] = useState(() => JSON.stringify(payload, null, 2));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/agent-approvals/${id}/decide`, { body });
      toast(ok);
      setMode(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.details && 'formErrors' in e.details ? ((e.details.formErrors as string[])[0] ?? e.message) : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="lc-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <Button size={compact ? 'xs' : 'sm'} variant="primary" icon="check" label="Approve" loading={busy && mode === null} onClick={() => send({ decision: 'approve' }, 'Approved; the agent continues')} />
        <Button size={compact ? 'xs' : 'sm'} icon="edit" label="Edit & approve" onClick={() => setMode('edit')} />
        <Button size={compact ? 'xs' : 'sm'} variant="ghost" icon="close" label="Reject" onClick={() => setMode('reject')} />
      </span>
      <Modal open={mode === 'edit'} onClose={() => setMode(null)} title="Edit, then approve" description="Change what the agent will do. The edited action is checked against what the tool accepts before it runs." wide>
        <div className="lc-stack" style={{ gap: 12 }}>
          <textarea className="lc-textarea" rows={14} style={{ fontFamily: 'var(--lc-font-mono)', fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} />
          {error && <div className="lc-field-error">{error}</div>}
          <div className="lc-form-actions">
            <Button label="Cancel" onClick={() => setMode(null)} />
            <Button
              variant="primary"
              label="Approve edited action"
              loading={busy}
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(json);
                } catch {
                  setError('That is not valid JSON');
                  return;
                }
                void send({ decision: 'approve', editedPayload: parsed }, 'Approved with your edits');
              }}
            />
          </div>
        </div>
      </Modal>
      <Modal open={mode === 'reject'} onClose={() => setMode(null)} title="Reject this action" description="The agent is told it was rejected and why, and has to work around it.">
        <div className="lc-stack" style={{ gap: 12 }}>
          <textarea className="lc-textarea" rows={3} placeholder="Why (the agent reads this)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && <div className="lc-field-error">{error}</div>}
          <div className="lc-form-actions">
            <Button label="Cancel" onClick={() => setMode(null)} />
            <Button variant="danger" label="Reject" loading={busy} onClick={() => send({ decision: 'reject', reason: reason || undefined }, 'Rejected')} />
          </div>
        </div>
      </Modal>
    </>
  );
}

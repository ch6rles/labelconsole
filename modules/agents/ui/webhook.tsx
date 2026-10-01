'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, Button, CopyButton, Modal, useToast } from '@labelconsole/ui/client';

/** Create a webhook trigger and show its URL once: only a hash of the token is stored. */
export function AddWebhook({ agentId, appUrl }: { agentId: string; appUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ token: string }>(`/agents/${agentId}/triggers`, { body: { kind: 'webhook', task: task || undefined } });
      setUrl(`${appUrl}/api/webhooks/agents/${res.token}`);
      router.refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" icon="webhook" label="Webhook" onClick={() => setOpen(true)} />
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setUrl(null);
          setTask('');
        }}
        title="Webhook trigger"
        description="POST JSON to this URL to start a run; the body is handed to the agent. Anyone with the URL can trigger it, so keep it secret."
      >
        {url ? (
          <div className="lc-stack" style={{ gap: 12 }}>
            <code className="lc-mono" style={{ fontSize: 12, wordBreak: 'break-all', padding: 10, border: '1px solid var(--lc-border)', background: 'var(--lc-bg-sidebar)' }}>{url}</code>
            <span className="lc-field-hint">This is the only time the URL is shown. Delete the trigger and create a new one to rotate it.</span>
            <CopyButton text={url} label="Copy URL" variant="primary" />
          </div>
        ) : (
          <div className="lc-stack" style={{ gap: 12 }}>
            <label className="lc-field">
              <span className="lc-field-label">Task for the agent (optional)</span>
              <textarea className="lc-textarea" rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. A new playlist submission arrived. Score it and tell A&R." />
            </label>
            <div className="lc-form-actions">
              <Button variant="primary" label="Create webhook" loading={busy} onClick={create} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

'use client';

import { useState } from 'react';
import { api, Button, CopyButton, useToast } from '@labelconsole/ui/client';

/** Get a one-time code and show it with the exact command to type in Discord. */
export function LinkCodeButton({ relink }: { relink?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; command: string; expiresAt: string } | null>(null);
  const get = async () => {
    setBusy(true);
    try {
      setCode(await api<{ code: string; command: string; expiresAt: string }>('/discord/link-code', { method: 'POST', body: {} }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!code) return <Button label={relink ? 'Link a different account' : 'Get a link code'} icon="link" variant={relink ? undefined : 'primary'} size="sm" onClick={get} loading={busy} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <span className="lc-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <code className="lc-mono" style={{ fontSize: 15, fontWeight: 600, padding: '4px 8px', border: '1px solid var(--lc-border)', borderRadius: 6 }}>
          {code.command}
        </code>
        <CopyButton text={code.command} size="sm" label="Copy command" />
      </span>
      <span className="lc-muted" style={{ fontSize: 12 }}>
        Type this in any Discord chat where the app is available. It works once and expires at {new Date(code.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
      </span>
    </div>
  );
}

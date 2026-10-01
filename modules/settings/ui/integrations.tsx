import type { PageProps } from '@labelconsole/core/web';
import { Chip, Icon, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import { INTEGRATIONS } from '../integrations';
import * as svc from '../service';

export default async function IntegrationsPage({ run, session }: PageProps) {
  const creds = await run((ctx) => svc.credentialsStatus(ctx));
  const canEdit = session.permissions.has('settings:credentials');
  const connected = INTEGRATIONS.filter((i) => creds.some((c) => c.provider === i.provider)).length;
  return (
    <Page variant="narrow">
      <PageHeader title="Integrations" description="Keys and tokens are encrypted with a per-label key, decrypted only inside the worker that calls the API, and never shown again or sent to an agent." />
      <Summary>
        {connected} of {INTEGRATIONS.length} connected
      </Summary>
      <section className="lc-card">
        {INTEGRATIONS.map((i) => {
          const cred = creds.find((c) => c.provider === i.provider);
          return (
            <div key={i.provider} className="lc-setting-row" style={{ alignItems: 'flex-start' }}>
              <span className="lc-setting-icon">
                <Icon name={i.icon} />
              </span>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <span className="lc-row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{i.name}</span>
                  {cred ? <Chip tone="blue">Connected</Chip> : <Chip>Not connected</Chip>}
                </span>
                <span style={{ fontSize: 13, color: 'var(--lc-text-3)', lineHeight: 1.5 }}>{i.description}</span>
                <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>
                  USED BY {i.usedBy.join(' · ').toUpperCase()}
                  {cred && ` · ADDED ${fmt.shortDate(cred.createdAt).toUpperCase()}${cred.lastUsedAt ? ` · LAST USED ${fmt.relative(cred.lastUsedAt).toUpperCase()}` : ''}`}
                </span>
                {cred && Object.keys(cred.metadata).length > 0 && (
                  <span className="lc-muted" style={{ fontSize: 12 }}>
                    {Object.entries(cred.metadata)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </span>
                )}
              </div>
              {canEdit && (
                <div className="lc-row" style={{ gap: 6 }}>
                  <FormModal
                    title={`${cred ? 'Replace' : 'Connect'} ${i.name}`}
                    description={i.docs ? `Get credentials at ${i.docs}` : undefined}
                    trigger={{ label: cred ? 'Replace' : 'Connect', size: 'sm', variant: cred ? undefined : 'primary' }}
                    endpoint="/settings/credentials"
                    extra={{ provider: i.provider }}
                    columns={1}
                    success={`${i.name} connected`}
                    fields={i.fields.map((f) => ({ name: f.name, label: f.label, type: f.secret ? 'password' : 'text', required: !f.optional, hint: f.hint, full: true }))}
                  />
                  {cred && <ActionButton endpoint={`/settings/credentials/${cred.id}`} method="DELETE" confirm={`Disconnect ${i.name}? Features that use it stop until you reconnect.`} label="Disconnect" size="sm" variant="ghost" success="Disconnected" />}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </Page>
  );
}

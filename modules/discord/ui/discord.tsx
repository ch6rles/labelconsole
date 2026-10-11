import type { ReactNode } from 'react';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, Chip, Icon, LinkButton, Page, PageHeader, fmt } from '@labelconsole/ui';
import { ActionButton, CopyButton } from '@labelconsole/ui/client';
import * as svc from '../service';
import { LinkCodeButton } from './client';

export default async function DiscordPage({ run, session }: PageProps) {
  const canUse = session.permissions.has(svc.USE_PERMISSION);
  const isAdmin = session.permissions.has('settings:read');
  const [link, status, links] = await Promise.all([
    run((ctx) => svc.myLink(ctx)),
    run((ctx) => svc.discordStatus(ctx)),
    isAdmin ? run((ctx) => svc.listLinks(ctx)) : Promise.resolve([]),
  ]);
  const canManage = session.permissions.has('settings:manage');
  const canRemoveOthers = session.permissions.has('settings:members');
  const https = status.interactionsUrl.startsWith('https://');

  return (
    <Page variant="narrow">
      <PageHeader
        title="Discord"
        description={`Look up songs and releases from Discord with /song, or "Look Up Song" on a message. Only members of ${session.org.name} who link their account get answers, and the replies are visible only to them.`}
      />

      {!status.ready && (
        <Banner icon="info" warn>
          {status.connected ? `The Discord app needs attention: ${status.problems.join(' ')}` : 'The Discord app is not set up yet. An admin connects it under Settings → Integrations → Discord, then follows the steps below.'}
        </Banner>
      )}

      <section className="lc-card">
        <div className="lc-card-head">
          <div className="lc-card-head-text">
            <span className="lc-card-title">Your Discord account</span>
            <span className="lc-card-sub">Linking lets your Discord account look things up as you, with your role in Label Console.</span>
          </div>
        </div>
        <div className="lc-setting-row" style={{ alignItems: 'flex-start' }}>
          <span className="lc-setting-icon">
            <Icon name={link ? 'link' : 'link_off'} />
          </span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            {link ? (
              <>
                <span className="lc-row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{link.discordUsername}</span>
                  <Chip tone="blue">Linked</Chip>
                </span>
                <span className="lc-muted" style={{ fontSize: 12 }}>
                  Linked {fmt.shortDate(link.createdAt)}
                  {link.lastUsedAt ? ` · last used ${fmt.relative(link.lastUsedAt)}` : ' · not used yet'}
                </span>
              </>
            ) : canUse ? (
              <span style={{ fontSize: 13, color: 'var(--lc-text-3)', lineHeight: 1.5 }}>Get a code here, then run the /link command in Discord within ten minutes.</span>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--lc-text-3)', lineHeight: 1.5 }}>Your role doesn&apos;t include the catalogue, so the Discord app has nothing to show you. Ask an admin if you need it.</span>
            )}
            {canUse && status.ready && <LinkCodeButton relink={Boolean(link)} />}
          </div>
          {link && <ActionButton endpoint={`/discord/links/${link.id}`} method="DELETE" confirm="Unlink your Discord account? /song stops answering you until you link again." label="Unlink" size="sm" variant="ghost" success="Unlinked" />}
        </div>
      </section>

      {isAdmin && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Set up the app</span>
              <span className="lc-card-sub">Once, by an admin. The app answers only members who have linked their account, wherever it is installed.</span>
            </div>
          </div>
          <Step n={1} done={status.connected && status.ready} title="Create the Discord application and connect it">
            In the{' '}
            <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
              Discord Developer Portal
            </a>
            , create an application. Copy the Application ID and Public Key from General Information, and a token from Bot → Reset Token. Add all three under Settings → Integrations → Discord.
            {status.applicationId && <span className="lc-mono lc-muted"> Application {status.applicationId}.</span>}
          </Step>
          <Step n={2} title="Point Discord at Label Console">
            Paste this into General Information → Interactions Endpoint URL and save. Discord checks it straight away, so do this after step 1.
            <span className="lc-row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <code className="lc-mono" style={{ fontSize: 12 }}>
                {status.interactionsUrl}
              </code>
              <CopyButton text={status.interactionsUrl} size="sm" />
            </span>
            {!https && <span style={{ color: 'var(--lc-danger)' }}> Discord only accepts an https address: set APP_URL to the console&apos;s public https address.</span>}
          </Step>
          <Step n={3} title="Allow installs">
            On the Installation page, tick User Install (use it in any server or DM) and, if you like, Guild Install (add it to the label&apos;s server), each with the applications.commands scope.
            {status.userInstallUrl && (
              <span className="lc-row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <LinkButton href={status.userInstallUrl} external size="sm" icon="person_add">
                  Install to my account
                </LinkButton>
                {status.serverInstallUrl && (
                  <LinkButton href={status.serverInstallUrl} external size="sm" variant="ghost" icon="group_add">
                    Add to a server
                  </LinkButton>
                )}
              </span>
            )}
          </Step>
          <Step n={4} done={Boolean(status.commandsRegisteredAt)} title="Register the commands">
            Adds /song, /link, /unlink and Look Up Song to the app. Run it again after changing the bot token.
            {status.commandsRegisteredAt && <span className="lc-muted"> Last registered {fmt.relative(status.commandsRegisteredAt)}.</span>}
            {status.commandsError && <span style={{ color: 'var(--lc-danger)' }}> Last attempt failed: {status.commandsError}</span>}
            {canManage && status.ready && (
              <span className="lc-row" style={{ marginTop: 6 }}>
                <ActionButton endpoint="/discord/commands" label={status.commandsRegisteredAt ? 'Register again' : 'Register commands'} size="sm" success="Registering the commands. Refresh in a few seconds." />
              </span>
            )}
          </Step>
        </section>
      )}

      {isAdmin && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Linked members</span>
              <span className="lc-card-sub">Removing someone from the label stops their Discord link working at once.</span>
            </div>
          </div>
          {links.length === 0 && <div className="lc-card-body lc-muted">Nobody has linked a Discord account yet.</div>}
          {links.map((l) => (
            <div key={l.id} className="lc-setting-row">
              <span className="lc-setting-icon">
                <Icon name="person" />
              </span>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{l.userName ?? 'Former member'}</span>
                <span className="lc-muted" style={{ fontSize: 12 }}>
                  {l.discordUsername} · linked {fmt.shortDate(l.createdAt)}
                  {l.lastUsedAt ? ` · last used ${fmt.relative(l.lastUsedAt)}` : ''}
                </span>
              </div>
              {(canRemoveOthers || l.userId === session.user.id) && <ActionButton endpoint={`/discord/links/${l.id}`} method="DELETE" confirm={`Remove ${l.userName ?? 'this'} Discord link?`} label="Remove" size="sm" variant="ghost" success="Removed" />}
            </div>
          ))}
        </section>
      )}
    </Page>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div className="lc-setting-row" style={{ alignItems: 'flex-start' }}>
      <span className="lc-setting-icon">{done ? <Icon name="check_circle" /> : <span className="lc-mono">{n}</span>}</span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 13, color: 'var(--lc-text-3)', lineHeight: 1.5 }}>{children}</span>
      </div>
    </div>
  );
}

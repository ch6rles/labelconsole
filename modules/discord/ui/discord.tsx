import type { ReactNode } from 'react';
import type { PageProps } from '@labelconsole/core/web';
import { spotScraperConfigured } from '@labelconsole/core/spotscraper';
import { Banner, Chip, Icon, LinkButton, Page, PageHeader, fmt } from '@labelconsole/ui';
import { ActionButton, ApiToggle, CopyButton } from '@labelconsole/ui/client';
import { CORRECTABLE_FIELDS } from '../protocol/commands';
import * as svc from '../service';
import { LinkCodeButton } from './client';
import { BenchmarkCard, ReadingsCard, SourcesCard } from './sources';

export default async function DiscordPage({ run, session }: PageProps) {
  const canUse = session.permissions.has(svc.USE_PERMISSION);
  const isAdmin = session.permissions.has('settings:read');
  const [link, status, links, sharing, pending, reviewed, stats, benchmarks, spotScraper] = await Promise.all([
    run((ctx) => svc.myLink(ctx)),
    run((ctx) => svc.discordStatus(ctx)),
    isAdmin ? run((ctx) => svc.listLinks(ctx)) : Promise.resolve([]),
    run((ctx) => svc.discordSettings(ctx)),
    canUse ? run((ctx) => svc.listCorrections(ctx, 'pending')) : Promise.resolve([]),
    canUse ? run((ctx) => svc.listCorrections(ctx, 'reviewed')) : Promise.resolve([]),
    isAdmin ? run((ctx) => svc.lookupStats(ctx)) : Promise.resolve(null),
    isAdmin ? run((ctx) => svc.listBenchmarks(ctx)) : Promise.resolve([]),
    isAdmin ? run((ctx) => spotScraperConfigured(ctx)) : Promise.resolve(false),
  ]);
  const canReview = session.permissions.has('catalogue:write');
  const fieldName = (f: string) => CORRECTABLE_FIELDS.find((x) => x.value === f)?.name ?? f;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
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
            Adds /song, /release, /artist, /label, /licensor, /compare, /correct, /link, /unlink and Look Up Song to the app. Run it again after changing the bot token or the install types.
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

      {canUse && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Corrections from Discord</span>
              <span className="lc-card-sub">Suggested with /correct or Report / Correct. Approved values show on cards as reviewed; the sources&apos; values stay listed beside them.</span>
            </div>
          </div>
          {pending.length === 0 && <div className="lc-card-body lc-muted">Nothing waiting for review.</div>}
          {pending.map(({ row, submittedByName }) => (
            <div key={row.id} className="lc-setting-row" style={{ alignItems: 'flex-start' }}>
              <span className="lc-setting-icon">
                <Icon name="edit_note" />
              </span>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {fieldName(row.field)} of “{row.subject}”
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {row.currentValue ? (
                    <>
                      <span className="lc-muted">{row.currentValue}</span> → <strong>{row.proposedValue}</strong>
                    </>
                  ) : (
                    <strong>{row.proposedValue}</strong>
                  )}
                </span>
                {row.note && <span className="lc-muted" style={{ fontSize: 12 }}>Evidence: {row.note}</span>}
                <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>
                  {row.ref.toUpperCase()} · {submittedByName ?? 'Former member'} · {fmt.relative(row.createdAt)}
                </span>
              </div>
              {canReview && (
                <div className="lc-row" style={{ gap: 6 }}>
                  <ActionButton endpoint={`/discord/corrections/${row.id}/review`} body={{ decision: 'approved' }} label="Approve" size="sm" variant="primary" success="Approved" />
                  <ActionButton endpoint={`/discord/corrections/${row.id}/review`} body={{ decision: 'rejected' }} label="Reject" size="sm" variant="ghost" success="Rejected" />
                </div>
              )}
            </div>
          ))}
          {reviewed.length > 0 && (
            <div className="lc-card-body lc-muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
              Recently reviewed:{' '}
              {reviewed
                .slice(0, 8)
                .map(({ row, reviewedByName }) => `${fieldName(row.field)} of “${row.subject}” ${row.status}${reviewedByName ? ` by ${reviewedByName}` : ''}`)
                .join(' · ')}
            </div>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Sharing</span>
              <span className="lc-card-sub">Cards are private to whoever asks. With share:true a member can post one for everyone in the channel, including people outside the label; buttons on it still answer only linked members, privately.</span>
            </div>
          </div>
          {(
            [
              ['allowSharing', 'Allow posting cards for everyone', 'Off: share:true is ignored and every card stays private.'],
              ['shareDistributor', 'Show the distributor on shared cards', 'The small card with the distributor (verified or inferred).'],
              ['shareStreams', 'Show stream counts on shared cards', 'Spotify’s public play count from the lookup, or your own latest reading.'],
            ] as const
          ).map(([field, title, sub]) => (
            <div key={field} className="lc-setting-row">
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{title}</span>
                <span style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{sub}</span>
              </div>
              <ApiToggle endpoint="/discord/settings" field={field} on={sharing[field]} disabled={!canManage || (field !== 'allowSharing' && !sharing.allowSharing)} title={title} />
            </div>
          ))}
        </section>
      )}

      {isAdmin && stats && (
        <section className="lc-card">
          <div className="lc-card-head">
            <div className="lc-card-head-text">
              <span className="lc-card-title">Last {stats.days} days</span>
              <span className="lc-card-sub">How lookups went, for checking the app before and after launch.</span>
            </div>
          </div>
          <div className="lc-card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, fontSize: 13 }}>
            {[
              ['Commands', String(stats.total)],
              ['Answered with a card', pct(stats.cards, stats.total)],
              ['Asked “Which one?”', pct(stats.pickers, stats.total)],
              ['Nothing found', pct(stats.notFound, stats.total)],
              ['Errors', pct(stats.errors, stats.total)],
              ['ISRC/UPC lookups resolved', pct(stats.codesFound, stats.codes)],
              ['From the cache', pct(stats.cached, stats.total)],
              ['Median time', stats.p50 == null ? '—' : `${(stats.p50 / 1000).toFixed(1)} s`],
              ['95th percentile', stats.p95 == null ? '—' : `${(stats.p95 / 1000).toFixed(1)} s`],
              ['Missing a source', pct(stats.partial, stats.fresh)],
              ['Corrections suggested', `${stats.corrections?.recent ?? 0} (${pct(stats.corrections?.recent ?? 0, stats.cards)} of cards)`],
              ['Corrections waiting', String(stats.corrections?.pending ?? 0)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="lc-muted" style={{ fontSize: 12 }}>
                  {k}
                </span>
                <span style={{ fontSize: 18, fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
          {stats.coverage.length > 0 && <CoverageTable coverage={stats.coverage} />}
        </section>
      )}

      {isAdmin && stats && <SourcesCard sources={stats.sources} paused={stats.paused} days={stats.days} canManage={canManage} />}
      {isAdmin && <BenchmarkCard runs={benchmarks} canManage={canManage} />}
      {isAdmin && <ReadingsCard settings={sharing} canManage={canManage} spotScraperConnected={spotScraper} />}

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
      <p className="lc-muted" style={{ fontSize: 11, lineHeight: 1.6, margin: '4px 2px' }}>
        Card data comes from MusicBrainz, Deezer, iTunes, and Spotify, Discogs and Apple when connected. This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC. Catalogue metadata is not proof of who owns or licenses a recording.
      </p>
    </Page>
  );
}

const COVERAGE_FIELDS: Array<[string, string]> = [
  ['isrc', 'ISRC'],
  ['upc', 'UPC'],
  ['labelName', 'Label'],
  ['pLine', '℗ line'],
  ['cLine', '© line'],
  ['distributor', 'Distributor'],
  ['credits', 'Own credits'],
  ['streams', 'Streams'],
];
const STATUSES: Array<[string, string]> = [
  ['verified', 'Verified'],
  ['reported', 'Source-reported'],
  ['conflicting', 'Conflicting'],
  ['inferred', 'Inferred'],
  ['unknown', 'Unknown'],
];

/** How each field was known on the cards shown: the plan's verified / source-reported / conflicting / inferred / unknown split. */
function CoverageTable({ coverage }: { coverage: Array<{ field: string; status: string; n: number }> }) {
  const cell = { padding: '6px 8px', borderBottom: '1px solid var(--lc-border)', textAlign: 'left' as const, whiteSpace: 'nowrap' as const };
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  return (
    <div className="lc-card-body" style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr className="lc-muted">
            <th style={{ ...cell, fontWeight: 500 }}>Field on cards</th>
            {STATUSES.map(([, label]) => (
              <th key={label} style={{ ...cell, fontWeight: 500 }}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COVERAGE_FIELDS.map(([field, name]) => {
            const rows = coverage.filter((c) => c.field === field);
            const total = rows.reduce((n, c) => n + Number(c.n), 0);
            if (!total) return null;
            return (
              <tr key={field}>
                <td style={cell}>{name}</td>
                {STATUSES.map(([status]) => (
                  <td key={status} style={cell}>
                    {pct(rows.filter((c) => c.status === status).reduce((n, c) => n + Number(c.n), 0), total)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

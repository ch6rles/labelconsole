import { Chip, fmt } from '@labelconsole/ui';
import { ActionButton, AutoSaveFields, EntityForm, PollUntilDone } from '@labelconsole/ui/client';
import type { BenchmarkCounts, BenchmarkResult } from '../schema';
import type { DiscordSettings, SourceHealth } from '../service';

const SOURCE_NAMES: Record<string, string> = { spotify: 'Spotify', spotscraper: 'Spotify (SpotScraper)', apple: 'Apple Music', itunes: 'iTunes', deezer: 'Deezer', musicbrainz: 'MusicBrainz', discogs: 'Discogs', licensed: 'Licensed provider', tags: 'File tags' };
const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;
const FIELD_NAMES: Record<string, string> = { title: 'Title', artists: 'Artist', durationMs: 'Duration', upc: 'UPC', releaseDate: 'Release date', labelName: 'Label', pLine: '℗ line', cLine: '© line' };
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const secs = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const cell = { padding: '6px 8px', borderBottom: '1px solid var(--lc-border)', textAlign: 'left' as const, whiteSpace: 'nowrap' as const };

/** Per-source health from the lookup log, and the sources paused right now. */
export function SourcesCard({ sources, paused, days, canManage }: { sources: SourceHealth[]; paused: Array<{ source: string; secondsLeft: number; own: boolean }>; days: number; canManage: boolean }) {
  return (
    <section className="lc-card">
      <div className="lc-card-head">
        <div className="lc-card-head-text">
          <span className="lc-card-title">Sources, last {days} days</span>
          <span className="lc-card-sub">How each music database answered fresh lookups (cached ones don&apos;t ask them). A source that keeps failing is paused for two minutes and cards answer from the others.</span>
        </div>
      </div>
      {paused.length > 0 && (
        <div className="lc-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {paused.map((p) => (
            <span key={p.source} className="lc-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Chip tone="red">Paused</Chip>
              <span style={{ fontSize: 13 }}>
                {sourceName(p.source)}: repeated errors{p.own ? ' with your key' : ''}; tried again in {p.secondsLeft}s.
              </span>
              {canManage && <ActionButton endpoint={`/discord/sources/${p.source}/resume`} label="Try now" size="sm" variant="ghost" success="Resumed" />}
            </span>
          ))}
        </div>
      )}
      {sources.length === 0 ? (
        <div className="lc-card-body lc-muted">No fresh lookups yet.</div>
      ) : (
        <div className="lc-card-body" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
            <thead>
              <tr className="lc-muted">
                {['Source', 'Calls', 'Answered', 'No match', 'Errors', 'Timed out', 'Refused (429)', 'Busy, skipped', 'Paused', 'Median', '95th'].map((h) => (
                  <th key={h} style={{ ...cell, fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const o = (k: string) => s.outcomes[k] ?? 0;
                return (
                  <tr key={s.source}>
                    <td style={cell}>{sourceName(s.source)}</td>
                    <td style={cell}>{s.calls}</td>
                    <td style={cell}>{pct(o('answered'), s.calls)}</td>
                    <td style={cell}>{pct(o('no_match'), s.calls)}</td>
                    <td style={{ ...cell, color: o('error') ? 'var(--lc-danger)' : undefined }}>{o('error')}</td>
                    <td style={{ ...cell, color: o('timeout') ? 'var(--lc-danger)' : undefined }}>{o('timeout')}</td>
                    <td style={cell}>{o('rate_limited')}</td>
                    <td style={cell}>{o('busy')}</td>
                    <td style={cell}>{o('paused')}</td>
                    <td style={cell}>{secs(s.p50)}</td>
                    <td style={cell}>{secs(s.p95)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <span className="lc-muted" style={{ fontSize: 11 }}>
            Sources that aren&apos;t connected, or had nothing to look up by, aren&apos;t counted as calls. &ldquo;Busy, skipped&rdquo;: the source&apos;s rate limit (MusicBrainz: one request a second for everyone) was in use, so the card answered without it rather than wait.
          </span>
        </div>
      )}
    </section>
  );
}

type BenchmarkRow = { id: string; status: string; sample: number; includeBilled: boolean; progress: number; results: BenchmarkResult | null; error: string | null; createdAt: Date; finishedAt: Date | null };

const agree = (c: BenchmarkCounts | undefined) => (!c || !c.reported ? '—' : c.checked ? `${pct(c.agreed, c.checked)} of ${c.checked}` : `${c.reported} unchecked`);

/** Run a benchmark against the label's own catalogue, and show the latest score. */
/** Members limited to some artists get no per-song list (the service leaves it out). */
export function BenchmarkCard({ runs, canManage }: { runs: BenchmarkRow[]; canManage: boolean }) {
  const latest = runs[0];
  const busy = latest && (latest.status === 'queued' || latest.status === 'running');
  const done = runs.find((r) => r.status === 'done' && r.results);
  const r = done?.results;
  return (
    <section className="lc-card">
      <div className="lc-card-head">
        <div className="lc-card-head-text">
          <span className="lc-card-title">Source benchmark</span>
          <span className="lc-card-sub">Looks up a random sample of your own songs by ISRC through every source, and checks each source&apos;s answer against your catalogue, the one place the right answer is known. Use it before relying on a source, and after connecting a new one.</span>
        </div>
      </div>
      {busy && (
        <div className="lc-card-body" style={{ fontSize: 13 }}>
          Running: {latest.progress} of {latest.sample} songs looked up. MusicBrainz allows one request a second, so this takes a few minutes.
          <PollUntilDone endpoint={`/discord/benchmarks/${latest.id}`} done={['done', 'failed']} intervalMs={4000} />
        </div>
      )}
      {latest?.status === 'failed' && <div className="lc-card-body" style={{ fontSize: 13, color: 'var(--lc-danger)' }}>The last benchmark failed: {latest.error}</div>}
      {canManage && !busy && (
        <div className="lc-card-body">
          <EntityForm
            endpoint="/discord/benchmarks"
            submitLabel="Run benchmark"
            success="Benchmark started"
            columns={2}
            initial={{ sample: '20', includeBilled: false }}
            fields={[
              {
                name: 'sample',
                label: 'Songs',
                type: 'select',
                options: [
                  { value: '10', label: '10 songs' },
                  { value: '20', label: '20 songs' },
                  { value: '50', label: '50 songs' },
                ],
              },
              { name: 'includeBilled', label: 'Include SpotScraper (billed: about two requests a song)', type: 'checkbox' },
            ]}
          />
        </div>
      )}
      {r && done && (
        <>
          <div className="lc-card-body lc-muted" style={{ fontSize: 12 }}>
            {r.items} songs, {fmt.relative(done.finishedAt ?? done.createdAt)}
            {done.includeBilled ? ` · ${r.billed.spotscraper} SpotScraper requests` : ' · SpotScraper not included'}. Each cell: how often the source agreed with your catalogue, of the songs where both had a value.
          </div>
          <div className="lc-card-body" style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr className="lc-muted">
                  <th style={{ ...cell, fontWeight: 500 }}>Source</th>
                  <th style={{ ...cell, fontWeight: 500 }}>Answered</th>
                  {Object.keys(FIELD_NAMES).map((f) => (
                    <th key={f} style={{ ...cell, fontWeight: 500 }}>
                      {FIELD_NAMES[f]}
                    </th>
                  ))}
                  <th style={{ ...cell, fontWeight: 500 }}>Median</th>
                </tr>
              </thead>
              <tbody>
                {r.sources.map((s) => {
                  const calls = Object.entries(s.outcomes)
                    .filter(([k]) => !['skipped', 'paused', 'busy'].includes(k))
                    .reduce((n, [, v]) => n + v, 0);
                  return (
                    <tr key={s.source}>
                      <td style={cell}>{sourceName(s.source)}</td>
                      <td style={cell}>{calls ? pct(s.outcomes.answered ?? 0, calls) : (s.outcomes.skipped ?? 0) ? 'not used' : '—'}</td>
                      {Object.keys(FIELD_NAMES).map((f) => (
                        <td key={f} style={cell}>
                          {agree(s.fields[f])}
                        </td>
                      ))}
                      <td style={cell}>{secs(s.p50)}</td>
                    </tr>
                  );
                })}
                <tr style={{ fontWeight: 600 }}>
                  <td style={cell}>Card (merged)</td>
                  <td style={cell} />
                  {Object.keys(FIELD_NAMES).map((f) => (
                    <td key={f} style={cell}>
                      {agree(r.merged[f])}
                    </td>
                  ))}
                  <td style={cell} />
                </tr>
              </tbody>
            </table>
          </div>
          <div className="lc-card-body" style={{ fontSize: 13 }}>
            Inferred distributor:{' '}
            {r.distributor.checked
              ? `right for ${pct(r.distributor.agreed, r.distributor.checked)} of ${r.distributor.checked} releases whose distributor you confirmed; unknown for ${r.distributor.unknown}.`
              : 'no release in the sample has a distributor confirmed in your catalogue.'}{' '}
            <span className="lc-muted">An inference is never shown as verified on a card.</span>
          </div>
          {r.misses.length > 0 && (
            <details className="lc-card-body" style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer' }}>Where a source disagreed ({r.misses.length})</summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                {r.misses.map((m, i) => (
                  <li key={i}>
                    “{m.title}” ({m.isrc}) · {FIELD_NAMES[m.field] ?? m.field} · {sourceName(m.source)} says “{m.theirs}”, your catalogue says “{m.ours}”
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** Daily play-count readings for songs looked up in Discord (off by default: each one is billed). */
export function ReadingsCard({ settings, canManage, spotScraperConnected }: { settings: DiscordSettings; canManage: boolean; spotScraperConnected: boolean }) {
  return (
    <section className="lc-card">
      <div className="lc-card-head">
        <div className="lc-card-head-text">
          <span className="lc-card-title">Daily readings</span>
          <span className="lc-card-sub">
            Songs outside your catalogue only get a chart point when someone looks them up. With daily readings, Label Console also reads the Spotify play count once a day for the songs looked up most recently (in the last 30 days), so their chart fills in. Each song is one SpotScraper request a day, billed to your account; songs in your catalogue are left out, because Streams tracks them already.
          </span>
        </div>
      </div>
      <div className="lc-card-body">
        {!spotScraperConnected ? (
          <span className="lc-muted" style={{ fontSize: 13 }}>
            Needs SpotScraper (Settings → Integrations).
          </span>
        ) : canManage ? (
          <AutoSaveFields endpoint="/discord/settings" initial={{ dailyReadings: settings.dailyReadings }} fields={[{ name: 'dailyReadings', label: 'Songs a day (0 = off)', type: 'number', min: 0, max: 200, step: '1', hint: `At ${settings.dailyReadings || 'N'} songs: about ${settings.dailyReadings ? settings.dailyReadings * 30 : '30 × N'} requests a month.` }]} />
        ) : (
          <span style={{ fontSize: 13 }}>{settings.dailyReadings ? `${settings.dailyReadings} songs a day.` : 'Off.'}</span>
        )}
      </div>
    </section>
  );
}

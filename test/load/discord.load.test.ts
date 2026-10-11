/**
 * Load test for the Discord app: many linked members across labels sending
 * signed /song commands at once, through the real endpoint, queue and worker
 * (BullMQ, Postgres, Redis). Discord and the music databases are stubs with
 * realistic latency; MusicBrainz keeps its real one-request-a-second limit.
 *
 *   pnpm test:load
 *   LOAD_DISCORD_ORGS=10 LOAD_DISCORD_MEMBERS=8 pnpm test:load
 *
 * It checks that the endpoint always answers inside Discord's 3 seconds, that
 * every deferred reply is edited exactly once, and that a slow or rate-limited
 * source never stops cards from being answered. A summary is written to
 * test-results/load-discord.json.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import '../modules';
import { allModules } from '../modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis, redis } from '@labelconsole/core/redis';
import { startWorker, type WorkerRuntime } from '@labelconsole/core/worker';
import { saveCredential } from '@labelconsole/settings/service';
import { handleInteraction } from '@labelconsole/discord/interactions';
import { discordLookups } from '@labelconsole/discord/schema';
import * as discord from '@labelconsole/discord/service';
import { addMember, makeOrg } from '../helpers';

const ORGS = Number(process.env.LOAD_DISCORD_ORGS ?? 6);
const MEMBERS = Number(process.env.LOAD_DISCORD_MEMBERS ?? 5);
/** Per member, under the per-person burst limit, so every command is queued. */
const LOOKUPS = Math.min(8, Number(process.env.LOAD_DISCORD_LOOKUPS ?? 6));
/** Distinct songs: lookups of the same song in a label share the hour's cache. */
const SONGS = Number(process.env.LOAD_DISCORD_SONGS ?? 12);
const API_LATENCY_MS: [number, number] = [40, 220];
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 240_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(API_LATENCY_MS[0] + Math.random() * (API_LATENCY_MS[1] - API_LATENCY_MS[0]));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : 0;
};
const isrc = (n: number) => `GBLOD26${String(n).padStart(5, '0')}`;

/** Every reply edit Discord would receive, by interaction token. */
const edits = new Map<string, number>();
const editedAt = new Map<string, number>();

function stubApis() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      await jitter();
      const edit = /\/webhooks\/\d+\/([^/]+)\/messages\/@original$/.exec(u);
      if (edit && init?.method === 'PATCH') {
        edits.set(edit[1], (edits.get(edit[1]) ?? 0) + 1);
        editedAt.set(edit[1], Date.now());
        return json({ id: 'message' });
      }
      const m = /api\.deezer\.com\/track\/isrc:(GBLOD26\d{5})/.exec(u);
      if (m) return json({ id: Number(m[1].slice(-5)) + 1000, title: `Load Song ${m[1].slice(-5)}`, isrc: m[1], duration: 200, link: `https://www.deezer.com/track/${Number(m[1].slice(-5)) + 1000}`, artist: { name: 'Load Artist' }, album: { id: 77, title: 'Load Album' } });
      if (u.startsWith('https://api.deezer.com/album/77')) return json({ id: 77, title: 'Load Album', upc: '724384960650', artist: { name: 'Load Artist' }, label: 'Load Records', release_date: '2026-01-01', record_type: 'album', tracks: { data: [] } });
      if (u.startsWith('https://api.deezer.com')) return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
      if (u.startsWith('https://musicbrainz.org')) return json({ recordings: [], releases: [] });
      if (u.startsWith('https://itunes.apple.com')) return json({ resultCount: 0, results: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
}

let worker: WorkerRuntime | undefined;
afterAll(async () => {
  vi.unstubAllGlobals();
  await worker?.stop();
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('discord load', () => {
  it(`answers ${ORGS * MEMBERS * LOOKUPS} /song commands from ${ORGS * MEMBERS} members across ${ORGS} labels`, async () => {
    stubApis();
    const breakers = await redis().keys('lc:cb:*');
    if (breakers.length) await redis().del(...breakers);

    // Labels, each with its Discord app connected and linked members.
    type Member = { orgId: string; appId: string; discordId: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] };
    const members: Member[] = [];
    const orgIds: string[] = [];
    for (let i = 0; i < ORGS; i++) {
      const o = await makeOrg(`Discord Load ${i}`);
      orgIds.push(o.org.id);
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
      const appId = `1${String(Date.now()).slice(-9)}${String(i).padStart(8, '0')}`;
      await o.as((ctx) => saveCredential(ctx, { provider: 'discord', applicationId: appId, publicKey: hex, botToken: 'bot-token-for-load' }));
      for (let j = 0; j < MEMBERS; j++) {
        const m = j === 0 ? o : await addMember(o, 'viewer', `Load Member ${i}-${j}`);
        const { code } = await m.as((ctx) => discord.createLinkCode(ctx));
        const discordId = `4${String(Date.now()).slice(-9)}${String(i * 100 + j).padStart(8, '0')}`;
        const linked = await discord.redeemLinkCode(o.org.id, code, { id: discordId, username: `load${i}_${j}` });
        expect(linked.ok).toBe(true);
        members.push({ orgId: o.org.id, appId, discordId, privateKey });
      }
    }
    discord.forgetDiscordApps();

    worker = await startWorker({ modules: allModules, schedules: false, healthPort: null, outboxPollMs: 250 });

    // Everyone at once.
    let n = 0;
    const sentAt = new Map<string, number>();
    const endpointMs: number[] = [];
    const statuses = new Map<number, number>();
    const started = Date.now();
    await Promise.all(
      members.map(async (m) => {
        for (let k = 0; k < LOOKUPS; k++) {
          const id = `${Date.now()}${String(n++).padStart(6, '0')}`;
          const token = `load-token-${id}-abcdefghijklmnop`;
          const payload = JSON.stringify({ id, application_id: m.appId, token, version: 1, type: 2, data: { name: 'song', type: 1, options: [{ name: 'query', type: 3, value: isrc(Math.floor(Math.random() * SONGS)) }] }, member: { user: { id: m.discordId, username: 'load' } } });
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = sign(null, Buffer.from(ts + payload), m.privateKey).toString('hex');
          const t = performance.now();
          const res = await handleInteraction(new Request('http://localhost/api/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts, 'content-type': 'application/json' }, body: payload }));
          endpointMs.push(performance.now() - t);
          const body = (await res.json()) as { type: number };
          statuses.set(body.type, (statuses.get(body.type) ?? 0) + 1);
          if (body.type === 5) sentAt.set(token, Date.now());
        }
      }),
    );

    // Wait for every deferred reply to be edited.
    while (Date.now() - started < TIMEOUT_MS && [...sentAt.keys()].some((t) => !edits.has(t))) await sleep(250);
    await sleep(1000); // any duplicate edit would land by now
    const elapsed = (Date.now() - started) / 1000;

    const replyMs = [...sentAt.entries()].filter(([t]) => editedAt.has(t)).map(([t, at]) => editedAt.get(t)! - at);
    const log = await systemDb().select().from(discordLookups).where(inArray(discordLookups.orgId, orgIds));
    const sourceOutcomes: Record<string, Record<string, number>> = {};
    for (const l of log)
      for (const s of l.sources ?? []) {
        sourceOutcomes[s.source] ??= {};
        sourceOutcomes[s.source][s.outcome] = (sourceOutcomes[s.source][s.outcome] ?? 0) + 1;
      }
    const outcomes = log.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.outcome]: (acc[l.outcome] ?? 0) + 1 }), {});

    const summary = {
      at: new Date().toISOString(),
      labels: ORGS,
      members: ORGS * MEMBERS,
      commands: n,
      songs: SONGS,
      apiLatencyMs: API_LATENCY_MS,
      elapsedSec: Number(elapsed.toFixed(1)),
      endpointMs: { p50: pct(endpointMs, 50), p95: pct(endpointMs, 95), max: pct(endpointMs, 100) },
      endpointAnswers: Object.fromEntries(statuses),
      replyMs: { p50: pct(replyMs, 50), p95: pct(replyMs, 95), max: pct(replyMs, 100) },
      replied: replyMs.length,
      duplicateEdits: [...edits.values()].filter((v) => v > 1).length,
      outcomes,
      cacheHits: log.filter((l) => l.cached).length,
      sourceOutcomes,
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/load-discord.json', JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));

    // Discord gives the endpoint 3 seconds; it answers far inside that.
    expect(summary.endpointMs.max).toBeLessThan(3000);
    expect(summary.endpointMs.p95).toBeLessThan(500);
    // Every command was queued, and every queued reply was edited exactly once.
    expect(statuses.get(5)).toBe(n);
    expect(summary.replied).toBe(n);
    expect(summary.duplicateEdits).toBe(0);
    // Every reply was a card: a slow or limited source degrades a card, never stops it.
    expect(outcomes.card).toBe(n);
    // Interaction tokens last 15 minutes; replies come well within that.
    expect(summary.replyMs.max).toBeLessThan(120_000);
  }, TIMEOUT_MS + 120_000);
});

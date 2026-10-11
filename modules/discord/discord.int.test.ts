import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/modules';
import { withSystemOrg } from '@labelconsole/core/context';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { auditLog, memberships } from '@labelconsole/core/db/schema';
import { setModuleEnabled } from '@labelconsole/core/modules';
import { closeQueues, queue } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { setSpotScraperFactory } from '@labelconsole/core/spotscraper';
import * as catalogue from '@labelconsole/catalogue/service';
import { documents, statementLines } from '@labelconsole/documents/schema';
import { notifications } from '@labelconsole/inbox/schema';
import { createArtist } from '@labelconsole/people/service';
import { saveCredential } from '@labelconsole/settings/service';
import { FakeSpotScraper } from '../../test/fake-spotscraper';
import { addMember, makeOrg, runJob } from '../../test/helpers';
import { handleInteraction } from './interactions';
import { jobs } from './jobs';
import type { Button, MessagePayload } from './protocol/types';
import { discordCorrections, discordLinks, discordLookups, discordPlayReadings } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Recorded public API answers, and every request Discord would receive from us (with uploaded files). */
type Sent = { method: string; url: string; body: Record<string, unknown>; files: Array<{ name: string; type: string; size: number }> };
let sent: Sent[] = [];
let calls: string[] = [];
let searchResults: unknown[] = [];
let artistResults: unknown[] = [];
let labelResults: unknown[] = [];
let appIdRef = '';

const HBFS = { id: 3135556, title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', duration: 224, link: 'https://www.deezer.com/track/3135556', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=1', available_countries: ['DE', 'FR', 'GB', 'US'], artist: { name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery' } };
const DISCOVERY = { id: 302127, title: 'Discovery', upc: '724384960650', artist: { name: 'Daft Punk' }, label: 'Parlophone (France)', release_date: '2001-03-07', record_type: 'album', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/discovery/1000x1000.jpg', tracks: { data: [{ id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224 }] } };

function stubApis() {
  sent = [];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://discord.com/api/v10/')) {
        let body: Record<string, unknown> = {};
        const files: Sent['files'] = [];
        if (init?.body instanceof FormData) {
          body = JSON.parse(String(init.body.get('payload_json')));
          for (const [k, v] of init.body.entries()) if (k.startsWith('files[') && v instanceof Blob) files.push({ name: (v as File).name, type: v.type, size: v.size });
        } else if (init?.body) body = JSON.parse(String(init.body));
        sent.push({ method: init?.method ?? 'GET', url: u, body, files });
        if (u.endsWith('/applications/@me')) return json({ id: appIdRef, integration_types_config: { '1': {} } });
        if (u.endsWith('/commands')) return json((body as unknown as Array<{ name: string }>).map((c, i) => ({ id: String(i + 1), name: c.name })));
        return json({ id: 'message-1' });
      }
      if (u.startsWith('https://cdnt-preview.dzcdn.net/')) return new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      if (u.startsWith('https://api.deezer.com/search/artist')) return json({ data: artistResults });
      if (u.startsWith('https://api.deezer.com/search/album')) return json({ data: [{ id: 302127, title: 'Discovery', record_type: 'album', nb_tracks: 14, artist: { name: 'Daft Punk' } }] });
      if (u.startsWith('https://api.deezer.com/search')) return json({ data: searchResults });
      if (u === 'https://api.deezer.com/track/isrc:GBDUW0000059' || u === 'https://api.deezer.com/track/3135556') return json(HBFS);
      if (u === 'https://api.deezer.com/track/isrc:GBDUW0000060') return json({ ...HBFS, id: 4, isrc: 'GBDUW0000060', title: 'One More Time', album: { id: 302127, title: 'Discovery' } });
      if (u === 'https://api.deezer.com/album/302127' || u.startsWith('https://api.deezer.com/album/upc:')) return json(DISCOVERY);
      if (u === 'https://api.deezer.com/artist/27') return json({ id: 27, name: 'Daft Punk', link: 'https://www.deezer.com/artist/27', picture_xl: 'https://cdn-images.dzcdn.net/images/artist/x/1000x1000.jpg', nb_fan: 4_500_000, nb_album: 40 });
      if (u.startsWith('https://api.deezer.com/artist/27/albums')) return json({ data: [{ id: 302127, title: 'Discovery', record_type: 'album', release_date: '2001-03-07', link: 'https://www.deezer.com/album/302127' }] });
      if (u.startsWith('https://api.deezer.com')) return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
      if (u.startsWith('https://musicbrainz.org/ws/2/artist/')) return json({ artists: [{ id: '056e4f3e-d505-4dad-8ec1-d04f521cbb56', name: 'Daft Punk', score: 100, type: 'Group', country: 'FR', area: { name: 'France' }, 'life-span': { begin: '1993' } }] });
      if (u.startsWith('https://musicbrainz.org/ws/2/label/?')) return json({ labels: labelResults });
      if (u.startsWith('https://musicbrainz.org/ws/2/release?label=')) return json({ 'release-count': 1234 });
      if (u.startsWith('https://musicbrainz.org')) return json({ releases: [], recordings: [] });
      if (u.startsWith('https://itunes.apple.com')) return json({ resultCount: 0, results: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
}

const edits = () => sent.filter((s) => s.method === 'PATCH');
const lastEdit = () => edits().at(-1)!.body as MessagePayload;
const buttons = (m: MessagePayload) => (m.components ?? []).flatMap((r) => r.components) as Button[];

let users = 0;
/** A fresh Discord user per label, so per-user rate limits don't carry over between tests. */
const discordUser = () => ({ id: `3${String(Date.now()).slice(-10)}${String(users++).padStart(6, '0')}`, username: 'mara', global_name: 'Mara' });

/** A label with its Discord app connected, and a way to send it signed interactions. */
async function label(name = 'Discord Label') {
  const org = await makeOrg(name);
  const DUSER = discordUser();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const appId = `1${String(Date.now()).slice(-9)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  appIdRef = appId;
  await org.as((ctx) => saveCredential(ctx, { provider: 'discord', applicationId: appId, publicKey: hex, botToken: 'bot-token-for-tests' }));
  svc.forgetDiscordApps();
  let n = 0;
  const send = async (body: Record<string, unknown>, opts: { ts?: number; key?: KeyObject; tamper?: boolean } = {}) => {
    const id = `${Date.now()}${String(n++).padStart(4, '0')}`;
    const payload = JSON.stringify({ id, application_id: appId, token: `interaction-token-${id}-abcdefghijklmnop`, version: 1, ...body });
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(ts + payload), opts.key ?? privateKey).toString('hex');
    const res = await handleInteraction(
      new Request('http://localhost/api/discord/interactions', {
        method: 'POST',
        headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts, 'content-type': 'application/json' },
        body: opts.tamper ? payload.replace('"version":1', '"version":2') : payload,
      }),
    );
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? (JSON.parse(text) as { type: number; data?: MessagePayload & { custom_id?: string; components?: unknown[] } }) : null, id };
  };
  /** Run the worker job a deferred interaction queued, the way the worker would. */
  const work = async (id: string) => {
    const job = await queue('jobs').getJob(`discord-${id}`);
    expect(job, 'a queued Discord job').toBeTruthy();
    await runJob(jobs, 'discord.interaction', org.org.id, job!.data.data);
    await job!.remove();
  };
  const command = (name: string, options: Record<string, string | boolean> = {}, user = DUSER) =>
    send({ type: 2, data: { name, type: 1, options: Object.entries(options).map(([k, v]) => ({ name: k, type: typeof v === 'boolean' ? 5 : 3, value: v })) }, member: { user } });
  const song = (query: string, user = DUSER, artist?: string) => command('song', { query, ...(artist ? { artist } : {}) }, user);
  const click = (customId: string, values?: string[]) => send({ type: 3, data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) }, member: { user: DUSER }, message: { id: 'm1', flags: 64 } });
  const link = async (as: typeof org.as, user = DUSER) => {
    const { code } = await as((ctx) => svc.createLinkCode(ctx));
    return send({ type: 2, data: { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: code.toLowerCase() }] }, user });
  };
  return { ...org, appId, send, command, song, click, link, work, DUSER };
}

beforeEach(() => stubApis());
afterEach(() => {
  vi.unstubAllGlobals();
  setSpotScraperFactory(null);
});

describe('discord interactions endpoint', () => {
  it('answers only what Discord signed for a connected app', async () => {
    const a = await label();
    expect((await a.send({ type: 1 })).body).toEqual({ type: 1 });
    expect((await a.send({ type: 1 }, { key: generateKeyPairSync('ed25519').privateKey })).status).toBe(401);
    expect((await a.send({ type: 1 }, { tamper: true })).status).toBe(401);
    expect((await a.send({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await a.send({ type: 1, application_id: '999999999999999999' })).status).toBe(401);
    const unsigned = await handleInteraction(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ type: 1, application_id: a.appId }) }));
    expect(unsigned.status).toBe(401);
  });

  it('rejects a malformed Discord integration when it is saved', async () => {
    const a = await makeOrg();
    await expect(a.as((ctx) => saveCredential(ctx, { provider: 'discord', applicationId: 'my app', publicKey: 'abc', botToken: 'x' }))).rejects.toThrow(/Application ID doesn't look right/);
  });

  it('links an account with a one-time code and answers nobody else', async () => {
    const a = await label();
    const before = await a.song('GBDUW0000059');
    expect(before.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(before.body?.data?.content).toMatch(/Link your Discord account first/);

    const wrong = await a.send({ type: 2, data: { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: 'ABCD-EFGH' }] }, user: a.DUSER });
    expect(wrong.body?.data?.content).toMatch(/wrong or has expired/);

    const { code } = await a.as((ctx) => svc.createLinkCode(ctx));
    const linked = await a.send({ type: 2, data: { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: code }] }, user: a.DUSER });
    expect(linked.body?.data?.content).toMatch(/Linked\. Your Discord account now acts as \*\*Test Owner\*\*/);
    const rows = await systemDb().select().from(discordLinks).where(eq(discordLinks.orgId, a.org.id));
    expect(rows).toMatchObject([{ userId: a.user.id, discordUserId: a.DUSER.id, discordUsername: 'Mara' }]);
    const [audit] = await systemDb().select().from(auditLog).where(and(eq(auditLog.orgId, a.org.id), eq(auditLog.action, 'discord.linked')));
    expect(audit.after).toMatchObject({ discordUsername: 'Mara' });

    // A code works once, even for someone else.
    const reuse = await a.send({ type: 2, data: { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: code }] }, user: { id: '322222222222222222', username: 'other' } });
    expect(reuse.body?.data?.content).toMatch(/wrong or has expired/);

    expect((await a.song('GBDUW0000059')).body).toEqual({ type: 5, data: { flags: 64 } });
    await queue('jobs').getJob(`discord-${(await a.song('GBDUW0000060')).id}`).then((j) => j?.remove());

    const unlink = await a.send({ type: 2, data: { name: 'unlink', type: 1 }, user: a.DUSER });
    expect(unlink.body?.data?.content).toMatch(/no longer linked/);
    expect((await a.song('GBDUW0000059')).body?.data?.content).toMatch(/Link your Discord account first/);
  });

  it('answers /song with a DistroFind-style card showing what the label holds, as the member may see it', async () => {
    const a = await label();
    const fake = new FakeSpotScraper();
    fake.tracks.set('5W3cjX2J3tjhG8zb6u0qHn', { id: '5W3cjX2J3tjhG8zb6u0qHn', name: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', durationMs: 224000, explicit: false, popularity: 70, playCount: 306877, artists: [{ id: 'dp', name: 'Daft Punk' }], album: { id: 'alb', name: 'Discovery', copyright: null } });
    setSpotScraperFactory(async () => fake);
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Daft Punk', status: 'active' });
      const release = await catalogue.createRelease(ctx, { title: 'Discovery', type: 'album', upc: '724384960650', distributor: 'Believe', labelName: 'Parlophone (France)', artistIds: [artist.id] });
      const track = await catalogue.createTrack(ctx, { title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', releaseId: release.id, artistIds: [artist.id] });
      await catalogue.addCredit(ctx, track.id, { name: 'Thomas Bangalter', role: 'Producer' });
    });
    await a.link(a.as);

    const res = await a.song('GBDUW0000059');
    expect(res.body).toEqual({ type: 5, data: { flags: 64 } });
    await a.work(res.id);
    const card = lastEdit();
    expect(edits()[0].url).toMatch(/\/webhooks\/\d+\/interaction-token-[\w-]+\/messages\/@original$/);
    expect(card.allowed_mentions).toEqual({ parse: [] });
    const [dist, main] = card.embeds!;
    expect(dist).toMatchObject({ title: 'Believe', description: '*Verified · recorded in your catalogue*' });
    expect(dist.thumbnail?.url).toContain('believe.com');
    expect(main.title).toBe('Harder, Better, Faster, Stronger');
    expect(main.description).toBe('by Daft Punk\n📁 In your catalogue');
    expect(main.thumbnail?.url).toContain('dzcdn');
    expect(main.fields?.find((f) => f.name === '🏷️ Label')?.value).toBe('Parlophone (France) ✓');
    expect(main.fields?.find((f) => f.name === '📈 Streams')?.value).toBe('306,877');
    expect(buttons(card).map((b) => b.label)).toEqual(['Extended Info', 'View Credits', 'View Performance Chart', 'Other Links', 'Audio File', 'Playable in 4 countries', 'Report / Correct']);
    // The play count was kept as a reading for the chart.
    expect(await systemDb().select().from(discordPlayReadings).where(eq(discordPlayReadings.orgId, a.org.id))).toMatchObject([{ isrc: 'GBDUW0000059', platform: 'spotify', count: 306877 }]);

    // Each button opens its own private reply; the card stays, and the sources are not asked again.
    const deezerCalls = calls.filter((c) => c.includes('deezer')).length;
    const credits = await a.click('lc:v:credits:isrc:GBDUW0000059');
    expect(credits.body).toEqual({ type: 5, data: { flags: 64 } });
    await a.work(credits.id);
    expect(lastEdit().embeds![0]).toMatchObject({ title: '👥 Credits', fields: [{ name: 'Production & Engineering', value: '• **Thomas Bangalter** — Producer' }] });
    expect(calls.filter((c) => c.includes('api.deezer.com')).length).toBe(deezerCalls);

    const chart = await a.click('lc:v:chart:isrc:GBDUW0000059');
    await a.work(chart.id);
    expect(lastEdit().embeds![0].title).toBe('📈 Performance');
    expect(lastEdit().embeds![0].fields?.[0]).toMatchObject({ name: '📈 Latest count' });

    const audio = await a.click('lc:v:audio:isrc:GBDUW0000059');
    await a.work(audio.id);
    expect(edits().at(-1)!.files).toEqual([{ name: 'preview.mp3', type: 'audio/mpeg', size: 11 }]);
    expect(lastEdit().attachments).toEqual([{ id: 0, filename: 'preview.mp3', description: '30-second preview of Harder, Better, Faster, Stronger' }]);

    for (const [view, title] of [['details', 'ℹ️ Extended Info'], ['avail', '🌍 Availability'], ['links', '🔗 Other Links']] as const) {
      const r = await a.click(`lc:v:${view}:isrc:GBDUW0000059`);
      await a.work(r.id);
      expect(lastEdit().embeds![0].title).toBe(title);
    }
    const log = await systemDb().select().from(discordLookups).where(eq(discordLookups.orgId, a.org.id));
    expect(log.length).toBe(7);
    expect(log.find((l) => l.command === 'song')).toMatchObject({ outcome: 'card', inputKind: 'isrc', ref: 'isrc:GBDUW0000059', cached: false });
    expect(log.filter((l) => l.command.startsWith('button:')).every((l) => l.cached)).toBe(true);
  });

  it('answers /release with a release card and its tracklist', async () => {
    const a = await label();
    await a.link(a.as);
    const res = await a.command('release', { query: 'Daft Punk - Discovery' });
    await a.work(res.id);
    const main = lastEdit().embeds!.at(-1)!;
    expect(main.title).toBe('Discovery');
    expect(main.description).toBe('by Daft Punk | Album');
    expect(main.fields?.map((f) => f.name)).toContain('🎵 Tracks');
    expect(buttons(lastEdit())[0]).toMatchObject({ label: 'View Tracklist', custom_id: 'lc:v:tracks:upc:0724384960650' });
    const tracks = await a.click('lc:v:tracks:upc:0724384960650');
    await a.work(tracks.id);
    expect(lastEdit().embeds![0].description).toContain('Harder, Better, Faster, Stronger');
  });

  it('posts a card for everyone only when asked and allowed, and keeps label-only details off it', async () => {
    const a = await label();
    await a.as((ctx) => catalogue.createTrack(ctx, { title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059' }));
    await a.link(a.as);
    const res = await a.command('song', { query: 'GBDUW0000059', share: true });
    expect(res.body).toEqual({ type: 5, data: {} });
    await a.work(res.id);
    const main = lastEdit().embeds!.at(-1)!;
    expect(main.description).not.toContain('In your catalogue');
    expect(buttons(lastEdit()).some((b) => b.label === 'Open in Label Console')).toBe(false);

    await a.as((ctx) => svc.updateSharing(ctx, { shareDistributor: false }));
    const res2 = await a.command('song', { query: 'GBDUW0000059', share: true });
    await a.work(res2.id);
    expect(lastEdit().embeds).toHaveLength(1);

    await a.as((ctx) => svc.updateSharing(ctx, { allowSharing: false }));
    const res3 = await a.command('song', { query: 'GBDUW0000059', share: true });
    expect(res3.body).toEqual({ type: 5, data: { flags: 64 } });
    await queue('jobs').getJob(`discord-${res3.id}`).then((j) => j?.remove());
  });

  it('asks "Which one?" when a title matches several songs, then looks up the choice', async () => {
    const a = await label();
    await a.link(a.as);
    searchResults = [
      { id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224, isrc: 'GBDUW0000059', artist: { name: 'Daft Punk' }, album: { title: 'Discovery' } },
      { id: 777, title: 'Harder, Better, Faster, Stronger', duration: 180, artist: { name: 'Cover Band' }, album: { title: 'Covers' } },
    ];
    const res = await a.song('Harder, Better, Faster, Stronger');
    await a.work(res.id);
    const picker = lastEdit();
    expect(picker.content).toMatch(/Several songs match/);
    const select = picker.components![0].components[0];
    expect('options' in select && select.options.map((o) => o.value)).toEqual(['dz:3135556', 'dz:777']);

    const pick = await a.click('lc:pick', ['dz:3135556']);
    expect(pick.body).toMatchObject({ type: 7, data: { content: 'Looking it up…', components: [] } });
    await a.work(pick.id);
    expect(lastEdit().embeds!.at(-1)!.title).toBe('Harder, Better, Faster, Stronger');

    // Naming the artist leaves one exact match: no question.
    const named = await a.song('Harder, Better, Faster, Stronger', a.DUSER, 'Daft Punk');
    await a.work(named.id);
    expect(lastEdit().embeds!.at(-1)!.description).toBe('by Daft Punk');
  });

  it('takes corrections for review and shows approved ones as reviewed values', async () => {
    const a = await label();
    const editor = await addMember(a, 'ar', 'Catalogue Editor');
    await a.link(a.as);
    // From the card: Report / Correct opens a form, and submitting it files the correction.
    const open = await a.click('lc:v:correct:isrc:GBDUW0000059');
    expect(open.body?.type).toBe(9);
    expect(open.body?.data?.custom_id).toBe('lc:fix:isrc:GBDUW0000059');
    const submit = await a.send({ type: 5, data: { custom_id: 'lc:fix:isrc:GBDUW0000059', components: [{ type: 18, component: { type: 3, custom_id: 'field', values: ['labelName'] } }, { type: 18, component: { type: 4, custom_id: 'value', value: 'Virgin' } }, { type: 18, component: { type: 4, custom_id: 'note', value: 'Back cover' } }] }, member: { user: a.DUSER } });
    expect(submit.body).toEqual({ type: 5, data: { flags: 64 } });
    await a.work(submit.id);
    expect(lastEdit().content).toMatch(/waiting for review/);
    const [row] = await systemDb().select().from(discordCorrections).where(eq(discordCorrections.orgId, a.org.id));
    expect(row).toMatchObject({ ref: 'isrc:GBDUW0000059', field: 'labelName', currentValue: 'Parlophone (France)', proposedValue: 'Virgin', note: 'Back cover', status: 'pending' });
    const notes = await systemDb().select().from(notifications).where(and(eq(notifications.orgId, a.org.id), eq(notifications.userId, editor.user.id)));
    expect(notes[0]?.title).toMatch(/Correction suggested: Label/);

    // /correct does the same from a command.
    const cmd = await a.command('correct', { target: 'GBDUW0000059', field: 'pLine', value: '℗ 2001 Daft Life Ltd.' });
    await a.work(cmd.id);
    const pending = await a.as((ctx) => svc.listCorrections(ctx, 'pending'));
    expect(pending.map((p) => p.row.field).sort()).toEqual(['labelName', 'pLine']);

    // Viewers cannot approve; an editor can.
    const viewer = await addMember(a, 'viewer', 'Viewer');
    await expect(viewer.as((ctx) => svc.reviewCorrection(ctx, row.id, { decision: 'approved' }))).rejects.toThrow(/catalogue:write/);
    await editor.as((ctx) => svc.reviewCorrection(ctx, row.id, { decision: 'approved' }));
    const res = await a.song('GBDUW0000059');
    await a.work(res.id);
    expect(lastEdit().embeds!.at(-1)!.fields?.find((f) => f.name === '🏷️ Label')?.value).toBe('Virgin ✓');
    const details = await a.click('lc:v:details:isrc:GBDUW0000059');
    await a.work(details.id);
    expect(JSON.stringify(lastEdit().embeds![0])).toContain('Verified · reviewed correction (Catalogue Editor)');
  });

  it('verifies the distributor from the label’s statements and answers /licensor', async () => {
    const a = await label();
    await a.as(async (ctx) => {
      await catalogue.createRelease(ctx, { title: 'Discovery', type: 'album', upc: '724384960650' });
      await catalogue.createRelease(ctx, { title: 'Manual One', type: 'single', distributor: 'DistroKid' });
      await catalogue.createRelease(ctx, { title: 'Guessed One', type: 'single', distributor: 'DistroKid', distributorConfidence: 0.6 });
    });
    await withSystemOrg(a.org.id, async (ctx) => {
      const [doc] = await ctx.tx.insert(documents).values({ type: 'statement', title: 'DistroKid August', extractedTerms: { distributor: 'DistroKid', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'USD', lineCount: 1, grossCents: 100, netCents: 90, units: 10, bySource: [], anomalies: [] } }).returning();
      await ctx.tx.insert(statementLines).values({ documentId: doc.id, source: 'Spotify', upc: '0724384960650', isrc: 'GBDUW0000059', periodEnd: '2026-08-31', units: 10, netCents: 90 });
    });
    await a.link(a.as);
    const res = await a.song('GBDUW0000059');
    await a.work(res.id);
    expect(lastEdit().embeds![0]).toMatchObject({ title: 'DistroKid', description: '*Verified · in your distributor statements*' });

    const lic = await a.command('licensor', { query: 'distrokid' });
    await a.work(lic.id);
    const e = lastEdit().embeds![0];
    expect(e.title).toBe('DistroKid');
    const verified = e.fields!.find((f) => f.name.startsWith('✓ Verified releases'))!;
    expect(verified.name).toBe('✓ Verified releases (2)');
    expect(verified.value).toContain('Manual One');
    expect(verified.value).toMatch(/Discovery.*distributor statements/);
    expect(verified.value).not.toContain('Guessed One');
  });

  it('answers /artist and /label, asking "Which one?" when names are ambiguous', async () => {
    const a = await label();
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Daft Punk', status: 'active' });
      await catalogue.createRelease(ctx, { title: 'Discovery', type: 'album', labelName: 'Virgin', artistIds: [artist.id] });
    });
    await a.link(a.as);
    artistResults = [
      { id: 27, name: 'Daft Punk', nb_fan: 4_500_000, nb_album: 40 },
      { id: 28, name: 'Daft Punk Tribute', nb_fan: 10, nb_album: 1 },
    ];
    const art = await a.command('artist', { query: 'daft punk' });
    await a.work(art.id);
    const e = lastEdit().embeds![0];
    expect(e).toMatchObject({ title: 'Daft Punk', url: 'https://www.deezer.com/artist/27' });
    expect(e.description).toContain('On your roster');
    expect(e.fields?.map((f) => f.name)).toEqual(['👥 Fans', '💿 Releases', '🌍 Country', '🏷️ Type', '📅 Active since', '🆕 Latest releases']);

    artistResults = [
      { id: 27, name: 'Daft Punk', nb_fan: 4_500_000 },
      { id: 29, name: 'Daft Punk', nb_fan: 5 },
    ];
    const amb = await a.command('artist', { query: 'Daft Punk' });
    await a.work(amb.id);
    expect(lastEdit().components![0].components[0]).toMatchObject({ custom_id: 'lc:pa' });
    const pick = await a.click('lc:pa', ['dzar:27']);
    await a.work(pick.id);
    expect(lastEdit().embeds![0].title).toBe('Daft Punk');

    labelResults = [{ id: '4cd2e3a6-8b2b-4f0e-a0a3-9b1c7a3f1e11', name: 'Virgin', score: 100, type: 'Original Production', country: 'GB', 'label-code': 3098, 'life-span': { begin: '1972' } }];
    const lab = await a.command('label', { query: 'Virgin' });
    await a.work(lab.id);
    const l = lastEdit().embeds![0];
    expect(l.title).toBe('Virgin');
    expect(l.fields?.map((f) => [f.name, f.value])).toEqual(
      expect.arrayContaining([
        ['🔢 Label code', 'LC 03098'],
        ['💿 Releases on MusicBrainz', '1,234'],
        ['📁 In your catalogue (1)', expect.stringContaining('Discovery')],
      ]),
    );
  });

  it('compares two songs field by field', async () => {
    const a = await label();
    await a.link(a.as);
    const res = await a.command('compare', { first: 'GBDUW0000059', second: 'GBDUW0000060' });
    await a.work(res.id);
    const e = lastEdit().embeds![0];
    expect(e.title).toBe('⚖️ Compare');
    expect(e.fields?.map((f) => f.name)).toEqual(['≠ Title', '≠ ISRC', '✓ The same']);
    const text = await a.command('compare', { first: 'Some Song', second: 'GBDUW0000060' });
    await a.work(text.id);
    expect(lastEdit().content).toMatch(/Use a link, ISRC or UPC here/);
  });

  it("applies the member's current role, artist scope and membership", async () => {
    const a = await label();
    const other = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Daft Punk', status: 'active' });
      const someoneElse = await createArtist(ctx, { name: 'Someone Else', status: 'active' });
      await catalogue.createTrack(ctx, { title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', artistIds: [artist.id] });
      return someoneElse;
    });
    const viewer = await addMember(a, 'viewer', 'Scoped Viewer');
    await a.link(viewer.as);

    // A viewer sees the label's track...
    await a.work((await a.song('GBDUW0000059')).id);
    expect(edits()[0].body.embeds).toBeDefined();
    expect((edits()[0].body as MessagePayload).embeds!.at(-1)!.description).toContain('In your catalogue');

    // ...until their access is limited to other artists.
    await systemDb().update(memberships).set({ artistScope: [other.id] }).where(and(eq(memberships.orgId, a.org.id), eq(memberships.userId, viewer.user.id)));
    await a.work((await a.song('GBDUW0000059')).id);
    const e = lastEdit().embeds!.at(-1)!;
    expect(e.title).toBe('Harder, Better, Faster, Stronger');
    expect(e.description).not.toContain('In your catalogue');
    await a.work((await a.click('lc:v:credits:isrc:GBDUW0000059')).id);
    expect(lastEdit().embeds![0].description).toContain('No credits were found');

    // Removed from the label: refused at once, and a job already queued says so too.
    const queued = await a.song('GBDUW0000059');
    await systemDb().update(memberships).set({ status: 'removed' }).where(and(eq(memberships.orgId, a.org.id), eq(memberships.userId, viewer.user.id)));
    expect((await a.song('GBDUW0000059')).body?.data?.content).toMatch(/no longer a member/);
    await a.work(queued.id);
    expect(lastEdit().content).toMatch(/no longer linked to a Label Console member/);
  });

  it('slows down one person sending a burst of lookups', async () => {
    const a = await label();
    await a.link(a.as);
    const replies = [];
    for (let i = 0; i < 9; i++) replies.push(await a.song(`GBDUW00000${60 + i}`));
    expect(replies.slice(0, 8).every((r) => r.body?.type === 5)).toBe(true);
    expect(replies[8].body?.data?.content).toMatch(/a lot of lookups at once/);
    for (const r of replies) await queue('jobs').getJob(`discord-${r.id}`).then((j) => j?.remove());
  });

  it('stays quiet when the module is switched off', async () => {
    const a = await label();
    await a.link(a.as);
    await a.as((ctx) => setModuleEnabled(ctx, 'discord', false));
    expect((await a.song('GBDUW0000059')).body?.data?.content).toMatch(/switched off/);
  });

  it('reports launch metrics and cleans up', async () => {
    const a = await label();
    await a.link(a.as);
    await a.work((await a.song('GBDUW0000059')).id);
    await a.work((await a.song('ZZZZZ0000000')).id);
    const stats = await a.as((ctx) => svc.lookupStats(ctx));
    expect(stats).toMatchObject({ total: 2, cards: 1, notFound: 1, codes: 2, codesFound: 1 }); // an unknown ISRC is an exact lookup that found nothing
    expect(stats.coverage.find((c) => c.field === 'labelName')).toMatchObject({ status: 'reported', n: 1 });
    await runJob(jobs, 'discord.purge', null, {});
  });

  it('registers the commands for the install types the app has on', async () => {
    const a = await label();
    await a.as((ctx) => svc.requestCommandRegistration(ctx));
    await runJob(jobs, 'discord.register-commands', a.org.id, { requestedBy: 'test' });
    const put = sent.find((s) => s.method === 'PUT')!;
    expect(sent.find((s) => s.url.endsWith('/applications/@me'))).toBeTruthy();
    const commands = put.body as unknown as Array<{ name: string; integration_types: number[]; contexts: number[] }>;
    expect(commands.map((c) => c.name)).toEqual(['song', 'release', 'artist', 'label', 'licensor', 'compare', 'correct', 'link', 'unlink', 'Look Up Song']);
    expect(commands.every((c) => c.integration_types.join() === '1' && c.contexts.join() === '0,1,2')).toBe(true);
    const status = await a.as((ctx) => svc.discordStatus(ctx));
    expect(status).toMatchObject({ ready: true, commandsError: null, interactionsUrl: 'http://localhost:3000/api/discord/interactions' });
    expect(status.commandsRegisteredAt).toBeTruthy();
    expect(status.userInstallUrl).toContain(`client_id=${a.appId}&integration_type=1`);

    // A bot token from another app is caught before anything is overwritten.
    appIdRef = '888888888888888888';
    await expect(runJob(jobs, 'discord.register-commands', a.org.id, { requestedBy: 'test' })).rejects.toThrow(/different Discord application/);
    expect((await a.as((ctx) => svc.discordStatus(ctx))).commandsError).toMatch(/different Discord application/);
  });
});

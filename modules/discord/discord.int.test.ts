import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { auditLog, memberships } from '@labelconsole/core/db/schema';
import { setModuleEnabled } from '@labelconsole/core/modules';
import { closeQueues, queue } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import * as catalogue from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { saveCredential } from '@labelconsole/settings/service';
import { addMember, makeOrg, runJob } from '../../test/helpers';
import { handleInteraction } from './interactions';
import { jobs } from './jobs';
import type { MessagePayload } from './protocol/types';
import { discordLinks } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Recorded public API answers, and every request Discord would receive from us. */
type Sent = { method: string; url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let calls: string[] = [];
let searchResults: unknown[] = [];

function stubApis(appId: () => string) {
  sent = [];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://discord.com/api/v10/')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        sent.push({ method: init?.method ?? 'GET', url: u, body });
        if (u.endsWith('/applications/@me')) return json({ id: appId(), integration_types_config: { '1': {} } });
        if (u.endsWith('/commands')) return json((body as unknown as Array<{ name: string }>).map((c, i) => ({ id: String(i + 1), name: c.name })));
        return json({ id: 'message-1' });
      }
      if (u.startsWith('https://api.deezer.com/search')) return json({ data: searchResults });
      if (u === 'https://api.deezer.com/track/isrc:GBDUW0000059' || u === 'https://api.deezer.com/track/3135556')
        return json({ id: 3135556, title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', duration: 224, link: 'https://www.deezer.com/track/3135556', artist: { name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery' } });
      if (u === 'https://api.deezer.com/album/302127')
        return json({ id: 302127, title: 'Discovery', upc: '724384960650', label: 'Parlophone (France)', release_date: '2001-03-07', record_type: 'album', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/discovery/1000x1000.jpg', tracks: { data: [] } });
      if (u.startsWith('https://api.deezer.com')) return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
      if (u.startsWith('https://musicbrainz.org')) return json({ releases: [], recordings: [] });
      if (u.startsWith('https://itunes.apple.com')) return json({ resultCount: 0, results: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
}

const edits = () => sent.filter((s) => s.method === 'PATCH').map((s) => s.body as MessagePayload);

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
    return { status: res.status, body: res.status === 200 ? (JSON.parse(text) as { type: number; data?: MessagePayload }) : null, id };
  };
  /** Run the worker job a deferred interaction queued, the way the worker would. */
  const work = async (id: string) => {
    const job = await queue('jobs').getJob(`discord-${id}`);
    expect(job, 'a queued Discord job').toBeTruthy();
    await runJob(jobs, 'discord.interaction', org.org.id, job!.data.data);
    await job!.remove();
  };
  const song = (query: string, user = DUSER, artist?: string) => send({ type: 2, data: { name: 'song', type: 1, options: [{ name: 'query', type: 3, value: query }, ...(artist ? [{ name: 'artist', type: 3, value: artist }] : [])] }, member: { user } });
  const link = async (as: typeof org.as, user = DUSER) => {
    const { code } = await as((ctx) => svc.createLinkCode(ctx));
    return send({ type: 2, data: { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: code.toLowerCase() }] }, user });
  };
  return { ...org, appId, send, song, link, work, DUSER };
}

let appIdRef = '';
beforeEach(() => stubApis(() => appIdRef));
afterEach(() => vi.unstubAllGlobals());

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

  it('looks up an ISRC and shows what the label holds, as the linked member may see it', async () => {
    const a = await label();
    appIdRef = a.appId;
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
    const [card] = edits();
    expect(sent[0].url).toMatch(/\/webhooks\/\d+\/interaction-token-[\w-]+\/messages\/@original$/);
    expect(card.allowed_mentions).toEqual({ parse: [] });
    const e = card.embeds![0];
    expect(e.title).toBe('Harder, Better, Faster, Stronger');
    expect(e.thumbnail?.url).toContain('dzcdn');
    expect(e.description).toContain('In your catalogue');
    expect(e.fields?.find((f) => f.name === 'Distributor')?.value).toMatch(/Believe\n\*Verified · recorded in your catalogue\*/);
    expect(e.fields?.find((f) => f.name === 'Label')?.value).toMatch(/Verified · matches your catalogue/);
    const credits = card.components![0].components.find((c) => 'label' in c && c.label === 'Credits');
    expect(credits).toMatchObject({ custom_id: 'lc:v:credits:isrc:GBDUW0000059' });

    // Switching views reuses the lookup instead of asking every source again.
    const deezerCalls = calls.filter((c) => c.includes('deezer')).length;
    const click = await a.send({ type: 3, data: { custom_id: 'lc:v:credits:isrc:GBDUW0000059', component_type: 2 }, member: { user: a.DUSER }, message: { id: 'm1', flags: 64 } });
    expect(click.body).toEqual({ type: 6 });
    await a.work(click.id);
    expect(edits()[1].embeds![0].description).toContain('**Producer:** Thomas Bangalter');
    expect(calls.filter((c) => c.includes('deezer')).length).toBe(deezerCalls);
  });

  it('asks "Which one?" when a title matches several songs, then looks up the choice', async () => {
    const a = await label();
    await a.link(a.as);
    searchResults = [
      { id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224, artist: { name: 'Daft Punk' }, album: { title: 'Discovery' } },
      { id: 777, title: 'Harder, Better, Faster, Stronger', duration: 180, artist: { name: 'Cover Band' }, album: { title: 'Covers' } },
    ];
    const res = await a.song('Harder, Better, Faster, Stronger');
    await a.work(res.id);
    const picker = edits()[0];
    expect(picker.content).toMatch(/Several songs match/);
    const select = picker.components![0].components[0];
    expect('options' in select && select.options.map((o) => o.value)).toEqual(['dz:3135556', 'dz:777']);

    const pick = await a.send({ type: 3, data: { custom_id: 'lc:pick', component_type: 3, values: ['dz:3135556'] }, member: { user: a.DUSER }, message: { id: 'm2', flags: 64 } });
    expect(pick.body).toMatchObject({ type: 7, data: { content: 'Looking it up…', components: [] } });
    await a.work(pick.id);
    expect(edits()[1].embeds![0].title).toBe('Harder, Better, Faster, Stronger');

    // Naming the artist leaves one exact match: no question.
    sent = [];
    const named = await a.song('Harder, Better, Faster, Stronger', a.DUSER, 'Daft Punk');
    await a.work(named.id);
    expect(edits()[0].embeds![0].author?.name).toBe('Daft Punk');
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
    expect(edits()[0].embeds![0].description).toContain('In your catalogue');

    // ...until their access is limited to other artists.
    await systemDb().update(memberships).set({ artistScope: [other.id] }).where(and(eq(memberships.orgId, a.org.id), eq(memberships.userId, viewer.user.id)));
    await a.work((await a.song('GBDUW0000059')).id);
    const e = edits()[1].embeds![0];
    expect(e.title).toBe('Harder, Better, Faster, Stronger');
    expect(e.description).not.toContain('In your catalogue');
    await a.work((await a.send({ type: 3, data: { custom_id: 'lc:v:credits:isrc:GBDUW0000059', component_type: 2 }, member: { user: a.DUSER }, message: { id: 'm3', flags: 64 } })).id);
    expect(edits()[2].embeds![0].description).toContain("This one isn't, or your role can't see it");

    // Removed from the label: refused at once, and a job already queued says so too.
    const queued = await a.song('GBDUW0000059');
    await systemDb().update(memberships).set({ status: 'removed' }).where(and(eq(memberships.orgId, a.org.id), eq(memberships.userId, viewer.user.id)));
    expect((await a.song('GBDUW0000059')).body?.data?.content).toMatch(/no longer a member/);
    await a.work(queued.id);
    expect(edits()[3].content).toMatch(/no longer linked to a Label Console member/);
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

  it('registers the commands for the install types the app has on', async () => {
    const a = await label();
    appIdRef = a.appId;
    await a.as((ctx) => svc.requestCommandRegistration(ctx));
    await runJob(jobs, 'discord.register-commands', a.org.id, { requestedBy: 'test' });
    const put = sent.find((s) => s.method === 'PUT')!;
    expect(sent.find((s) => s.url.endsWith('/applications/@me'))).toBeTruthy();
    const commands = put.body as unknown as Array<{ name: string; integration_types: number[]; contexts: number[] }>;
    expect(commands.map((c) => c.name)).toEqual(['song', 'link', 'unlink', 'Look Up Song']);
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

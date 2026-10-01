/**
 * Development seed: one sample label with a roster, catalogue, network,
 * a live campaign, a distributor statement and three agents, created through
 * the same services the app uses (so permissions, events and audit all apply).
 *
 * Dev only. It refuses to run unless LC_DEV_SEED=1, and always refuses when
 * NODE_ENV=production. Nothing here is imported by the apps.
 *
 *   LC_DEV_SEED=1 pnpm db:seed
 *
 * No stream readings are invented: stream history fills in once a YouTube key
 * is added and the worker polls. Statement figures are generated sample data.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { signup } from '@labelconsole/core/auth';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { users } from '@labelconsole/core/db/schema';
import { PermissionSet } from '@labelconsole/core/permissions';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import * as agents from '@labelconsole/agents/service';
import * as catalogue from '@labelconsole/catalogue/service';
import * as documents from '@labelconsole/documents/service';
import * as marketing from '@labelconsole/marketing/service';
import * as network from '@labelconsole/network/service';
import * as people from '@labelconsole/people/service';
import * as settings from '@labelconsole/settings/service';
import '../apps/worker/src/modules';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@northline.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'correct horse battery';

if (process.env.NODE_ENV === 'production') {
  console.error('[db:seed] refusing to seed: NODE_ENV=production');
  process.exit(1);
}
if (process.env.LC_DEV_SEED !== '1') {
  console.error('[db:seed] refusing to seed: set LC_DEV_SEED=1 to create sample data in a development database');
  process.exit(1);
}

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

/** Small deterministic PRNG so the sample statement is the same on every seed. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** A DistroKid-format statement for the seeded tracks over the last six months. */
function sampleStatement(tracks: Array<{ title: string; artist: string; isrc: string; weight: number }>) {
  const rand = rng(42);
  const stores: Array<[string, number]> = [['Spotify', 0.0031], ['Apple Music', 0.0062], ['YouTube Music', 0.0021], ['Amazon Music', 0.0048], ['Deezer', 0.0035], ['TikTok', 0.0009]];
  const countries = ['US', 'GB', 'DE', 'NL', 'SE', 'FR'];
  const now = new Date();
  const rows = ['Reporting Date,Sale Month,Store,Artist,Title,ISRC,UPC,Quantity,Team Percentage,Song/Album,Country of Sale,Songwriter Royalties Withheld,Earnings (USD)'];
  for (let m = 6; m >= 1; m--) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1)).toISOString().slice(0, 7);
    for (const t of tracks)
      for (const [store, rate] of stores)
        for (const country of countries) {
          if (rand() < 0.35) continue;
          const qty = Math.round(t.weight * (400 + rand() * 9000) * (store === 'Spotify' ? 3 : 1) * (1 + (6 - m) * 0.08));
          rows.push([now.toISOString().slice(0, 10), month, store, t.artist, t.title, t.isrc, '', qty, 100, 'Song', country, 0, (qty * rate).toFixed(2)].join(','));
        }
  }
  return rows.join('\n') + '\n';
}

async function seed() {
  const [exists] = await systemDb().select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  if (exists) {
    console.log(`[db:seed] ${EMAIL} already exists; nothing to do. Delete that user (or use SEED_EMAIL) to seed again.`);
    return;
  }

  const { user, org } = await signup({ name: 'Sam Okafor', email: EMAIL, password: PASSWORD, labelName: 'Northline Records' });
  const as = <T>(fn: (ctx: ServiceContext) => Promise<T>) => withOrg({ orgId: org.id, actor: { type: 'user', id: user.id, name: user.name }, permissions: PermissionSet.forRole('owner') }, fn);

  await as(async (ctx) => {
    await settings.updateWorkspace(ctx, { shortCode: 'NR', legalEntity: 'Northline Records Ltd', distributor: 'DistroKid', currency: 'USD', timezone: 'Europe/London', siteUrl: 'northline.example', agentMonthlyBudgetUsd: 150 });
    await settings.inviteMember(ctx, { email: 'ava@northline.test', role: 'marketing' });
  });

  // Roster and catalogue.
  const A = await as(async (ctx) => {
    const out: Record<string, string> = {};
    for (const [name, status, country, payoutMethod, rosterSince] of [
      ['Mara Ellis', 'active', 'NL', 'bank', '2024-03-01'],
      ['Juno Vale', 'active', 'GB', 'paypal', '2023-09-15'],
      ['Kofi Brandt', 'active', 'DE', 'none', '2025-01-10'],
      ['Selene Park', 'onboarding', 'US', 'none', null],
      ['The Low Tides', 'prospect', 'IE', 'none', null],
    ] as const)
      out[name] = (await people.createArtist(ctx, { name, status, country, payoutMethod, rosterSince })).id;
    return out;
  });

  const R = await as(async (ctx) => {
    const out: Record<string, string> = {};
    const rel = async (title: string, type: 'single' | 'ep' | 'album', artist: string, releaseDate: string | null, status: 'collecting' | 'scheduled' | 'live', upc: string | null, catalogNumber: string | null, tracks: Array<[string, string | null, number]>) => {
      const r = await catalogue.createRelease(ctx, { title, type, releaseDate, status, upc, catalogNumber, labelName: 'Northline Records', distributor: 'DistroKid', artistIds: [A[artist]] });
      out[title] = r.id;
      for (const [t, isrc, durationMs] of tracks) await catalogue.createTrack(ctx, { title: t, isrc, durationMs, artistIds: [A[artist]], releaseId: r.id });
    };
    await rel('Tidewater', 'single', 'Mara Ellis', day(44), 'scheduled', null, 'NLR-031', [['Tidewater', 'NLA1Z2600123', 214000]]);
    await rel('Night Ferries', 'ep', 'Juno Vale', day(-40), 'live', '724384960650', 'NLR-028', [['Night Ferries', 'GBNLR2600011', 198000], ['Harbour Lights', 'GBNLR2600012', 232000], ['Low Water', null, 187000]]);
    await rel('Concrete Bloom', 'album', 'Kofi Brandt', day(-150), 'live', null, 'NLR-024', [['Concrete Bloom', 'DENLR2600101', 241000], ['Glasshouse', 'DENLR2600102', 205000]]);
    await rel('First Light', 'single', 'Selene Park', null, 'collecting', null, null, []);
    await catalogue.createDemo(ctx, { title: 'Salt Roads (rough mix)', artistName: 'The Low Tides', submitterEmail: 'band@lowtides.test', links: ['https://soundcloud.com/lowtides/salt-roads'], genre: 'indie folk', notes: 'Met them at the Whelan’s showcase.' });
    await catalogue.createDemo(ctx, { title: 'Nightbus', artistName: 'Ilo', submitterEmail: 'ilo@music.test', links: ['https://soundcloud.com/ilo/nightbus'], genre: 'electronic' });
    return out;
  });

  // A distributor statement: parsed and matched to tracks by the worker.
  await as((ctx) =>
    documents.uploadDocument(
      ctx,
      {
        name: 'distrokid-last-6-months.csv',
        mime: 'text/csv',
        body: Buffer.from(
          sampleStatement([
            { title: 'Night Ferries', artist: 'Juno Vale', isrc: 'GBNLR2600011', weight: 1.4 },
            { title: 'Harbour Lights', artist: 'Juno Vale', isrc: 'GBNLR2600012', weight: 0.6 },
            { title: 'Concrete Bloom', artist: 'Kofi Brandt', isrc: 'DENLR2600101', weight: 1 },
            { title: 'Glasshouse', artist: 'Kofi Brandt', isrc: 'DENLR2600102', weight: 0.5 },
          ]),
        ),
      },
      { type: 'statement', title: 'DistroKid · last 6 months' },
    ),
  );

  // Network and a live campaign with its creator board.
  await as(async (ctx) => {
    const creators = [];
    for (const [name, handle, audienceSize, rateCents, payoutEmail, verified, genres] of [
      ['Ola Hart', 'olahart', 240000, 30000, 'ola@pay.test', true, ['indie', 'alt']],
      ['Mika Sun', 'mikasun', 1200000, 90000, 'mika@pay.test', true, ['pop']],
      ['Dee Rowe', 'deerowe', 85000, 12000, null, false, ['indie']],
      ['Theo Lane', 'theolane', 410000, 45000, 'theo@pay.test', false, ['electronic']],
      ['Nova Kay', 'novakay', 300000, 25000, 'nova@pay.test', true, ['indie']],
    ] as const) {
      const c = await network.createContact(ctx, { type: 'creator', name, handles: { tiktok: handle, instagram: handle }, audienceSize, rateCents, payoutEmail, genres: [...genres], stage: 'engaged' });
      if (verified) await network.setAccountState(ctx, c.id, 'verified');
      creators.push(c);
    }
    const editor = await network.createContact(ctx, { type: 'editor', name: 'Indie Finds', email: 'ed@indiefinds.test', organization: 'Indie Finds', audienceSize: 180000, genres: ['indie'] });
    const curator = await network.createContact(ctx, { type: 'curator', name: 'Late Night Drives', email: 'curator@lnd.test', audienceSize: 64000, genres: ['electronic'] });
    await network.createContact(ctx, { type: 'press', name: 'The Line Out', email: 'tips@lineout.test', organization: 'The Line Out' });
    await network.createPlaylist(ctx, { name: 'Indie Finds Weekly', platform: 'spotify', contactId: editor.id, followers: 182000, genres: ['indie'] });
    await network.createPlaylist(ctx, { name: 'Late Night Drives', platform: 'spotify', contactId: curator.id, followers: 64000, genres: ['electronic'] });

    const campaign = await marketing.createCampaign(ctx, {
      name: 'Night Ferries · creator push',
      releaseId: R['Night Ferries'],
      budgetCents: 450000,
      startDate: day(-12),
      endDate: day(18),
      status: 'active',
      goals: 'Get the hook into 40 creator posts before the EP lands on editorial playlists.',
      kpis: [
        { name: 'Creator views', target: 2_000_000, unit: 'views', metric: 'views' },
        { name: 'Posts delivered', target: 40, unit: 'posts', metric: 'posts' },
        { name: 'Playlist adds', target: 8, unit: 'adds', metric: 'adds' },
      ],
    });
    await marketing.createCampaign(ctx, { name: 'Tidewater · editorial', releaseId: R['Tidewater'], budgetCents: 120000, startDate: day(30), status: 'planning' });
    const board = await marketing.creatorBoardFor(ctx, campaign.id);
    const card = (b: Omit<Parameters<typeof marketing.createCard>[1], 'boardId'>) => marketing.createCard(ctx, { boardId: board.id, ...b });
    await card({ title: '2 TikToks with the hook', contactId: creators[0].id, stage: 'paid', offerCents: 30000, paidCents: 30000, deliverablesOrdered: 2, deliverablesDelivered: 2, measuredViews: 410000 });
    await card({ title: 'Dance trend kickoff', contactId: creators[1].id, stage: 'paid', offerCents: 90000, paidCents: 90000, deliverablesOrdered: 1, deliverablesDelivered: 1, measuredViews: 1250000 });
    await card({ title: '3 posts: car singalong', contactId: creators[3].id, stage: 'posted', offerCents: 45000, paidCents: 45000, deliverablesOrdered: 3, deliverablesDelivered: 1 });
    await card({ title: 'Story + reel', contactId: creators[2].id, stage: 'booked', offerCents: 12000, deliverablesOrdered: 2, dueDate: day(4) });
    await card({ title: 'Duet with the artist', contactId: creators[4].id, stage: 'prospect' });
    await marketing.createPitch(ctx, { contactId: editor.id, campaignId: campaign.id, subject: 'Night Ferries for Indie Finds Weekly', body: "Hi! Juno Vale's new EP Night Ferries is out now and the title track is picking up with creators. Private link below if you'd like a listen." });
    await marketing.createSketchboard(ctx, { name: 'Night Ferries rollout', campaignId: campaign.id });
  });

  // Agents from their types (schedules included). They need an Anthropic key to run.
  await as(async (ctx) => {
    for (const type of ['label-manager', 'playlist-outreach', 'stream-watch']) await agents.createAgentFromType(ctx, type);
    await agents.remember(ctx, null, { content: 'Never pitch to playlists that charge for placement.', kind: 'preference', importance: 1, scope: 'org' });
    await agents.remember(ctx, null, { content: 'Sam wants briefings as five bullets at most, money first.', kind: 'preference', importance: 0.9, scope: 'org' });
  });

  console.log(`[db:seed] created "${org.name}" — sign in as ${EMAIL} / ${PASSWORD}`);
  console.log('[db:seed] start the worker to parse the statement, register tracks for stream tracking and schedule agents');
}

try {
  await seed();
} finally {
  await closeQueues();
  await closeDb();
  await closeRedis();
}

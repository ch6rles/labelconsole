import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import './modules';
import { setApifyFactory } from '@labelconsole/core/apify';
import { closeDb } from '@labelconsole/core/db/client';
import { ProviderError, ValidationError } from '@labelconsole/core/errors';
import type { LlmContentBlock, LlmProvider, LlmRequest } from '@labelconsole/core/llm';
import { logger } from '@labelconsole/core/logger';
import { toolByName } from '@labelconsole/core/modules';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import type { ToolContext } from '@labelconsole/core/tools';
import { monthUsage, setLlmProviderFactory } from '@labelconsole/core/usage';
import { jobs as agentJobs } from '@labelconsole/agents/jobs/index';
import * as agentsSvc from '@labelconsole/agents/service';
import { listFolder } from '@labelconsole/drive/service';
import { createContact } from '@labelconsole/network/service';
import { FakeApify } from './fake-apify';
import { makeOrg, runJob, type TestOrg } from './helpers';

/* Images are "downloaded" here: the real downloader only reaches the public internet. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
vi.mock('@labelconsole/core/net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@labelconsole/core/net')>();
  const { ValidationError: VE } = await import('@labelconsole/core/errors');
  return {
    ...actual,
    fetchPublicFile: vi.fn(async (url: string) => {
      if (!actual.isPublicHttps(url)) throw new VE('Only public https:// links can be downloaded');
      if (url.includes('broken')) throw new VE('cdn.example.com answered 404');
      return { body: PNG, contentType: 'image/png', finalUrl: url };
    }),
  };
});

afterAll(async () => {
  setApifyFactory(null);
  setLlmProviderFactory(null);
  await closeQueues();
  await closeDb();
  await closeRedis();
});
afterEach(() => {
  setApifyFactory(null);
  setLlmProviderFactory(null);
});

function useApify() {
  const fake = new FakeApify();
  setApifyFactory(async () => fake);
  return fake;
}

/** Call a tool the way the runtime does, as the label's owner. */
function toolCtx(a: TestOrg): ToolContext {
  return { orgId: a.org.id, agentId: 'test', runId: 'test', stepId: '', idempotencyKey: 'k', signal: new AbortController().signal, log: logger, withOrg: (fn) => a.as(fn), credential: async () => null };
}
async function callTool<T = Record<string, any>>(a: TestOrg, name: string, input: unknown): Promise<T> {
  const tool = toolByName(name)!;
  return (await tool.execute(toolCtx(a), tool.input.parse(input))) as T;
}

describe('social research tools', () => {
  it('reads TikTok profiles: Actor input, analysis, network match and usage', async () => {
    const a = await makeOrg();
    await a.as((ctx) => createContact(ctx, { type: 'creator', name: 'Khaby', handles: { tiktok: '@Khaby.Lame' }, stage: 'engaged', rateCents: 50_000 }));
    const fake = useApify();
    const out = await callTool(a, 'social_tiktok_profile', { handles: ['https://www.tiktok.com/@khaby.lame', 'ghost_account'], priceUsd: 500 });
    expect(fake.runs[0]).toMatchObject({ actor: 'clockworks/tiktok-scraper', input: { profiles: ['khaby.lame', 'ghost_account'], resultsPerPage: 12, profileSorting: 'latest' }, maxItems: 24 });
    const [c] = out.creators;
    expect(c).toMatchObject({ handle: 'khaby.lame', followers: 163_000_000, inNetwork: { name: 'Khaby', stage: 'engaged', rate: '500.00 USD', doNotContact: false } });
    expect(c.analysis).toMatchObject({ medianViews: 2_200_000, sponsoredPosts: 1, costPer1kViewsUsd: 0.23 });
    expect(c.analysis.signals.join(' ')).toMatch(/Weak reach/);
    expect(c.recentPosts[0]).toMatchObject({ views: 2_100_000, postedAt: '2026-10-01' });
    // Images only when asked for: links are long and only needed for saving.
    expect(c.recentPosts[0].thumbnailUrl).toBeUndefined();
    expect(out.notFound).toEqual(['ghost_account']);
    expect(await a.as((ctx) => monthUsage(ctx, 'apify_results'))).toBe(4);
  });

  it('searches TikTok creators and videos with the right search section and filters', async () => {
    const a = await makeOrg();
    const fake = useApify();
    const creators = await callTool(a, 'social_tiktok_search', { query: 'funk edit', limit: 4 });
    expect(fake.runs[0].input).toEqual({ searchQueries: ['funk edit'], searchSection: '/user', maxProfilesPerQuery: 4, resultsPerPage: 1 });
    expect(creators.creators.map((c: { handle: string }) => c.handle)).toEqual(['editor_1', 'editor_2', 'editor_3', 'editor_4']);
    const videos = await callTool(a, 'social_tiktok_search', { query: 'funk edit', find: 'videos', period: 'week', sort: 'most_liked', includeImages: true });
    expect(fake.runs[1].input).toMatchObject({ searchSection: '/video', videoSearchSorting: 'MOST_LIKED', videoSearchDateFilter: 'PAST_WEEK' });
    expect(videos.creators.at(-1).matchingVideos[0]).toMatchObject({ views: 337_616, thumbnailUrl: expect.stringMatching(/^https:\/\//) });
    await callTool(a, 'social_tiktok_search', { query: '#FunkEdit', find: 'hashtag', limit: 5 });
    expect(fake.runs[2].input).toEqual({ hashtags: ['FunkEdit'], resultsPerPage: 5 });
  });

  it('searches an Instagram hashtag and reads Instagram profiles', async () => {
    const a = await makeOrg();
    const fake = useApify();
    const tag = await callTool(a, 'social_instagram_search', { query: '#funkedit', limit: 10 });
    expect(fake.runs[0].input).toEqual({ directUrls: ['https://www.instagram.com/explore/tags/funkedit/'], resultsType: 'posts', resultsLimit: 10 });
    expect(tag.accounts[1]).toMatchObject({ handle: 'editor_12', postsInSample: 5 });
    expect(await callTool(a, 'social_instagram_search', { query: 'funk edit!!' })).toEqual({ error: 'A hashtag can only contain letters, numbers and underscores' });

    const prof = await callTool(a, 'social_instagram_profile', { handles: ['@natgeo'] });
    expect(fake.runs[1].input).toEqual({ directUrls: ['https://www.instagram.com/natgeo/'], resultsType: 'details' });
    expect(prof.creators[0]).toMatchObject({ handle: 'natgeo', followers: 268_462_733, category: undefined, inNetwork: null });
    expect(prof.creators[0].recentPosts).toHaveLength(10);
    expect(prof.creators[0].analysis.postsPerWeek).toBe(28);
  });

  it('reads YouTube channels and searches with an upload-date filter only when asked', async () => {
    const a = await makeOrg();
    const fake = useApify();
    const ch = await callTool(a, 'social_youtube_profile', { channels: ['@mkbhd'], videos: 6 });
    expect(fake.runs[0]).toMatchObject({ actor: 'streamers/youtube-scraper', input: { startUrls: [{ url: 'https://www.youtube.com/@mkbhd' }], maxResults: 6, maxResultsShorts: 3, sortVideosBy: 'NEWEST' }, maxItems: 9 });
    expect(ch.creators[0]).toMatchObject({ handle: 'mkbhd', followers: 21_300_000, totalViews: 5_726_706_783 });
    expect(ch.notFound).toBeUndefined();
    await callTool(a, 'social_youtube_search', { query: 'funk edit audios' });
    expect(fake.runs[1].input).not.toHaveProperty('dateFilter');
    const s = await callTool(a, 'social_youtube_search', { query: 'funk edit audios', period: 'week', sort: 'views' });
    expect(fake.runs[2].input).toMatchObject({ dateFilter: 'week', sortingOrder: 'views' });
    expect(s.channels.map((c: { followers: number }) => c.followers)).toEqual([28_600, 21_600, 7520, 21_000]);
  });

  it('refuses bad handles without paying for a scrape, explains a missing token, and never retries a failed scrape', async () => {
    const a = await makeOrg();
    const fake = useApify();
    expect(await callTool(a, 'social_tiktok_profile', { handles: ['not a handle!'] })).toEqual({ error: 'Not a TikTok handle: not a handle!' });
    expect(fake.runs).toHaveLength(0);

    fake.failWith = new ProviderError('apify', 'HTTP 502', { status: 502 });
    const err = await callTool(a, 'social_youtube_search', { query: 'x y' }).catch((e: unknown) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.transient).toBe(false);
    expect(err.message).toMatch(/youtube scrape did not finish/);

    setApifyFactory(async () => null);
    await expect(callTool(a, 'social_tiktok_search', { query: 'funk' })).rejects.toThrow(/No Apify token is configured/);
  });
});

/* A scripted model for tests only: production always talks to Claude. */
class StubProvider implements LlmProvider {
  readonly id = 'stub';
  calls: LlmRequest[] = [];
  constructor(private script: (req: LlmRequest, n: number) => LlmContentBlock[]) {}
  async chat(req: LlmRequest) {
    this.calls.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })));
    const out = this.script(req, this.calls.length);
    return { id: `msg_${this.calls.length}`, model: req.model, content: out, stopReason: out.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 }, stopDetails: null };
  }
  async extract(): Promise<never> {
    throw new Error('not used');
  }
}
const say = (text: string) => ({ type: 'text', text, citations: null }) as unknown as LlmContentBlock;
const call = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as LlmContentBlock;
const lastResult = (req: LlmRequest) => {
  const last = req.messages.at(-1)!;
  const block = (Array.isArray(last.content) ? last.content : []).find((b) => (b as { type: string }).type === 'tool_result') as { content: string; is_error?: boolean };
  return { ...block, json: JSON.parse(block.content) };
};
const toolNames = (req: LlmRequest) => req.tools.map((t) => (t as { name: string }).name);

describe('Social Scout agent', () => {
  it('limits a run to the chosen platform, judges profiles and saves images to a Drive folder', async () => {
    const a = await makeOrg();
    await a.as((ctx) => createContact(ctx, { type: 'editor', name: 'Editor Three', handles: { tiktok: 'editor_3' } }));
    const fake = useApify();
    const agent = await a.as((ctx) => agentsSvc.createAgentFromType(ctx, 'social-scout'));
    let thumbnail = '';
    const stub = new StubProvider((req, n) => {
      if (n === 1) return [call('tu_1', 'social_tiktok_search', { query: 'funk edit', limit: 4 })];
      if (n === 2) {
        const r = lastResult(req).json;
        expect(r.creators.find((c: { handle: string }) => c.handle === 'editor_3').inNetwork).toMatchObject({ name: 'Editor Three' });
        return [call('tu_2', 'social_tiktok_profile', { handles: ['khaby.lame'], priceUsd: 500, includeImages: true })];
      }
      if (n === 3) {
        thumbnail = lastResult(req).json.creators[0].recentPosts[0].thumbnailUrl;
        return [call('tu_3', 'drive_save_images', { folder: 'Research / Funk editors', images: [{ url: thumbnail, name: 'khaby latest' }, { url: 'https://cdn.example.com/broken.jpg' }] })];
      }
      return [say('khaby.lame: watch. Huge but weak reach (1.3% of followers per post).')];
    });
    setLlmProviderFactory(async () => stub);

    const run = await a.as((ctx) => agentsSvc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Find funk editors worth a promo', input: { platforms: ['tiktok'] } }));
    expect(await runJob(agentJobs, 'agents.run', a.org.id, { runId: run.id }, { attempts: 5 })).toEqual({ status: 'completed' });

    // Only TikTok's tools were offered, and the model was told why.
    const offered = toolNames(stub.calls[0]);
    expect(offered).toEqual(expect.arrayContaining(['social_tiktok_search', 'social_tiktok_profile', 'drive_save_images', 'network_add_contact']));
    expect(offered.filter((n) => /instagram|youtube/.test(n))).toEqual([]);
    expect(JSON.stringify(stub.calls[0].messages[0])).toContain('Platforms: research TikTok only');
    expect(fake.runs.map((r) => r.actor)).toEqual(['clockworks/tiktok-scraper', 'clockworks/tiktok-scraper']);

    const saved = lastResult(stub.calls[3]).json;
    expect(saved.saved).toEqual([expect.objectContaining({ name: 'khaby latest.png' })]);
    expect(saved.failed).toEqual([{ url: 'https://cdn.example.com/broken.jpg', error: 'cdn.example.com answered 404' }]);
    const folder = await a.as(async (ctx) => {
      const root = await listFolder(ctx, null);
      const research = root.folders.find((f) => f.name === 'Research')!;
      const funk = (await listFolder(ctx, research.id)).folders.find((f) => f.name === 'Funk editors')!;
      return listFolder(ctx, funk.id);
    });
    expect(folder.files.map((f) => [f.name, f.mime])).toEqual([['khaby latest.png', 'image/png']]);
    expect((await a.as((ctx) => agentsSvc.getRun(ctx, run.id))).run.result).toMatch(/khaby.lame: watch/);

    // Without a platform choice, every platform's tools are offered.
    const stub2 = new StubProvider(() => [say('ok')]);
    setLlmProviderFactory(async () => stub2);
    const run2 = await a.as((ctx) => agentsSvc.startRun(ctx, { agentId: agent.id, triggerKind: 'manual', task: 'Look around' }));
    await runJob(agentJobs, 'agents.run', a.org.id, { runId: run2.id }, { attempts: 5 });
    expect(toolNames(stub2.calls[0])).toEqual(expect.arrayContaining(['social_tiktok_search', 'social_instagram_search', 'social_youtube_profile']));
  });

  it('creates a custom agent with the tools a person picks', async () => {
    const a = await makeOrg();
    const agent = await a.as((ctx) => agentsSvc.createAgentFromType(ctx, 'custom', { name: 'Image grabber' }));
    expect(agent.toolAllowlist).toEqual(expect.arrayContaining(['drive_save_images', 'social_instagram_profile']));
    const narrowed = await a.as((ctx) => agentsSvc.updateAgent(ctx, agent.id, { toolAllowlist: ['social_instagram_profile', 'drive_save_images'], instructions: 'Save the profile pictures of the accounts in the task to Drive.' }));
    expect(narrowed.toolAllowlist).toEqual(['social_instagram_profile', 'drive_save_images']);
    await expect(a.as((ctx) => agentsSvc.updateAgent(ctx, agent.id, { toolAllowlist: ['social_myspace_profile'] }))).rejects.toBeInstanceOf(ValidationError);
  });
});

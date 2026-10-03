import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApifyClient } from '@labelconsole/core/apify';

const FIXTURES = join(__dirname, '../modules/network/social/__fixtures__');
export const apifyFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown[];

/**
 * An Apify client that answers from recorded scraper output instead of the
 * network (tests only). It records each run and counts results like the real one.
 */
export class FakeApify extends ApifyClient {
  runs: Array<{ actor: string; input: Record<string, unknown>; maxItems: number }> = [];
  /** Items to return for an Actor, overriding the recorded social fixtures. */
  answers = new Map<string, unknown[]>();
  failWith: Error | null = null;
  constructor() {
    super('test-token');
  }
  override async run<T>(actor: string, input: Record<string, unknown>, opts: { maxItems: number }): Promise<T[]> {
    this.runs.push({ actor, input, maxItems: opts.maxItems });
    if (this.failWith) throw this.failWith;
    const items = this.answer(actor, input).slice(0, opts.maxItems);
    this.results += items.length;
    return items as T[];
  }
  private answer(actor: string, input: Record<string, unknown>): unknown[] {
    if (this.answers.has(actor)) return this.answers.get(actor)!;
    if (actor === 'clockworks/tiktok-scraper') {
      if (input.profiles) return apifyFixture('tiktok-profile');
      return apifyFixture(input.searchSection === '/user' ? 'tiktok-user-search' : 'tiktok-video-search');
    }
    if (actor === 'apify/instagram-scraper') return apifyFixture(input.resultsType === 'details' ? 'instagram-details' : 'instagram-hashtag');
    if (actor === 'streamers/youtube-scraper') return apifyFixture(input.startUrls ? 'youtube-channel' : 'youtube-search');
    return [];
  }
}

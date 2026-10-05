import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createTrack } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg, runJob } from '../../test/helpers';
import { makeXlsx } from '../../test/xlsx';
import { jobs } from './jobs';
import { documents, statementLines, type StatementSummary } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER = ['Track', 'Artist', 'Release', 'Label', 'Release Type', 'UPC', 'Catalog #', 'ISRC', 'Period', 'DSP', 'Territory', 'Streams', 'Revenue', 'Currency'];
const row = (store: string, country: string, streams: number, revenue: number) => ['Night Drive', 'Mara Ellis', 'Night Drive', 'Northline', 'Single', 5061108280999, null, 'NLA1Z2600123', '2026-06-01 – 2026-07-31', store, country, streams, revenue, 'EUR'];

describe('Statements from .xlsx', () => {
  it('imports a detailed report end to end and refuses a summary with a clear reason', async () => {
    const a = await makeOrg('Xlsx Label');
    const track = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Mara Ellis', status: 'active' });
      return createTrack(ctx, { title: 'Night Drive', isrc: 'NLA1Z2600123', artistIds: [artist.id] });
    });
    // An earlier statement in another currency (another distributor's) is not a like-for-like comparison.
    await a.as((ctx) =>
      ctx.tx.insert(documents).values({
        type: 'statement',
        title: 'DistroKid Jul 2026',
        extractionStatus: 'done',
        extractedTerms: { distributor: null, periodStart: '2026-07-01', periodEnd: '2026-07-31', currency: 'USD', lineCount: 700, grossCents: 1_250_000, netCents: 1_246_205, units: 3_800_000, bySource: [], anomalies: [] } satisfies StatementSummary,
      }),
    );
    const detailed = makeXlsx([{ name: 'By Track', rows: [HEADER, row('Spotify', 'DE', 12_000, 41.27), row('Apple Music', 'US', 900, 6.1), ['Rounding Adjustment', null, null, null, null, null, null, null, null, null, null, null, -0.41, 'EUR']] }]);
    const doc = await a.as((ctx) => svc.uploadDocument(ctx, { name: 'PAY-000001-detailed.xlsx', mime: XLSX, body: detailed }, { type: 'statement' }));
    await runJob(jobs, 'documents.parse-statement', a.org.id, { documentId: doc.id });

    const [done] = await a.as((ctx) => ctx.tx.select().from(documents).where(eq(documents.id, doc.id)));
    expect(done.extractionError).toBeNull();
    expect(done.extractionStatus).toBe('done');
    expect(done.extractedTerms as StatementSummary).toMatchObject({ periodStart: '2026-06-01', periodEnd: '2026-07-31', currency: 'EUR', lineCount: 3, netCents: 4127 + 610 - 41, units: 12_900, anomalies: [] });
    const lines = await a.as((ctx) => ctx.tx.select().from(statementLines).where(eq(statementLines.documentId, doc.id)));
    expect(lines.filter((l) => l.trackId === track.id).map((l) => [l.source, l.territory, l.units, l.netCents])).toEqual([
      ['Spotify', 'DE', 12_000, 4127],
      ['Apple Music', 'US', 900, 610],
    ]);

    const summary = makeXlsx([{ name: 'Summary', rows: [[], ['Example Records — Royalty Statement'], [], ['Total Royalties', 48.99], [], ['Track', 'Release', 'ISRC', 'Streams', 'Revenue'], ['Night Drive', 'Night Drive', 'NLA1Z2600123', '12,900', 47.37]] }]);
    const wrong = await a.as((ctx) => svc.uploadDocument(ctx, { name: 'PAY-000001-summary.xlsx', mime: XLSX, body: summary }, { type: 'statement' }));
    await runJob(jobs, 'documents.parse-statement', a.org.id, { documentId: wrong.id });
    const [failed] = await a.as((ctx) => ctx.tx.select().from(documents).where(eq(documents.id, wrong.id)));
    expect(failed.extractionStatus).toBe('failed');
    expect(failed.extractionError).toMatch(/summary report.*detailed \(line-by-line\) report/);
  });
});

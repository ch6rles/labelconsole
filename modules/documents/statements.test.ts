import { describe, expect, it } from 'vitest';
import { canonicalSource, mapColumns, parseAmount, parsePeriod, parseStatementCsv, summarize } from './statements';

// Header row as DistroKid exports it.
const DISTROKID = `Reporting Date,Sale Month,Store,Artist,Title,ISRC,UPC,Quantity,Team Percentage,Song/Album,Country of Sale,Songwriter Royalties Withheld,Earnings (USD)
2026-08-25,2026-07,Spotify,Mara Ellis,Tidewater,NLA1Z2600123,0724384960650,10234,100,Song,NL,0,31.45
2026-08-25,2026-07,Apple Music,Mara Ellis,Tidewater,NLA1Z2600123,0724384960650,2100,100,Song,US,0,16.80
2026-08-25,2026-07,YouTube (Red),Mara Ellis,Tidewater,NL-A1Z-26-00123,0724384960650,800,100,Song,DE,0,1.20
2026-08-25,2026-07,iTunes,Mara Ellis,Tidewater,NLA1Z2600123,0724384960650,-1,100,Song,US,0,-0.69
2026-08-25,2026-07,Spotify,Mara Ellis,Tidewater,NLA1Z2600123,0724384960650,0,100,Song,FR,0,0
`;

describe('statement parsing', () => {
  it('maps distributor headers by name', () => {
    const cols = mapColumns(DISTROKID.split('\n')[0].split(','));
    expect(cols).toMatchObject({ isrc: 'ISRC', upc: 'UPC', title: 'Title', source: 'Store', territory: 'Country of Sale', units: 'Quantity', net: 'Earnings (USD)', period: 'Sale Month' });
  });

  it('parses amounts in both decimal conventions and accounting negatives', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('$12.30')).toBe(12.3);
    expect(parseAmount('(4.10)')).toBe(-4.1);
    expect(parseAmount('€ 0,0042')).toBe(0.0042);
    expect(parseAmount('')).toBe(0);
  });

  it('parses month periods in the common formats', () => {
    expect(parsePeriod('2026-07')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(parsePeriod('07/2026')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(parsePeriod('July 2026')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(parsePeriod('202602')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(parsePeriod('31/07/2026')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(parsePeriod('soon')).toBeNull();
  });

  it('canonicalises store names', () => {
    expect(canonicalSource('iTunes')).toBe('Apple Music');
    expect(canonicalSource('YouTube (Red)')).toBe('YouTube');
    expect(canonicalSource('Resso')).toBe('TikTok');
    expect(canonicalSource('Anghami')).toBe('Anghami');
  });

  it('turns a DistroKid CSV into lines and skips empty rows', () => {
    const { lines, skipped } = parseStatementCsv(DISTROKID);
    expect(skipped).toBe(1);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ periodStart: '2026-07-01', periodEnd: '2026-07-31', source: 'Spotify', territory: 'NL', isrc: 'NLA1Z2600123', upc: '0724384960650', trackTitle: 'Tidewater', units: 10234, grossCents: 3145, netCents: 3145, currency: 'USD' });
    expect(lines[2].isrc).toBe('NLA1Z2600123'); // dashes stripped
    expect(lines[3]).toMatchObject({ source: 'Apple Music', units: -1, netCents: -69 });
  });

  it('rejects files without a revenue column', () => {
    expect(() => parseStatementCsv('ISRC,Store\nNLA1Z2600123,Spotify\n')).toThrow(/revenue column/);
  });

  it('summarises totals and flags anomalies', () => {
    const { lines } = parseStatementCsv(DISTROKID);
    const s = summarize(lines, { distributor: 'DistroKid', unmatchedIsrcs: 1, previousNetCents: 10_000 });
    expect(s).toMatchObject({ distributor: 'DistroKid', periodStart: '2026-07-01', periodEnd: '2026-07-31', currency: 'USD', lineCount: 4, netCents: 4876, units: 13133 });
    expect(s.bySource[0]).toEqual({ source: 'Spotify', netCents: 3145, units: 10234 });
    expect(s.anomalies).toEqual(['1 line with negative revenue (returns or chargebacks)', '1 ISRC not in the catalogue', 'Net revenue is 51% below the previous statement']);
  });

  it('flags duplicates and mixed currencies', () => {
    const { lines } = parseStatementCsv('ISRC,Store,Net,Currency,Units\nNLA1Z2600123,Spotify,1.00,USD,10\nNLA1Z2600123,Spotify,1.00,USD,10\nNLA1Z2600123,Deezer,2.00,EUR,10\n');
    const s = summarize(lines, { distributor: null, unmatchedIsrcs: 0 });
    expect(s.anomalies).toEqual(['1 duplicate line', 'Mixed currencies: USD, EUR']);
  });
});

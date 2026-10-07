import { describe, expect, it } from 'vitest';
import { makeXlsx, zip } from '../../test/xlsx';
import { fileKind, unsupportedReason } from './kinds';
import { buildPreview, csvPreview, decodeText, docxPreview, looksLikeText, pptxPreview, readPlan, xlsxPreview, zipPreview, type Preview } from './preview';

const pick = <K extends Preview['kind']>(p: Preview, kind: K) => {
  expect(p.kind).toBe(kind);
  return p as Extract<Preview, { kind: K }>;
};

describe('file kinds', () => {
  it('decides by extension first, so agent Markdown saved as text/plain still renders', () => {
    expect(fileKind('Release brief.md', 'text/plain')).toBe('markdown');
    expect(fileKind('sync.ts', 'video/mp2t')).toBe('code');
    expect(fileKind('statement.XLSX', 'application/octet-stream')).toBe('sheet');
    expect(fileKind('deck.pptx', '')).toBe('slides');
    expect(fileKind('font.woff2', null)).toBe('font');
  });

  it('falls back to the type when the name has no telling extension', () => {
    expect(fileKind('scan', 'application/pdf')).toBe('pdf');
    expect(fileKind('voice memo', 'audio/x-m4a')).toBe('audio');
    expect(fileKind('export', 'text/csv')).toBe('sheet');
    expect(fileKind('data', 'application/vnd.api+json')).toBe('code');
    expect(fileKind('README', 'text/plain')).toBe('text');
    expect(fileKind('blob.bin', 'application/octet-stream')).toBe('other');
  });

  it('explains the formats it cannot show', () => {
    expect(unsupportedReason('old contract.doc')).toMatch(/\.docx/);
    expect(unsupportedReason('stems.rar')).toMatch(/zip/);
    expect(unsupportedReason('contract.docx')).toBeNull();
  });
});

describe('text previews', () => {
  it('reads UTF-8, byte-order marks and old Windows text', () => {
    expect(decodeText(Buffer.from('Café — Zoë', 'utf8'), true)).toEqual({ text: 'Café — Zoë', encoding: 'UTF-8' });
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]), true).text).toBe('hi');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')]), true)).toEqual({ text: 'hé', encoding: 'UTF-16' });
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]), true)).toEqual({ text: 'Café', encoding: 'Windows-1252' });
  });

  it('drops a character cut in half at the end of a partial read instead of giving up on UTF-8', () => {
    const cut = Buffer.from('ok é', 'utf8').subarray(0, 4); // "ok " plus the first byte of é
    expect(decodeText(cut, false)).toEqual({ text: 'ok ', encoding: 'UTF-8' });
  });

  it('opens files of unknown type as text when they are text', async () => {
    expect(looksLikeText(Buffer.from('plain words\nand lines\n'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(false);
    expect((await buildPreview('other', 'LICENSE', Buffer.from('MIT License'), true)).kind).toBe('text');
    const bin = pick(await buildPreview('other', 'a.bin', Buffer.from([0, 1, 2, 255]), true), 'binary');
    expect(bin).toEqual({ kind: 'binary', hex: '000102ff', bytes: 4 });
  });

  it('reads only the start of large text, but Office files whole', () => {
    expect(readPlan('markdown', 'a.md')).toEqual({ bytes: 1024 * 1024, whole: false });
    expect(readPlan('sheet', 'a.csv').whole).toBe(false);
    expect(readPlan('sheet', 'a.xlsx').whole).toBe(true);
    expect(readPlan('archive', 'a.zip').whole).toBe(true);
  });
});

describe('spreadsheet previews', () => {
  it('parses CSV with quoted commas and TSV, trimming empty trailing rows', () => {
    const csv = pick(csvPreview(Buffer.from('Store,Country,Plays\nSpotify,"Korea, Republic of",75\n\n\n'), true, 'royalties.csv'), 'sheet');
    expect(csv.sheets[0]).toMatchObject({ name: 'royalties', totalRows: 2, totalCols: 3, truncated: false });
    expect(csv.sheets[0].rows[1]).toEqual(['Spotify', 'Korea, Republic of', '75']);
    const tsv = pick(csvPreview(Buffer.from('a\tb\n1\t2'), true, 'x.tsv'), 'sheet');
    expect(tsv.sheets[0].rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('drops the half row at the end of a cut-off CSV and says it is cut off', () => {
    const p = pick(csvPreview(Buffer.from('a,b\n1,2\n3,'), false, 'big.csv'), 'sheet');
    expect(p.sheets[0].rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(p.sheets[0].truncated).toBe(true);
  });

  it('shows every sheet of a workbook', () => {
    const buf = makeXlsx([
      { name: 'Detailed', rows: [['Date', 'Plays'], [new Date(Date.UTC(2026, 7, 1)), 1520]] },
      { name: 'Summary', rows: [['Total', 1520]] },
    ]);
    const p = pick(xlsxPreview(buf), 'sheet');
    expect(p.sheets.map((s) => s.name)).toEqual(['Detailed', 'Summary']);
    expect(p.sheets[0].rows[1]).toEqual(['2026-08-01', 1520]);
  });
});

const PML = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const shape = (paras: Array<[string, number]>, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map(([t, lvl]) => `<a:p><a:pPr lvl="${lvl}"/><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;

describe('presentation previews', () => {
  it('lists slides in deck order with title, indented points and speaker notes', () => {
    const buf = zip([
      ['ppt/presentation.xml', `<p:presentation ${PML}><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
      ['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']])],
      ['ppt/slides/slide1.xml', `<p:sld ${PML}><p:cSld><p:spTree>${shape([['Budget', 0]], 'title')}${shape([['Ads: $600', 0], ['Meta &amp; TikTok', 1]], 'body')}</p:spTree></p:cSld></p:sld>`],
      ['ppt/slides/_rels/slide1.xml.rels', rels([['rIdN', 'notesSlide', '../notesSlides/notesSlide1.xml']])],
      ['ppt/notesSlides/notesSlide1.xml', `<p:notes ${PML}><p:cSld><p:spTree>${shape([['3', 0]], 'sldNum')}${shape([['Ask about playlists', 0]], 'body')}</p:spTree></p:cSld></p:notes>`],
      ['ppt/slides/slide2.xml', `<p:sld ${PML}><p:cSld><p:spTree>${shape([['Launch', 0]], 'ctrTitle')}</p:spTree></p:cSld></p:sld>`],
    ]);
    const p = pick(pptxPreview(buf), 'slides');
    expect(p.slides.map((s) => s.title)).toEqual(['Launch', 'Budget']);
    expect(p.slides[1].paragraphs).toEqual([
      { text: 'Ads: $600', level: 0 },
      { text: 'Meta & TikTok', level: 1 },
    ]);
    expect(p.slides[1].notes).toBe('Ask about playlists');
    expect(p.slides[0].notes).toBeNull();
  });

  it('says so when a file is not really a deck', () => {
    expect(() => pptxPreview(Buffer.from('not a zip'))).toThrow(/not an? \.pptx file/);
  });
});

describe('Word and zip previews', () => {
  it('turns a Word document into HTML without scripts', async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const buf = zip([
      ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
      ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']])],
      ['word/document.xml', `<w:document ${W}><w:body><w:p><w:r><w:t>Recording agreement</w:t></w:r></w:p><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>`],
    ]);
    const p = pick(await docxPreview(buf), 'document');
    expect(p.html).toContain('<p>Recording agreement</p>');
    expect(p.html).not.toContain('<script>');
  });

  it('lists a zip, leaving out macOS clutter', () => {
    const buf = zip([
      ['stems/kick.wav', 'RIFF'],
      ['__MACOSX/stems/._kick.wav', 'x'],
      ['stems/.DS_Store', 'x'],
    ]);
    const p = pick(zipPreview(buf), 'archive');
    expect(p.entries.map((e) => e.name)).toEqual(['stems/kick.wav']);
    expect(p).toMatchObject({ total: 1, totalSize: 4 });
  });
});

import { describe, expect, it } from 'vitest';
import { makeXlsx, zip } from '../../../test/xlsx';
import { isXlsx, readXlsx } from './xlsx';

const workbook = (sheets: string[]) => [
  ['xl/workbook.xml', `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets>${sheets.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="/xl/worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
] as Array<[string, string]>;

describe('readXlsx', () => {
  it('reads text, numbers, booleans and dates, keeping blank rows and cells in place', () => {
    const body = makeXlsx([
      { name: 'Statement', rows: [['Track', 'ISRC', 'Streams', 'Revenue', 'Paid', 'Date'], [], ['Rock & Roll <live>', 'NLA1Z2600777', 14, 0.03, true, new Date(Date.UTC(2026, 6, 31))], ['Quiet', null, 2, null, false, null]] },
      { name: 'Notes', rows: [['second tab']] },
    ]);
    expect(isXlsx(body)).toBe(true);
    const [first, second] = readXlsx(body);
    expect(first.name).toBe('Statement');
    expect(first.rows).toEqual([
      ['Track', 'ISRC', 'Streams', 'Revenue', 'Paid', 'Date'],
      [],
      ['Rock & Roll <live>', 'NLA1Z2600777', 14, 0.03, true, '2026-07-31'],
      ['Quiet', null, 2, null, false],
    ]);
    expect(second).toEqual({ name: 'Notes', rows: [['second tab']] });
  });

  it('reads what other tools write: inline and rich text, saved formula results, custom date formats, prefixed tags', () => {
    const body = zip([
      ...workbook(['Data']),
      ['xl/sharedStrings.xml', '<sst><si><r><t>Hard</t></r><r><t xml:space="preserve">tekk </t></r><rPh><t>ハード</t></rPh></si><si/></sst>'],
      ['xl/styles.xml', '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;€&quot;#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>'],
      [
        'xl/worksheets/sheet1.xml',
        '<x:worksheet xmlns:x="main"><x:sheetData>' +
          '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Inline &amp; co</x:t></x:is></x:c></x:row>' +
          '<x:row r="3"><x:c r="A3" s="1"><x:v>46203</x:v></x:c><x:c r="B3" s="2"><x:v>12.5</x:v></x:c><x:c r="C3" t="str"><x:f>A1&amp;"!"</x:f><x:v>Hardtekk !</x:v></x:c><x:c r="D3" t="e"><x:v>#N/A</x:v></x:c><x:c r="E3" t="s"><x:v>1</x:v></x:c></x:row>' +
          '</x:sheetData></x:worksheet>',
      ],
    ]);
    expect(readXlsx(body)[0].rows).toEqual([['Hardtekk ', null, 'Inline & co'], [], ['2026-06-30', 12.5, 'Hardtekk !']]);
  });

  it('explains files it cannot read', () => {
    expect(() => readXlsx(Buffer.from('Track,ISRC\nA,B\n'))).toThrow(/not an \.xlsx file/);
    expect(isXlsx(Buffer.from('Track,ISRC'))).toBe(false);
  });
});

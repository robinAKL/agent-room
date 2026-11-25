// Ported from the hosted deployment (#734); uses the node:zlib zip shim.
import { MiniZip as JSZip } from './_zip.js';
import { describe, expect, it } from 'vitest';
import { SpreadsheetFormatError, extractSpreadsheetText, stripWorkbookMacros } from './_spreadsheetText.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function buildXlsx(sheets: { name: string; target?: string; xml: string }[], sharedStrings: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('xl/workbook.xml',
    `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels',
    `<?xml version="1.0"?><Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"/>`).join('')}</Relationships>`);
  if (sharedStrings.length) {
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst ${NS}>${sharedStrings.map(s => `<si>${s}</si>`).join('')}</sst>`);
  }
  sheets.forEach((s, i) => {
    const path = s.target?.startsWith('/') ? s.target.slice(1) : `xl/${s.target ?? `worksheets/sheet${i + 1}.xml`}`;
    zip.file(path, `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.xml}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractSpreadsheetText', () => {
  it('turns every sheet of an .xlsx into CSV', async () => {
    const xlsx = await buildXlsx([
      {
        name: 'Q3 &amp; Q4',
        xml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
          + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1200.5</v></c><c r="C2" t="b"><v>1</v></c></row>'
          + '<row r="3"/>'
          + '<row r="4"><c r="A4" t="inlineStr"><is><t>Acme, "Ltd"</t></is></c><c r="C4"><f>SUM(B2:B3)</f><v>1200.5</v></c></row>',
      },
      { name: '汇总', target: '/xl/worksheets/summary.xml', xml: '<row r="1"><c r="B1" t="str"><v>总计</v></c><c r="D1" s="1"/></row>' },
    ], [
      '<t>Region</t>',
      '<r><t>Rev</t></r><r><t xml:space="preserve">enue</t></r>',
      '<t>Closed</t>',
      '<t>北京</t><rPh sb="0" eb="1"><t>ペキン</t></rPh>',
    ]);

    await expect(extractSpreadsheetText(xlsx, 30_000)).resolves.toBe([
      '## Sheet: Q3 & Q4',
      'Region,Revenue,Closed',
      '北京,1200.5,TRUE',
      '"Acme, ""Ltd""",,1200.5',
      '',
      '## Sheet: 汇总',
      ',总计',
    ].join('\n'));
  });

  it('reads element-prefixed XML written by the Open XML SDK', async () => {
    const xlsx = await buildXlsx([{ name: 'S', xml: '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>hi</x:t></x:is></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row>' }]);
    await expect(extractSpreadsheetText(xlsx, 30_000)).resolves.toBe('## Sheet: S\nhi,2');
  });

  it('writes date-formatted numbers as ISO dates and uncached formulas as formulas', async () => {
    const zip = await JSZip.loadAsync(await buildXlsx([{
      name: 'Dates',
      xml: '<row r="1"><c r="A1" s="1"><v>46295</v></c><c r="B1" s="2"><v>46024.5730324074</v></c><c r="C1" s="3"><v>0.354166666666667</v></c>'
        + '<c r="D1" s="4"><v>0.25</v></c><c r="E1" s="5"><v>1234.5</v></c><c r="F1"><f>A1+1</f><v></v></c></row>',
    }]));
    zip.file('xl/styles.xml', '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/>'
      + '<numFmt numFmtId="165" formatCode="#,##0.00 &quot;元&quot;"/></numFmts>'
      + '<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="22"/><xf numFmtId="21"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs></styleSheet>');
    const xlsx = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(extractSpreadsheetText(xlsx, 30_000)).resolves.toBe('## Sheet: Dates\n2026-09-30,2026-01-02 13:45:10,08:30:00,0.25,1234.5,=A1+1');
  });

  it('rounds float noise to 15 significant digits and leaves formulas that returned "" empty', async () => {
    const xlsx = await buildXlsx([{
      name: 'Totals',
      xml: '<row r="1"><c r="A1"><v>4093.6000000000004</v></c><c r="B1"><v>614.04000000000008</v></c><c r="C1"><v>212201444</v></c>'
        + '<c r="D1" t="str"><f>IF(A1="","",A1)</f><v></v></c><c r="E1"><v>-0.1</v></c></row>',
    }]);
    await expect(extractSpreadsheetText(xlsx, 30_000)).resolves.toBe('## Sheet: Totals\n4093.6,614.04,212201444,,-0.1');
  });

  it('shares the cap across sheets so a long sheet cannot hide the short ones', async () => {
    const rows = (n: number, label: string) => Array.from({ length: n }, (_, i) =>
      `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="B${i + 1}" t="inlineStr"><is><t>${label} ${i}</t></is></c></row>`).join('');
    const xlsx = await buildXlsx([
      { name: 'Orders', xml: rows(2000, 'order') },
      { name: 'Pricing', xml: rows(2000, 'price') },
      { name: 'Customers', xml: rows(3, 'customer') },
    ]);
    const text = await extractSpreadsheetText(xlsx, 2_000);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toContain('## Sheet: Customers\n0,customer 0\n1,customer 1\n2,customer 2');
    const orders = text.split('## Sheet: Orders\n')[1]!.split('\n\n')[0]!;
    const pricing = text.split('## Sheet: Pricing\n')[1]!.split('\n\n')[0]!;
    expect(orders.endsWith('… (sheet truncated)')).toBe(true);
    expect(pricing.endsWith('… (sheet truncated)')).toBe(true);
    // The two long sheets split what the short one left over, and together use most of the cap.
    expect(Math.abs(orders.length - pricing.length)).toBeLessThan(40);
    expect(text.length).toBeGreaterThan(1_800);
  });

  it('reads worksheets only, never Excel 4.0 macro sheets', async () => {
    const zip = await JSZip.loadAsync(await buildXlsx([{ name: 'Data', xml: '<row r="1"><c r="A1"><v>1</v></c></row>' }]));
    zip.file('xl/workbook.xml', `<workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Macro1" sheetId="2" r:id="rId2"/></sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet1.xml"/></Relationships>');
    zip.file('xl/macrosheets/sheet1.xml', '<xm:macrosheet><sheetData><row r="1"><c r="A1" t="str"><f>EXEC("calc")</f><v>x</v></c></row></sheetData></xm:macrosheet>');
    const text = await extractSpreadsheetText(await zip.generateAsync({ type: 'nodebuffer' }), 30_000);
    expect(text).toBe('## Sheet: Data\n1');
  });

  it('reads text saved with an .xls name and rejects binary .xls with a clear message', async () => {
    await expect(extractSpreadsheetText(Buffer.from('name\tqty\nbolt\t4\n'), 30_000)).resolves.toBe('name\tqty\nbolt\t4');
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(extractSpreadsheetText(ole, 30_000)).rejects.toBeInstanceOf(SpreadsheetFormatError);
    await expect(extractSpreadsheetText(ole, 30_000)).rejects.toThrow(/\.xlsx or \.csv/);
  });

  it('rejects a zip that is not a workbook', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(extractSpreadsheetText(bytes, 30_000)).rejects.toThrow(/workbook/);
  });
});

async function buildXlsm(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await buildXlsx([{ name: 'Orders', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>AA-ALICE</t></is></c><c r="B1"><v>4707.64</v></c></row>' }]));
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>'
    + '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>');
  zip.file('xl/workbook.xml', `<workbook ${NS}><workbookPr codeName="ThisWorkbook"/><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets>`
    + '<definedNames><definedName name="_xleta.SUM" hidden="1" xlm="1">#NAME?</definedName></definedNames></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>');
  zip.file('xl/vbaProject.bin', 'Attribute VB_Name = "Module1"\nSub AutoOpen(): Shell "calc": End Sub');
  zip.file('xl/vbaProjectSignature.bin', 'sig');
  zip.file('xl/printerSettings/printerSettings1.bin', 'printer');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('stripWorkbookMacros', () => {
  it('removes the VBA project and makes the package a plain .xlsx', async () => {
    const { bytes, stripped } = await stripWorkbookMacros(await buildXlsm());
    expect(stripped).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter(p => /vba/i.test(p))).toEqual([]);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).not.toMatch(/macroEnabled|vbaProject/);
    expect(types).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    expect(types).toContain('<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>');
    expect(await zip.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toContain('vbaProject');
    // Excel won't open an .xlsx that still flags a name as an Excel 4.0 macro.
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    expect(workbook).not.toContain('xlm=');
    expect(workbook).toContain('<definedName name="_xleta.SUM" hidden="1">#NAME?</definedName>');
    expect(zip.file('xl/printerSettings/printerSettings1.bin')).not.toBeNull();
    await expect(extractSpreadsheetText(bytes, 30_000)).resolves.toBe('## Sheet: Orders\nAA-ALICE,4707.64');
  });

  it('switches a vbaProject Default for .bin to printer settings when other .bin parts remain', async () => {
    const zip = await JSZip.loadAsync(await buildXlsm());
    zip.file('[Content_Types].xml', '<Types><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>');
    const { bytes } = await stripWorkbookMacros(await zip.generateAsync({ type: 'nodebuffer' }));
    const types = await (await JSZip.loadAsync(bytes)).file('[Content_Types].xml')!.async('string');
    expect(types).toBe('<Types><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
  });

  it('returns a macro-free workbook untouched', async () => {
    const xlsx = await buildXlsx([{ name: 'S', xml: '<row r="1"><c r="A1"><v>1</v></c></row>' }]);
    const result = await stripWorkbookMacros(xlsx);
    expect(result.stripped).toBe(false);
    expect(result.bytes).toBe(xlsx);
  });

  it('refuses workbooks with Excel 4.0 macro sheets and packages that are not workbooks', async () => {
    const zip = await JSZip.loadAsync(await buildXlsm());
    zip.file('xl/macrosheets/sheet1.xml', '<xm:macrosheet/>');
    await expect(stripWorkbookMacros(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/Excel 4\.0 macro sheets/);
    const notWorkbook = new JSZip();
    notWorkbook.file('hello.txt', 'hi');
    await expect(stripWorkbookMacros(await notWorkbook.generateAsync({ type: 'nodebuffer' }))).rejects.toBeInstanceOf(SpreadsheetFormatError);
    await expect(stripWorkbookMacros(Buffer.from('not a zip'))).rejects.toBeInstanceOf(SpreadsheetFormatError);
  });
});

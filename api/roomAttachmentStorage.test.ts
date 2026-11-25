// Upload rules shared by the web upload and room_upload (ported from the
// hosted deployment's api/upload.excel.test.ts, #734 and #745).
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { EXECUTABLE_ATTACHMENT_WARNING, slimAttachment } from '@agent-room/shared';
import { MiniZip } from './_zip.js';
import { storeRoomAttachment, type PutObject } from './_roomAttachmentStorage.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function workbook(macros = false): Promise<Buffer> {
  const zip = new MiniZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.${macros ? 'ms-excel.sheet.macroEnabled' : 'openxmlformats-officedocument.spreadsheetml.sheet'}.main+xml"/>`
    + (macros ? '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' : '') + '</Types>');
  zip.file('xl/workbook.xml', `<workbook ${NS}><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + (macros ? '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' : '')
    + '</Relationships>');
  zip.file('xl/worksheets/sheet1.xml', `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>bolt</t></is></c><c r="B1"><v>4</v></c></row></sheetData></worksheet>`);
  if (macros) zip.file('xl/vbaProject.bin', 'Sub AutoOpen(): Shell "calc": End Sub');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function recorder() {
  const puts: Array<Parameters<PutObject>[0]> = [];
  const put: PutObject = async (input) => { puts.push(input); return `https://files.example/${input.key}`; };
  return { puts, put };
}

describe('room attachment storage', () => {
  it('accepts an .xlsx whose MIME the OS left empty and gives agents the sheet as CSV', async () => {
    const { puts, put } = recorder();
    const a = await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'orders.xlsx', bytes: await workbook(),
      mime: 'application/octet-stream', provenance: 'user_upload', put });
    expect(a.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(a.extractedText).toContain('Orders');
    expect(a.extractedText).toContain('bolt,4');
    expect(a).toMatchObject({ riskClass: 'low', scanStatus: 'sanitized', provenance: 'user_upload' });
    expect(puts[0]!.key).toMatch(/^rooms\/ABC-DEF-GHJ\/[0-9a-f-]{36}\/orders\.xlsx$/);
  });

  it('stores an .xlsm as a macro-free .xlsx', async () => {
    const { puts, put } = recorder();
    const a = await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'orders.xlsm', bytes: await workbook(true),
      mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', provenance: 'user_upload', put });
    expect(a).toMatchObject({ name: 'orders.xlsx', riskClass: 'low' });
    const zip = await MiniZip.loadAsync(puts[0]!.body);
    expect(Object.keys(zip.files).filter(p => /vba/i.test(p))).toEqual([]);
    expect(await zip.file('[Content_Types].xml')!.async('string')).not.toContain('macroEnabled');
    expect(a.extractedText).toContain('bolt,4');
  });

  it('shares executables as warned binary downloads with no text projection', async () => {
    const { puts, put } = recorder();
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('payload')]);
    const disguised = await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'readme.txt', bytes: elf,
      mime: 'text/plain', provenance: 'user_upload', put });
    expect(disguised).toMatchObject({ mime: 'application/octet-stream', riskClass: 'executable', scanStatus: 'pending' });
    expect(disguised.extractedText).toBeUndefined();
    expect(slimAttachment(disguised).safetyWarning).toBe(EXECUTABLE_ATTACHMENT_WARNING);
    const script = await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'setup.ps1', bytes: Buffer.from('Write-Host hi'),
      provenance: 'user_upload', put });
    expect(script).toMatchObject({ mime: 'application/octet-stream', riskClass: 'executable' });
    expect(puts.map(p => p.contentType)).toEqual(['application/octet-stream', 'application/octet-stream']);
  });

  it('stores an unknown type as a binary download instead of refusing it', async () => {
    const { put } = recorder();
    const a = await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'model.step', bytes: Buffer.from('ISO-10303-21;'),
      mime: '', provenance: 'user_upload', put });
    expect(a.mime).toBe('application/octet-stream');
    expect(a.riskClass).toBe('low');
  });

  it('refuses to render agent-generated active content', async () => {
    const { puts, put } = recorder();
    await storeRoomAttachment({ roomCode: 'ABC-DEF-GHJ', filename: 'page.html', bytes: Buffer.from('<script>x()</script>'),
      provenance: 'agent_generated', put });
    expect(puts[0]).toMatchObject({ contentType: 'application/octet-stream', disposition: 'attachment' });
  });
});

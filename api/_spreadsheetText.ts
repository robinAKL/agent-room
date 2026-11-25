// Turn an uploaded Excel file into CSV text that agents can read. Each sheet
// becomes a `## Sheet: <name>` heading followed by its rows as CSV.
//
// .xlsx is a zip of XML parts (OOXML), read here with a small node:zlib zip reader (api/_zip.ts). The parts are
// regular enough that a few regexes cover what we need: shared strings, the
// sheet list, each sheet's <c> cells, and the styles that mark a number as a
// date. Formulas use their cached value, or the formula itself when none was
// saved.
//
// Legacy .xls is the binary BIFF format, which we can't parse. Files labelled
// .xls are often really HTML or CSV that Excel opens anyway, though, so those
// are read as text.

// A node:zlib zip shim with the JSZip calls used below (no extra dependency).
import { MiniZip as JSZip } from './_zip.js';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// A sheet's XML is never read past this much, so a highly compressed sheet
// can't make the function inflate hundreds of MB to fill a 30 KB budget.
const MAX_SHEET_XML_CHARS = 20 * 1024 * 1024;

export class SpreadsheetFormatError extends Error {}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

export function isXlsxBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_MAGIC);
}

/** Extract CSV text from .xlsx (or text-based .xls) bytes, capped at `cap` characters. */
export async function extractSpreadsheetText(bytes: Buffer, cap: number): Promise<string> {
  if (isXlsxBytes(bytes)) return extractXlsxText(bytes, cap);
  if (startsWith(bytes, OLE_MAGIC)) {
    throw new SpreadsheetFormatError('Legacy binary .xls can\'t be read. Save it as .xlsx or .csv and upload again.');
  }
  return bytes.toString('utf8').trim().slice(0, cap);
}

const MACRO_WORKBOOK_TYPE = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const PLAIN_WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const VBA_PROJECT_TYPE = 'application/vnd.ms-office.vbaProject';
const PRINTER_SETTINGS_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings';
const VBA_PART = /^xl\/(?:vbaProject|vbaProjectSignature)[^/]*\.bin$|^xl\/_rels\/vbaProject[^/]*\.bin\.rels$/i;

/**
 * Remove the VBA project to make a plain .xlsx: the vbaProject parts, their relationships and
 * content-type entries go, and the workbook's macro-enabled content type
 * becomes the plain one. Returns the input untouched when there was nothing
 * to remove. Workbooks with Excel 4.0 macro sheets are refused: those are
 * real sheets that other parts index into, so they can't be dropped safely.
 */
export async function stripWorkbookMacros(bytes: Buffer): Promise<{ bytes: Buffer; stripped: boolean }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new SpreadsheetFormatError('Not a valid Excel workbook.');
  }
  const paths = Object.keys(zip.files);
  if (!zip.file('xl/workbook.xml')) throw new SpreadsheetFormatError('Not a valid Excel workbook (xl/workbook.xml missing).');
  if (paths.some(p => /^xl\/macrosheets\//i.test(p))) {
    throw new SpreadsheetFormatError('This workbook has Excel 4.0 macro sheets. Save it as .xlsx and upload again.');
  }

  const vbaParts = paths.filter(p => VBA_PART.test(p));
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  // xlm="1" marks a defined name as an Excel 4.0 macro name. Excel refuses
  // to open an .xlsx that still has one ("contains macro-enabled content"),
  // so the flag goes and the name stays an ordinary name formulas can use.
  const xlmName = /(<(?:\w+:)?definedName\b[^>]*?)\s+xlm="(?:1|true)"/g;
  if (!vbaParts.length && !types.includes(MACRO_WORKBOOK_TYPE) && workbook.search(xlmName) < 0) return { bytes, stripped: false };

  for (const p of vbaParts) zip.remove(p);
  zip.file('xl/workbook.xml', workbook.replace(xlmName, '$1'));
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (rels !== undefined) {
    zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*Type="[^"]*\/vbaProject"[^>]*\/>/g, ''));
  }
  const otherBinParts = paths.some(p => !VBA_PART.test(p) && /\.bin$/i.test(p));
  zip.file('[Content_Types].xml', types
    .split(MACRO_WORKBOOK_TYPE).join(PLAIN_WORKBOOK_TYPE)
    .replace(new RegExp(`<Override\\b[^>]*ContentType="${VBA_PROJECT_TYPE}"[^>]*/>`, 'g'), '')
    .replace(new RegExp(`<Default\\b[^>]*ContentType="${VBA_PROJECT_TYPE}"[^>]*/>`, 'g'),
      otherBinParts ? `<Default Extension="bin" ContentType="${PRINTER_SETTINGS_TYPE}"/>` : ''));
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { bytes: out, stripped: true };
}

async function extractXlsxText(bytes: Buffer, cap: number): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  // Some writers (Open XML SDK) prefix every element, e.g. <x:row>; drop the
  // element prefixes so the patterns below see plain names.
  const readPart = async (path: string): Promise<string | undefined> => {
    const xml = await zip.file(path)?.async('string');
    return xml?.replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, '<$1');
  };

  const workbook = await readPart('xl/workbook.xml');
  if (!workbook) throw new SpreadsheetFormatError('Not an Excel workbook (xl/workbook.xml missing).');
  const ctx: SheetContext = {
    sharedStrings: parseSharedStrings((await readPart('xl/sharedStrings.xml')) ?? ''),
    dateStyles: parseDateStyles((await readPart('xl/styles.xml')) ?? ''),
    date1904: /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(workbook),
  };
  const targets = parseWorksheetTargets((await readPart('xl/_rels/workbook.xml.rels')) ?? '');

  const rendered: { heading: string; lines: string[]; size: number; more: boolean }[] = [];
  for (const sheet of parseSheets(workbook)) {
    const target = targets.get(sheet.relId);
    const xml = target === undefined ? undefined : await readPart(resolveWorkbookTarget(target));
    if (xml === undefined) continue;
    const heading = `## Sheet: ${sheet.name}`;
    const { lines, more } = sheetToCsvLines(xml.slice(0, MAX_SHEET_XML_CHARS), ctx, cap);
    rendered.push({ heading, lines, more, size: heading.length + lines.reduce((n, l) => n + l.length + 1, 0) });
  }

  // Share the budget so one long sheet can't hide the rest: smallest sheets
  // first, each gets at most an equal share of what is left, and whatever a
  // small sheet doesn't need goes to the bigger ones.
  const allowance = new Map<number, number>();
  // Reserve room for each sheet's truncation mark and the blank line between sheets.
  let remaining = cap - (TRUNCATION_MARK.length + 2) * rendered.length;
  [...rendered.keys()].sort((a, b) => rendered[a]!.size - rendered[b]!.size).forEach((idx, k) => {
    const share = Math.min(rendered[idx]!.size, Math.floor(remaining / (rendered.length - k)));
    allowance.set(idx, share);
    remaining -= share;
  });

  return rendered.map((sheet, idx) => {
    let budget = allowance.get(idx)! - sheet.heading.length;
    const kept: string[] = [];
    for (const line of sheet.lines) {
      if (line.length + 1 > budget) break;
      kept.push(line);
      budget -= line.length + 1;
    }
    const truncated = sheet.more || kept.length < sheet.lines.length;
    return [sheet.heading, ...kept].join('\n') + (truncated ? TRUNCATION_MARK : '');
  }).join('\n\n').slice(0, cap);
}

const TRUNCATION_MARK = '\n… (sheet truncated)';

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return '\'';
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : undefined;
}

// Concatenate every <t> run inside a fragment, skipping phonetic (<rPh>) runs.
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXml(m[1]!);
  return text;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => textRuns(m[1] ?? ''));
}

interface SheetContext {
  sharedStrings: string[];
  /** Indexes into cellXfs (a cell's s="…") whose number format is a date/time. */
  dateStyles: Set<number>;
  date1904: boolean;
}

// Built-in date/time numFmtIds (ECMA-376 18.8.30, plus the CJK date ids).
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  // Ignore quoted literals, escapes and [Red]/[$-409] sections, then look for date/time tokens.
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
}

function parseDateStyles(styles: string): Set<number> {
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode');
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const dateStyles = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  [...cellXfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, index) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) dateStyles.add(index);
  });
  return dateStyles;
}

// Excel stores dates as days since 1899-12-30 (or 1904-01-01), with the time
// of day as the fraction.
function formatSerialDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + Math.round(serial * 86_400) * 1000).toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  if (serial < 1) return time;
  return Number.isInteger(serial) ? day : `${day} ${time}`;
}

function parseSheets(workbook: string): { name: string; relId: string }[] {
  const sheets: { name: string; relId: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const relId = attr(m[0], 'r:id');
    if (name && relId) sheets.push({ name, relId });
  }
  return sheets;
}

// Only worksheets: Excel 4.0 macro sheets and dialog sheets are also <sheet>
// entries, but their "cells" are macro code, not data.
function parseWorksheetTargets(rels: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target && /\/worksheet$/.test(attr(m[0], 'Type') ?? '')) targets.set(id, target);
  }
  return targets;
}

// Relationship targets are relative to xl/ ("worksheets/sheet1.xml") or
// absolute from the package root ("/xl/worksheets/sheet1.xml").
function resolveWorkbookTarget(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

// "B12" → 1 (zero-based column index).
function columnIndex(ref: string | undefined): number | undefined {
  const letters = ref ? /^([A-Z]+)/.exec(ref)?.[1] : undefined;
  if (!letters) return undefined;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellValue(open: string, inner: string, ctx: SheetContext): string {
  const type = attr(open, 't');
  if (type === 'inlineStr') return textRuns(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (!v) {
    // t="str" with an empty <v> is a formula whose result is "". Without a
    // cached value at all (files written by libraries), show the formula.
    if (type === 'str') return '';
    const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
    return formula ? `=${decodeXml(formula)}` : '';
  }
  if (type === 's') return ctx.sharedStrings[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  const value = decodeXml(v);
  if (type !== undefined && type !== 'n') return value;
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  if (num >= 0 && ctx.dateStyles.has(Number(attr(open, 's') ?? 0))) return formatSerialDate(num, ctx.date1904);
  // Excel shows 15 significant digits, so 4093.6000000000004 is 4093.6.
  return String(Number(num.toPrecision(15)));
}

// A sheet's non-empty rows as CSV lines, stopping once they pass `budget`
// characters (`more` then says rows were left out).
function sheetToCsvLines(xml: string, ctx: SheetContext, budget: number): { lines: string[]; more: boolean } {
  const lines: string[] = [];
  let length = 0;
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const open = c[1]!;
      const col = columnIndex(attr(open, 'r')) ?? next;
      while (cells.length < col) cells.push('');
      cells[col] = csvField(cellValue(open, c[2] ?? '', ctx));
      next = col + 1;
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length) continue;
    const line = cells.join(',');
    if (length + line.length + 1 > budget) return { lines, more: true };
    lines.push(line);
    length += line.length + 1;
  }
  return { lines, more: false };
}

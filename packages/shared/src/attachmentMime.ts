// Known room attachment formats keep their MIME for previews and extraction.
// Other files are stored and shared as binary downloads.
//
// Browsers take File.type from the OS. On Windows that comes from the
// registry, so a machine without Office reports '' for .xlsx, and WPS
// registers its own types (application/wps-office.xlsx). An empty type is
// sent as application/octet-stream in multipart bodies. Matching on the raw
// MIME alone rejected those files as "Unsupported file type", so a file whose
// MIME is missing or unknown falls back to its extension.

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLS_MIME = 'application/vnd.ms-excel';
// Macro-enabled workbook. api/upload.ts strips the VBA and stores it as .xlsx.
export const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';
export const BINARY_ATTACHMENT_MIME = 'application/octet-stream';
const PPT_MIME = 'application/vnd.ms-powerpoint';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const ALLOWED_ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/zip',
  XLS_MIME,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX_MIME,
  XLSM_MIME,
  PPT_MIME,
  PPTX_MIME,
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  xls: XLS_MIME,
  xlsx: XLSX_MIME,
  xlsm: XLSM_MIME,
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: PPT_MIME,
  pptx: PPTX_MIME,
};

/** Extensions for the file picker's `accept`, so the OS dialog doesn't hide files it has no MIME for. */
export const ALLOWED_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION).map(ext => `.${ext}`);

/**
 * Resolve known types by MIME or filename. Use a binary download for other
 * types rather than storing an arbitrary browser-supplied Content-Type.
 */
export function resolveAttachmentMime(name: string, reportedMime: string | undefined): string {
  const mime = (reportedMime ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime === XLSM_MIME.toLowerCase()) return XLSM_MIME;
  if (ALLOWED_ATTACHMENT_MIMES.has(mime)) return mime;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const byExtension = ext ? MIME_BY_EXTENSION[ext] : undefined;
  return byExtension ?? BINARY_ATTACHMENT_MIME;
}

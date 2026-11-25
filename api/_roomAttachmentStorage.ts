// Store one room attachment in R2 and describe it as a MessageAttachment.
// Shared by the web upload endpoint (api/upload.ts) and the MCP room_upload
// tool (api/_roomAgentUploads.ts), so both apply the same rules (ported from
// the hosted deployment's #734, #745 and #758):
//
//   - the MIME is resolved from the reported type or, when that is missing or
//     unknown, the file extension; anything else is a binary download;
//   - Excel workbooks are stored without macros (an .xlsm becomes a plain
//     .xlsx) and their sheets are extracted as CSV text agents can read;
//   - executable files are still shared, as binary downloads with a warning,
//     and never get a text projection or a preview.
//
// PDF and DOCX text extraction is not done here: this deployment ships
// neither parser.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  BINARY_ATTACHMENT_MIME, XLS_MIME, XLSM_MIME, XLSX_MIME, classifyAttachmentRisk,
  hasExecutableSignature, resolveAttachmentMime, safeAttachmentPromptText,
  type MessageAttachment,
} from '@agent-room/shared';
import { extractSpreadsheetText, isXlsxBytes, stripWorkbookMacros } from './_spreadsheetText.js';

export interface R2Env {
  accountId: string;
  bucket: string;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Read every R2 var up front so the caller can return one clean error listing
// what is missing instead of crashing inside the SDK with a cryptic message.
export function readR2Env(): R2Env | { missing: string[] } {
  const env = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    publicUrl: process.env.R2_PUBLIC_URL,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { missing };
  return env as R2Env;
}

let cachedClient: S3Client | null = null;
export function getR2Client(env: R2Env): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
  return cachedClient;
}

export class AttachmentStorageError extends Error {
  constructor(public readonly status: number, code: string, message: string) {
    super(message);
    this.name = code;
  }
}

/** The web upload limit; the function body cannot be larger. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXTRACT_CAP = 30_000;

export function isRasterAttachment(mime: string): boolean {
  return /^image\/(?:png|jpeg|jpg|gif|webp)$/.test(mime);
}

/** Put the bytes; replaceable in tests. */
export type PutObject = (input: { key: string; body: Buffer; contentType: string; disposition?: string }) => Promise<string>;

function r2Put(): PutObject {
  const r2 = readR2Env();
  if ('missing' in r2) {
    throw new AttachmentStorageError(503, 'r2_not_configured', `R2 credentials not set: missing ${r2.missing.join(', ')}.`);
  }
  return async ({ key, body, contentType, disposition }) => {
    try {
      await getR2Client(r2).send(new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(disposition ? { ContentDisposition: disposition } : {}),
        // Content-addressable key (uuid in path) → bytes never change.
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      throw new AttachmentStorageError(500, 'r2_put_failed', `R2 upload failed: ${msg}`);
    }
    const [prefix, id, name] = [key.split('/').slice(0, 2).join('/'), key.split('/')[2], key.split('/').slice(3).join('/')];
    return `${r2.publicUrl.replace(/\/$/, '')}/${prefix}/${id}/${encodeURIComponent(name)}`;
  };
}

export async function storeRoomAttachment(input: {
  roomCode: string;
  filename: string;
  bytes: Buffer;
  mime?: string;
  provenance: 'user_upload' | 'agent_generated';
  width?: number;
  height?: number;
  put?: PutObject;
}): Promise<MessageAttachment & { extractedTextError?: string }> {
  // Browsers send application/octet-stream when the OS has no MIME for the
  // extension (.xlsx on Windows without Office), so resolve by filename too.
  let originalName = input.filename;
  let fileBytes = input.bytes;
  let mime = resolveAttachmentMime(originalName, input.mime);
  let riskClass = classifyAttachmentRisk(originalName, input.mime ?? mime);

  // Keep a macro-free Excel projection when it can be produced; otherwise
  // share the original as a binary download with a warning.
  if ((mime === XLSX_MIME || mime === XLSM_MIME || mime === XLS_MIME) && isXlsxBytes(fileBytes)) {
    try {
      fileBytes = (await stripWorkbookMacros(fileBytes)).bytes;
      mime = XLSX_MIME;
      originalName = originalName.replace(/\.xlsm$/i, '.xlsx');
      riskClass = classifyAttachmentRisk(originalName, mime);
    } catch {
      riskClass = 'executable';
    }
  }

  if (hasExecutableSignature(fileBytes)) riskClass = 'executable';
  if (riskClass === 'executable') mime = BINARY_ATTACHMENT_MIME;

  // Text-based files must declare charset=utf-8, or the browser guesses a
  // legacy encoding and renders non-Latin text as mojibake. Active content an
  // agent generated (HTML, SVG) is stored as a download, never rendered.
  const isTextual = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';
  const activeContent = mime === 'text/html' || mime === 'image/svg+xml';
  const storedContentType = input.provenance === 'agent_generated' && activeContent ? BINARY_ATTACHMENT_MIME
    : isTextual && !/charset=/i.test(mime) ? `${mime}; charset=utf-8` : mime;

  // Text so agents can READ safe document content, capped at 30 KB. A parse
  // failure surfaces as extractedTextError but never blocks the upload.
  let extractedText: string | undefined;
  let extractedTextError: string | undefined;
  if (mime === XLSX_MIME || mime === XLS_MIME) {
    try {
      extractedText = (await extractSpreadsheetText(fileBytes, EXTRACT_CAP)).trim();
    } catch (e) {
      extractedTextError = e instanceof Error ? e.message : 'Spreadsheet parse failed.';
    }
  } else if (mime.startsWith('text/') || mime === 'application/json') {
    extractedText = fileBytes.toString('utf8').trim().slice(0, EXTRACT_CAP);
  }
  if (extractedText === '') extractedText = undefined;

  if (riskClass === 'low') riskClass = classifyAttachmentRisk(originalName, mime, extractedText);
  // Uploaded bytes are never copied raw into a prompt. Executable, archived
  // and secret-bearing content has no prompt projection at all.
  extractedText = safeAttachmentPromptText(originalName, mime, extractedText);
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');

  const id = randomUUID();
  const safeName = originalName.replace(/[/\\]/g, '_').slice(0, 200) || 'file';
  const key = `rooms/${input.roomCode}/${id}/${safeName}`;
  const put = input.put ?? r2Put();
  const url = await put({
    key,
    body: fileBytes,
    contentType: storedContentType,
    ...(input.provenance === 'agent_generated' && !isRasterAttachment(mime) ? { disposition: 'attachment' } : {}),
  });

  const isImage = input.provenance === 'agent_generated' ? isRasterAttachment(mime) : mime.startsWith('image/');
  const widthNum = input.width ?? NaN;
  const heightNum = input.height ?? NaN;
  return {
    id,
    type: isImage ? 'image' : 'file',
    url,
    storageKey: key,
    name: originalName,
    size: fileBytes.length,
    mime,
    uploadedAt: Date.now(),
    provenance: input.provenance,
    sha256,
    scanStatus: riskClass === 'executable' ? 'pending' : riskClass === 'archive' ? 'blocked' : 'sanitized',
    riskClass,
    ...(isImage && Number.isFinite(widthNum) && widthNum > 0 ? { width: widthNum } : {}),
    ...(isImage && Number.isFinite(heightNum) && heightNum > 0 ? { height: heightNum } : {}),
    ...(extractedText ? { extractedText } : {}),
    ...(extractedTextError === undefined ? {} : { extractedTextError }),
  };
}

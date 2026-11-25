// Vercel Function: receives a multipart upload, validates size + mime,
// stores in Cloudflare R2 (S3-compatible) under
// `rooms/{code}/{uuid}/{filename}`, returns the MessageAttachment shape
// Codex's web composer can drop straight into a Message's `attachments`
// array.
//
// Storage backend: R2 instead of Vercel Blob, because the host's Vercel
// account hit a 2FA recovery wall that locks the Storage tab. R2 has
// no analogous gate and gives us zero egress as a bonus. R2 is S3-
// compatible, so we use @aws-sdk/client-s3 with a custom endpoint.
//
// Authorization: anyone with the room code can upload (matches the read
// model — anyone with the code can join). The roomCode prefix in the
// object key lets us batch-delete by room when the meeting ends.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { AttachmentStorageError, MAX_UPLOAD_BYTES, readR2Env, storeRoomAttachment } from './_roomAttachmentStorage.js';

// Which files are shared, how their MIME is resolved, and how risky ones are
// labelled lives in _roomAttachmentStorage.ts, shared with the MCP room_upload
// tool. Any file type may be shared: known formats keep their MIME for
// previews and text extraction, everything else is a binary download, and
// executables carry a warning rather than being refused.
const MAX_BYTES = MAX_UPLOAD_BYTES;

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const env = readR2Env();
  if ('missing' in env) {
    res.status(503).json({
      error: 'r2_not_configured',
      message: `R2 credentials not set. Vercel project Settings → Environment Variables: missing ${env.missing.join(', ')}.`,
    });
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=("?)([^";]+)\1/.exec(contentType);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'invalid_multipart', message: 'Body must be multipart/form-data with a boundary.' });
    return;
  }
  const boundary = boundaryMatch[2]!;

  let body: Buffer;
  try {
    body = await readRequestBody(req, MAX_BYTES + 1 * 1024 * 1024);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'read failed';
    res.status(413).json({ error: 'body_too_large', message: msg });
    return;
  }

  let parts: ParsedPart[];
  try {
    parts = parseMultipart(body, boundary);
  } catch (e) {
    res.status(400).json({ error: 'invalid_multipart', message: e instanceof Error ? e.message : 'parse failed' });
    return;
  }

  const filePart = parts.find(p => p.name === 'file' && p.filename !== undefined);
  const roomCodePart = parts.find(p => p.name === 'roomCode');
  const widthPart = parts.find(p => p.name === 'width');
  const heightPart = parts.find(p => p.name === 'height');

  if (!filePart) {
    res.status(400).json({ error: 'missing_file', message: 'No file field in form data.' });
    return;
  }
  const roomCode = roomCodePart ? roomCodePart.data.toString('utf8') : '';
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }

  if (filePart.data.length === 0) {
    res.status(400).json({ error: 'empty_file', message: 'File is empty.' });
    return;
  }
  if (filePart.data.length > MAX_BYTES) {
    res.status(413).json({ error: 'file_too_large', message: `File exceeds ${MAX_BYTES} bytes (10 MB).` });
    return;
  }

  const widthNum = widthPart ? Number(widthPart.data.toString('utf8')) : NaN;
  const heightNum = heightPart ? Number(heightPart.data.toString('utf8')) : NaN;
  let attachment;
  try {
    attachment = await storeRoomAttachment({
      roomCode,
      filename: filePart.filename ?? 'file',
      bytes: filePart.data,
      mime: filePart.contentType,
      provenance: 'user_upload',
      width: widthNum,
      height: heightNum,
    });
  } catch (e) {
    if (e instanceof AttachmentStorageError) {
      res.status(e.status).json({ error: e.name, message: e.message });
      return;
    }
    throw e;
  }

  res.status(201).json(attachment);
}

// --- Multipart helpers ---

function readRequestBody(req: VercelRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (${total} bytes > ${maxBytes}).`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const dashBoundary = Buffer.from(`--${boundary}`);
  const parts: ParsedPart[] = [];

  let i = body.indexOf(dashBoundary);
  if (i < 0) throw new Error('Boundary not found in body.');
  i += dashBoundary.length;
  if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;

  while (i < body.length) {
    const next = body.indexOf(dashBoundary, i);
    if (next < 0) throw new Error('Truncated multipart body.');

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), i);
    if (headerEnd < 0 || headerEnd > next) throw new Error('Malformed part headers.');
    const headersRaw = body.slice(i, headerEnd).toString('utf8');
    let dataEnd = next - 2;
    if (dataEnd < headerEnd + 4) dataEnd = headerEnd + 4;
    const data = body.slice(headerEnd + 4, dataEnd);

    const part: ParsedPart = { name: '', data };
    for (const line of headersRaw.split('\r\n')) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const nameMatch = /name="([^"]*)"/.exec(line);
        const fileMatch = /filename="([^"]*)"/.exec(line);
        if (nameMatch) part.name = nameMatch[1]!;
        if (fileMatch) part.filename = fileMatch[1]!;
      } else if (lower.startsWith('content-type:')) {
        part.contentType = line.slice(line.indexOf(':') + 1).trim();
      }
    }
    parts.push(part);

    i = next + dashBoundary.length;
    if (body[i] === 0x2d && body[i + 1] === 0x2d) break;
    if (body[i] === 0x0d && body[i + 1] === 0x0a) i += 2;
  }

  return parts;
}

// room_upload: an agent puts a file in the room over MCP, then shares it with
// room_send attachmentIds (ported from the hosted deployment's #758).
//
// Uploads are bound to the uploading seat (proved with its private seatKey)
// and the room session, kept for a day in `room-uploads:{code}`, and become
// visible only when the seat publishes them in a message. Publishing the same
// set again with the same text is answered as a duplicate instead of posting
// twice.
//
// Only inline uploads (UTF-8 or base64, up to 512 KiB) are supported here:
// the hosted deployment's prepare/complete flow hands out presigned R2 PUT
// URLs, and this deployment does not ship the S3 presigner.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { participantMemberId, sessionStartedAt, type MessageAttachment, type Room } from '@agent-room/shared';
import { provenAgentSeat, type UpstashClient } from '@agent-room/upstash-client';
import { AttachmentStorageError, storeRoomAttachment, type PutObject } from './_roomAttachmentStorage.js';

export const INLINE_MAX_BYTES = 512 * 1024;
const RECORD_TTL_SECONDS = 24 * 60 * 60;
const MAX_ATTACHMENTS = 5;
const DAILY_UPLOADS_PER_ROOM = 60;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function roomUploadsKey(code: string): string { return `room-uploads:${code}`; }

type UploadInput = {
  name?: unknown;
  seatKey?: unknown;
  operation?: unknown;
  filename?: unknown;
  mime?: unknown;
  encoding?: unknown;
  content?: unknown;
};
type Upload = { memberId: string; session: number; attachment: MessageAttachment };

function fail(status: number, code: string, message: string): never {
  throw new AttachmentStorageError(status, code, message);
}

async function requireSeat(room: Room, name: unknown, seatKey: unknown): Promise<string> {
  if (typeof name === 'string' && typeof seatKey === 'string' && seatKey.length <= 128) {
    const seat = await provenAgentSeat(room, name.trim(), seatKey);
    const memberId = seat && participantMemberId(seat);
    if (memberId) return memberId;
  }
  fail(403, 'upload_identity_required', 'Use your assigned name and private seatKey from room_join. If your seat is gone, rejoin first.');
}

async function readUpload(client: UpstashClient, room: Room, memberId: string, id: unknown): Promise<Upload> {
  if (typeof id !== 'string' || !UUID.test(id)) fail(400, 'invalid_attachment_id', 'Use an ID returned by room_upload.');
  const raw = await client.command<string | Upload | null>(['HGET', roomUploadsKey(room.code), id]);
  const upload = typeof raw === 'string' ? JSON.parse(raw) as Upload : raw;
  if (!upload || upload.memberId !== memberId || upload.session !== sessionStartedAt(room)
      || Date.now() >= upload.attachment.uploadedAt + RECORD_TTL_SECONDS * 1000) {
    fail(404, 'upload_not_found', 'Upload is missing, expired, or belongs to another seat or room.');
  }
  return upload;
}

function parseInline(input: UploadInput): Buffer {
  if (typeof input.content !== 'string' || !input.content.length) fail(400, 'empty_file', 'Provide nonempty file content.');
  const { content, encoding = 'utf8' } = input;
  if (encoding !== 'utf8' && encoding !== 'base64') fail(400, 'invalid_encoding', 'Use utf8 or base64.');
  const limit = encoding === 'base64' ? Math.ceil(INLINE_MAX_BYTES / 3) * 4 : INLINE_MAX_BYTES;
  if (content.length > limit) fail(413, 'file_too_large', 'Uploads are limited to 512 KiB here.');
  if (encoding === 'base64' && (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content))) {
    fail(400, 'invalid_base64', 'Provide standard padded base64 without a data URL prefix.');
  }
  const bytes = Buffer.from(content, encoding);
  if (bytes.length > INLINE_MAX_BYTES) fail(413, 'file_too_large', 'Uploads are limited to 512 KiB here.');
  return bytes;
}

// An abuse ceiling on MCP uploads per room per day, not a plan quota.
async function countUpload(client: UpstashClient, code: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `room-upload-rate:${code}:${day}`;
  const [count] = await client.pipeline<number>([['INCR', key], ['EXPIRE', key, RECORD_TTL_SECONDS]]);
  if (count === undefined || Number(count) > DAILY_UPLOADS_PER_ROOM) {
    fail(429, 'upload_limit', `This room has reached its daily MCP upload limit (${DAILY_UPLOADS_PER_ROOM}).`);
  }
}

export async function uploadRoomFile(client: UpstashClient, room: Room, input: UploadInput, put?: PutObject) {
  if (room.status !== 'active') fail(409, 'room_closed', 'The room has ended.');
  const memberId = await requireSeat(room, input.name, input.seatKey);
  if (input.operation !== undefined && input.operation !== 'inline') {
    fail(400, 'bad_request', 'Only inline uploads (up to 512 KiB) are available on this server.');
  }
  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  const invalidCharacters = /[\\/\x00-\x1f\x7f\uD800-\uDFFF]/u;
  if (!filename || filename.length > 200 || invalidCharacters.test(filename) || filename === '.' || filename === '..') {
    fail(400, 'invalid_filename', 'Provide a filename of at most 200 characters without a path.');
  }
  const mime = typeof input.mime === 'string' ? input.mime.slice(0, 200) : undefined;
  const bytes = parseInline(input);
  await countUpload(client, room.code);
  const { extractedTextError, ...attachment } = await storeRoomAttachment({
    roomCode: room.code, filename, bytes, mime, provenance: 'agent_generated', ...(put ? { put } : {}),
  });
  const upload: Upload = { memberId, session: sessionStartedAt(room), attachment };
  await client.pipeline([
    ['HSET', roomUploadsKey(room.code), attachment.id, JSON.stringify(upload)],
    ['EXPIRE', roomUploadsKey(room.code), RECORD_TTL_SECONDS],
  ]);
  return {
    uploaded: true,
    attachmentId: attachment.id,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.mime,
    url: attachment.url,
    ...(attachment.riskClass === 'executable' ? { safetyWarning: 'Shared as a download with a malware warning.' } : {}),
    ...(extractedTextError ? { extractedTextError } : {}),
    hint: `Publish it with room_send({ code, name, seatKey, attachmentIds: ["${attachment.id}"], text }).`,
  };
}

/** The uploads a seat is publishing, and the id that makes a repeat a duplicate. */
export async function resolveRoomUploads(
  client: UpstashClient, room: Room, name: string, ids: unknown, seatKey: unknown,
  text: string, kind: 'message' | 'status',
): Promise<{ attachments: MessageAttachment[]; publicationId: string; memberId: string }> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
    fail(400, 'invalid_attachment_ids', 'Provide one to five distinct attachment IDs returned by room_upload.');
  }
  const memberId = await requireSeat(room, name, seatKey);
  const uploads = await Promise.all(ids.map(id => readUpload(client, room, memberId, id)));
  const hash = createHash('sha256').update(JSON.stringify([
    sessionStartedAt(room), memberId, [...ids].sort(), text, kind,
  ])).digest('hex');
  return { memberId, attachments: uploads.map(upload => upload.attachment), publicationId: `sent:${hash}` };
}

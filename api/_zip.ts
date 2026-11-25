// The little of a zip library that reading and rewriting an .xlsx needs, on
// node:zlib alone: list entries, read one as text, replace or remove entries,
// and write the archive back out. Its surface mirrors the JSZip calls the
// hosted deployment's spreadsheet reader makes, so that code ports as-is
// without adding a dependency here.
//
// Supports what Office writes: stored (0) and deflated (8) entries, no
// encryption, no zip64. Anything else is refused rather than half-read.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// Upper bound on one entry's inflated size, so a tiny archive cannot expand
// into gigabytes in memory. Well above any sheet the 30 KB text budget reads.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export class ZipFormatError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry { method: number; data: Buffer; size: number }

/** A readable, editable in-memory zip. */
export class MiniZip {
  private readonly entries = new Map<string, Entry | { text: Buffer }>();

  /** Entry names, as an object for `Object.keys(zip.files)`. */
  get files(): Record<string, true> {
    return Object.fromEntries([...this.entries.keys()].map(name => [name, true as const]));
  }

  static async loadAsync(bytes: Uint8Array): Promise<MiniZip> {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: the last 0x06054b50 within the final 64 KB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipFormatError('Not a zip archive.');
    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES || count === 0xffff || offset === 0xffffffff) throw new ZipFormatError('Unsupported zip archive.');
    const zip = new MiniZip();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new ZipFormatError('Corrupt zip directory.');
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const compressed = buf.readUInt32LE(offset + 20);
      const size = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const local = buf.readUInt32LE(offset + 42);
      const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
      offset += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new ZipFormatError('Encrypted zip entries are not supported.');
      if (method !== 0 && method !== 8) throw new ZipFormatError(`Unsupported zip compression method ${method}.`);
      if (size > MAX_ENTRY_BYTES) throw new ZipFormatError('A zip entry is too large.');
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ZipFormatError('Corrupt zip entry.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + compressed > buf.length) throw new ZipFormatError('Truncated zip entry.');
      if (name.endsWith('/')) continue;
      zip.entries.set(name, { method, data: buf.subarray(start, start + compressed), size });
    }
    return zip;
  }

  /** Read an entry, or replace it with new text when `content` is given. */
  file(name: string): { async(type: 'string'): Promise<string> } | null;
  file(name: string, content: string): this;
  file(name: string, content?: string): { async(type: 'string'): Promise<string> } | null | this {
    if (content !== undefined) {
      this.entries.set(name, { text: Buffer.from(content, 'utf8') });
      return this;
    }
    const entry = this.entries.get(name);
    if (!entry) return null;
    return { async: async () => this.bytes(entry).toString('utf8') };
  }

  remove(name: string): this {
    this.entries.delete(name);
    return this;
  }

  private bytes(entry: Entry | { text: Buffer }): Buffer {
    if ('text' in entry) return entry.text;
    if (entry.method === 0) return entry.data;
    return inflateRawSync(entry.data, { maxOutputLength: MAX_ENTRY_BYTES });
  }

  /** Write the archive, deflating every entry. */
  async generateAsync(_options?: { type?: 'nodebuffer'; compression?: 'DEFLATE' }): Promise<Buffer> {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, entry] of this.entries) {
      const raw = this.bytes(entry);
      const data = deflateRawSync(raw);
      const nameBytes = Buffer.from(name, 'utf8');
      const crc = crc32(raw);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(raw.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(20, 4);
      dir.writeUInt16LE(20, 6);
      dir.writeUInt16LE(0x0800, 8);
      dir.writeUInt16LE(8, 10);
      dir.writeUInt32LE(crc, 16);
      dir.writeUInt32LE(data.length, 20);
      dir.writeUInt32LE(raw.length, 24);
      dir.writeUInt16LE(nameBytes.length, 28);
      dir.writeUInt32LE(offset, 42);
      locals.push(header, nameBytes, data);
      central.push(dir, nameBytes);
      offset += header.length + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.size, 8);
    end.writeUInt16LE(this.entries.size, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...central, end]);
  }
}

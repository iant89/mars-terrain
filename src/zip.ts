// Minimal ZIP (STORE) writer for packaging generated .mars tiles in-browser.
//
// Archives are composed with the Blob constructor, so entry payloads are
// referenced in place instead of being copied through JS memory. STORE
// (no compression) keeps packaging O(entries) and avoids re-reading tile
// bytes. Classic ZIP only (no ZIP64): each part is kept below 4 GiB and
// 65,535 entries by the splitting policy in planZipParts.

// --- CRC32 (IEEE 802.3, reflected) -----------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC32 — call crc32Init, crc32Update (any number of times), crc32Digest. */
export function crc32Init(): number {
  return 0xffffffff;
}

export function crc32Update(state: number, data: Uint8Array): number {
  let c = state >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32Digest(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

/** One-shot CRC32 of a byte array. */
export function crc32(data: Uint8Array): number {
  return crc32Digest(crc32Update(crc32Init(), data));
}

/** CRC32 of a Blob (reads it once). Fallback for entries without a precomputed CRC. */
export async function crc32OfBlob(blob: Blob): Promise<number> {
  return crc32(new Uint8Array(await blob.arrayBuffer()));
}

// --- splitting policy -------------------------------------------------------

// Per-archive caps. Splits trigger when the job exceeds either cap; each part
// stays under both. 50,000 entries is comfortably inside classic ZIP's 65,535
// entry limit; 1 GiB keeps every downloadable blob well under browser blob
// limits even on the largest practical presets.
export const ZIP_PART_MAX_FILES = 50_000;
export const ZIP_PART_MAX_BYTES = 1024 ** 3; // 1 GiB

export type ZipEntry = {
  name: string;
  blob: Blob;
  crc32: number;
};

/** Bytes of zip container overhead a named entry adds (local header + central record). */
export function zipEntryOverhead(name: string): number {
  const nameLen = new TextEncoder().encode(name).length;
  return 30 + nameLen + 46 + nameLen;
}

/**
 * Partition entries into zip parts. A job that fits within one part's caps is
 * returned as a single part; otherwise entries are packed greedily in order,
 * opening a new part whenever the next entry would overflow either cap.
 */
export function planZipParts(entries: ZipEntry[]): ZipEntry[][] {
  if (entries.length === 0) return [];
  const totalBytes = entries.reduce((a, e) => a + e.blob.size + zipEntryOverhead(e.name), 0);
  if (entries.length <= ZIP_PART_MAX_FILES && totalBytes <= ZIP_PART_MAX_BYTES) {
    return [entries];
  }
  const parts: ZipEntry[][] = [];
  let current: ZipEntry[] = [];
  let currentBytes = 0;
  for (const e of entries) {
    const sz = e.blob.size + zipEntryOverhead(e.name);
    if (current.length > 0 && (current.length >= ZIP_PART_MAX_FILES || currentBytes + sz > ZIP_PART_MAX_BYTES)) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(e);
    currentBytes += sz;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Archive file name. A single archive is `<base>.zip`; split archives are
 * `<base>_PART-1.zip`, `<base>_PART-2.zip`, … (part numbers start at 1).
 */
export function zipPartName(base: string, part: number, total: number): string {
  return total <= 1 ? `${base}.zip` : `${base}_PART-${part}.zip`;
}

// --- zip builder ------------------------------------------------------------

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a STORE-method zip archive as a single Blob. Entry blobs are
 * referenced, not copied. Throws if the entry set needs ZIP64.
 */
export function buildZipBlob(entries: ZipEntry[], modDate: Date = new Date()): Blob {
  if (entries.length === 0) throw new Error('buildZipBlob: no entries');
  if (entries.length > 0xffff) throw new Error('buildZipBlob: too many entries for classic ZIP (ZIP64 unsupported)');

  const enc = new TextEncoder();
  const { time, date } = dosDateTime(modDate);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0; // running offset of the next local header

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const size = e.blob.size;
    if (offset >= 0xffffffff || offset + size >= 0xffffffff) {
      throw new Error('buildZipBlob: archive exceeds 4 GiB (ZIP64 unsupported)');
    }

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // general purpose flags
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, e.crc32 >>> 0, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    parts.push(local, e.blob);

    // Central directory record
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central file header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method: STORE
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, e.crc32 >>> 0, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra field length (30), comment length (32) stay 0
    cv.setUint16(34, 0, true); // disk number start
    // internal attrs (36), external attrs (38) stay 0
    cv.setUint32(42, offset, true); // relative offset of local header
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, 0, true); // comment length

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

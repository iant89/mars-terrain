// Forge Engine Terrain (.fet) — on-disk tile format.
// Full contract: docs/FET.md
//
// Layout (little-endian), version 1:
//   header     24 bytes  — six uint32 words
//   heights    res*res   Float32 elevations in metres
//   materials  res*res   Uint8 class ids (0 = unclassified)

/** File-order ASCII 'FET1' interpreted as a little-endian uint32. */
export const FET_MAGIC = 0x31544546;
export const FET_VERSION = 1;
export const FET_HEADER_BYTES = 24;
export const FET_EXTENSION = '.fet';
export const FET_MIME = 'application/vnd.forge-engine.terrain';

export type FetHeader = {
  magic: number;
  version: number;
  face: number;
  x: number;
  y: number;
  res: number;
};

export function fetByteLength(res: number): number {
  return FET_HEADER_BYTES + res * res * 4 + res * res;
}

export function encodeFetHeader(face: number, x: number, y: number, res: number): Uint32Array {
  return new Uint32Array([FET_MAGIC, FET_VERSION, face, x, y, res]);
}

export function readFetHeader(view: DataView): FetHeader | null {
  if (view.byteLength < FET_HEADER_BYTES) return null;
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== FET_MAGIC || version !== FET_VERSION) return null;
  return {
    magic,
    version,
    face: view.getUint32(8, true),
    x: view.getUint32(12, true),
    y: view.getUint32(16, true),
    res: view.getUint32(20, true),
  };
}

export function encodeFetTile(
  face: number,
  x: number,
  y: number,
  res: number,
  heights: Float32Array,
  materials: Uint8Array,
): Blob {
  const header = encodeFetHeader(face, x, y, res);
  return new Blob(
    [header.buffer as ArrayBuffer, heights.buffer as ArrayBuffer, materials.buffer as ArrayBuffer],
    { type: FET_MIME },
  );
}

export function decodeFetTile(
  buffer: ArrayBuffer,
  face: number,
  x: number,
  y: number,
  res: number,
): { heights: Float32Array; materials: Uint8Array } | null {
  if (buffer.byteLength !== fetByteLength(res)) return null;
  const header = readFetHeader(new DataView(buffer));
  if (!header || header.face !== face || header.x !== x || header.y !== y || header.res !== res) {
    return null;
  }
  const heights = new Float32Array(res * res);
  new Uint8Array(heights.buffer).set(new Uint8Array(buffer, FET_HEADER_BYTES, res * res * 4));
  const materials = new Uint8Array(buffer, FET_HEADER_BYTES + res * res * 4, res * res).slice();
  return { heights, materials };
}

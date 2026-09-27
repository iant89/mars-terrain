/// <reference lib="webworker" />
import { fromBlob, fromUrl, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import { MARS_RADIUS_M } from './config';
import { cacheTerrainTile, getCachedTerrainTile } from './terrain-cache';
import { crc32Init, crc32Update, crc32Digest } from './zip';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DEM_CACHE_VERSION = 'mola-v2';
const HEADER_BYTES = 24; // six little-endian uint32 values in the .mars header

type Vec3 = { x: number; y: number; z: number };
type RasterValues = ArrayLike<number> & { width: number; height: number };
type DemImage = {
  image: GeoTIFFImage;
  width: number;
  height: number;
  xMin: number;
  xSpan: number;
  yMin: number;
  yMax: number;
  longitudeAtXMin: number;
  originX: number;
  originY: number;
  resX: number;
  resY: number;
  pixelOffset: number;
  noData: number | null;
};

let sourceTiff: GeoTIFF | null = null;
let dem: DemImage | null = null;
let sourceKey = '';
let sourceRevision = 0;
let generationRevision = 0;
let cacheReadDisabled = false;
let cacheWriteDisabled = false;

function norm(p: Vec3): Vec3 {
  const length = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / length, y: p.y / length, z: p.z / length };
}

function faceDirection(face: number, u: number, v: number): Vec3 {
  let p: Vec3;
  if (face === 0) p = { x: 1, y: v, z: -u };
  else if (face === 1) p = { x: -1, y: v, z: u };
  else if (face === 2) p = { x: u, y: 1, z: -v };
  else if (face === 3) p = { x: u, y: -1, z: v };
  else if (face === 4) p = { x: u, y: v, z: 1 };
  else p = { x: -u, y: v, z: -1 };
  const { x, y, z } = p;
  const x2 = x * x, y2 = y * y, z2 = z * z;
  return norm({
    x: x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3),
    y: y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3),
    z: z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3),
  });
}

function globalRasterMetadata(image: GeoTIFFImage): Omit<DemImage, 'image' | 'noData'> {
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const xMin = Math.min(bbox[0], bbox[2]);
  const xMax = Math.max(bbox[0], bbox[2]);
  const yMin = Math.min(bbox[1], bbox[3]);
  const yMax = Math.max(bbox[1], bbox[3]);
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const resX = resolution[0];
  const resY = resolution[1];

  const centerX = (bbox[0] + bbox[2]) / 2;
  const centerY = (bbox[1] + bbox[3]) / 2;
  const finiteTransform = bbox.every(Number.isFinite) &&
    Number.isFinite(origin[0]) && Number.isFinite(origin[1]) &&
    Number.isFinite(resX) && Number.isFinite(resY) && resX !== 0 && resY !== 0;
  const gridMatchesBounds = finiteTransform &&
    Math.abs(Math.abs(resX) * width - xSpan) <= Math.max(0.1, xSpan * 1e-6) &&
    Math.abs(Math.abs(resY) * height - ySpan) <= Math.max(0.1, ySpan * 1e-6);

  // Some global DEMs store their georeferencing directly in longitude/latitude
  // degrees. The USGS MOLA GeoTIFF instead uses a Mars simple-cylindrical
  // (equirectangular) projection in metres: its global bounds are approximately
  // ±πR by ±πR/2. Both describe the same 360° × 180° sampling grid.
  const isGlobalGeographic = gridMatchesBounds &&
    Math.abs(xSpan - 360) <= 0.05 && Math.abs(ySpan - 180) <= 0.05;
  const radiusFromX = xSpan / (2 * Math.PI);
  const radiusFromY = ySpan / Math.PI;
  const projectedRadius = (radiusFromX + radiusFromY) / 2;
  const projectedTolerance = projectedRadius * 0.005;
  const isGlobalMarsEquirectangular = gridMatchesBounds &&
    Math.abs(projectedRadius - MARS_RADIUS_M) <= MARS_RADIUS_M * 0.05 &&
    Math.abs(radiusFromX - radiusFromY) <= projectedTolerance &&
    Math.abs(centerX) <= projectedTolerance && Math.abs(centerY) <= projectedTolerance;

  if (!isGlobalGeographic && !isGlobalMarsEquirectangular) {
    throw new Error('Choose a global equirectangular Mars DEM covering 360° longitude and 180° latitude (such as the USGS MOLA 463 m GeoTIFF).');
  }

  return {
    width, height, xMin, xSpan, yMin, yMax,
    // For projected MOLA, the left edge of the raster is longitude −180°;
    // for a geographic raster it is the longitude coordinate at xMin.
    longitudeAtXMin: isGlobalGeographic ? xMin : -180,
    originX: origin[0], originY: origin[1], resX, resY,
    pixelOffset: image.pixelIsArea() ? 0.5 : 0,
  };
}

async function sampleSourceFingerprint(image: GeoTIFFImage, metadata: Omit<DemImage, 'image' | 'noData'>): Promise<string> {
  // A few tiny reads identify the actual raster contents without hashing or
  // loading the multi-gigabyte source. The source metadata is mixed in as well.
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  const feed = (value: number) => {
    const word = Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0xffffffff;
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (word >>> shift) & 0xff;
      hashA = Math.imul(hashA ^ byte, 0x01000193) >>> 0;
      hashB = Math.imul(hashB ^ (byte + 17), 0x85ebca6b) >>> 0;
    }
  };
  for (const value of [
    metadata.width, metadata.height, metadata.xMin, metadata.xSpan, metadata.yMin, metadata.yMax,
    metadata.longitudeAtXMin, metadata.originX, metadata.originY, metadata.resX, metadata.resY,
  ]) {
    feed(Math.round(value * 1_000_000));
  }
  for (const fy of [0.11, 0.37, 0.63, 0.89]) {
    for (const fx of [0.09, 0.33, 0.67, 0.91]) {
      const x = Math.max(0, Math.min(metadata.width - 2, Math.floor(fx * metadata.width)));
      const y = Math.max(0, Math.min(metadata.height - 2, Math.floor(fy * metadata.height)));
      const sample = await image.readRasters({
        window: [x, y, x + 2, y + 2], samples: [0], interleave: true,
      }) as unknown as RasterValues;
      for (let i = 0; i < sample.length; i++) feed(sample[i]);
    }
  }
  return `${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`;
}

async function openDem(message: any): Promise<void> {
  const revision = ++sourceRevision;
  generationRevision++;
  ctx.postMessage({ type: 'dem-loading', sourceId: message.sourceId, name: message.name });
  try {
    const nextTiff = message.kind === 'blob'
      ? await fromBlob(message.blob as Blob)
      : await fromUrl(message.url as string, {
          allowFullFile: false,
          blockSize: 128 * 1024,
          cacheSize: 32,
        } as any);
    const image = await nextTiff.getImage(0);
    const metadata = globalRasterMetadata(image);
    const rasterFingerprint = await sampleSourceFingerprint(image, metadata);
    if (revision !== sourceRevision) {
      nextTiff.close();
      return;
    }

    sourceTiff?.close();
    sourceTiff = nextTiff;
    dem = { ...metadata, image, noData: image.getGDALNoData() };
    sourceKey = `mola-${metadata.width}x${metadata.height}-${rasterFingerprint}`;
    // The TIFF reader defaults to not retaining decoded raster blocks. Keep it
    // that way: each terrain tile reads only its small source window.
    ctx.postMessage({
      type: 'dem-ready', sourceId: message.sourceId, name: message.name,
      width: metadata.width, height: metadata.height, sourceKey,
    });
  } catch (error) {
    if (revision === sourceRevision) {
      dem = null;
      sourceKey = '';
      sourceTiff?.close();
      sourceTiff = null;
      ctx.postMessage({
        type: 'dem-error', sourceId: message.sourceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

function rasterCoordinates(d: DemImage, lat: number, lon: number): { col: number; row: number } {
  const longitudeOffset = wrap(lon - d.longitudeAtXMin, 360);
  const x = d.xMin + (longitudeOffset / 360) * d.xSpan;
  const latitude = Math.max(-90, Math.min(90, lat));
  const y = d.yMin + ((latitude + 90) / 180) * (d.yMax - d.yMin);
  const col = (x - d.originX) / d.resX - d.pixelOffset;
  const row = (y - d.originY) / d.resY - d.pixelOffset;
  return { col, row: Math.max(0, Math.min(d.height - 1, row)) };
}

async function readRasterWindow(d: DemImage, startCol: number, endCol: number, startRow: number, endRow: number): Promise<{
  startCol: number; startRow: number; first: RasterValues; second: RasterValues | null; firstWidth: number;
}> {
  const count = endCol - startCol + 1;
  const normalizedStart = wrap(startCol, d.width);
  const firstWidth = Math.min(count, d.width - normalizedStart);
  const first = await d.image.readRasters({
    window: [normalizedStart, startRow, normalizedStart + firstWidth, endRow + 1],
    samples: [0], interleave: true,
  }) as unknown as RasterValues;
  let second: RasterValues | null = null;
  if (firstWidth < count) {
    second = await d.image.readRasters({
      window: [0, startRow, count - firstWidth, endRow + 1],
      samples: [0], interleave: true,
    }) as unknown as RasterValues;
  }
  return { startCol, startRow, first, second, firstWidth };
}

function rasterValue(window: Awaited<ReturnType<typeof readRasterWindow>>, col: number, row: number): number {
  const localCol = wrap(col - window.startCol, window.first.width + (window.second?.width ?? 0));
  const localRow = row - window.startRow;
  if (localCol < window.firstWidth) {
    return window.first[localRow * window.first.width + localCol];
  }
  if (!window.second) return window.first[localRow * window.first.width + localCol];
  const secondCol = localCol - window.firstWidth;
  return window.second[localRow * window.second.width + secondCol];
}

function interpolateRaster(d: DemImage, window: Awaited<ReturnType<typeof readRasterWindow>>, col: number, row: number): number {
  const c0 = Math.floor(col), r0 = Math.floor(row);
  const c1 = c0 + 1;
  const r1 = Math.min(d.height - 1, r0 + 1);
  const tx = col - c0, ty = row - r0;
  const samples = [
    [rasterValue(window, c0, r0), (1 - tx) * (1 - ty)],
    [rasterValue(window, c1, r0), tx * (1 - ty)],
    [rasterValue(window, c0, r1), (1 - tx) * ty],
    [rasterValue(window, c1, r1), tx * ty],
  ] as const;
  let sum = 0, weight = 0;
  for (const [value, w] of samples) {
    if (Number.isFinite(value) && (d.noData === null || value !== d.noData)) {
      sum += value * w;
      weight += w;
    }
  }
  if (weight <= 0) throw new Error('The MOLA DEM has no valid elevation data at this location.');
  return sum / weight;
}

async function sampleTile(id: string, token: number, face: number, cx: number, cy: number, res: number, chunks: number): Promise<{
  heights: Float32Array; materials: Uint8Array;
}> {
  if (!dem) throw new Error('Load a global MOLA DEM before generating terrain.');
  const d = dem;
  const heights = new Float32Array(res * res);
  const materials = new Uint8Array(res * res);
  const locations: Array<{ col: number; row: number }> = [];
  let anchorCol = 0;

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const u = -1 + (2 * (cx + i / (res - 1))) / chunks;
      const v = -1 + (2 * (cy + j / (res - 1))) / chunks;
      const direction = faceDirection(face, u, v);
      const lat = Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI;
      const lon = Math.atan2(direction.z, direction.x) * 180 / Math.PI;
      const coordinate = rasterCoordinates(d, lat, lon);
      if (locations.length === 0) anchorCol = coordinate.col;
      while (coordinate.col - anchorCol > d.width / 2) coordinate.col -= d.width;
      while (coordinate.col - anchorCol < -d.width / 2) coordinate.col += d.width;
      locations.push(coordinate);
    }
  }

  const cols = locations.map(p => p.col);
  const rows = locations.map(p => p.row);
  const minCol = Math.floor(Math.min(...cols));
  const maxCol = Math.floor(Math.max(...cols)) + 1;
  const minRow = Math.max(0, Math.floor(Math.min(...rows)));
  const maxRow = Math.min(d.height - 1, Math.floor(Math.max(...rows)) + 1);
  const rasterWindow = await readRasterWindow(d, minCol, maxCol, minRow, maxRow);
  // Drop any decoded TIFF blocks after this tile. This bounds the reader's
  // decoded-data memory even when the entire 2 GB source is eventually visited.
  d.image.tiles = null;

  for (let j = 0; j < res; j++) {
    if (token !== generationRevision) throw new Error('Generation stopped.');
    for (let i = 0; i < res; i++) {
      const index = j * res + i;
      const point = locations[index];
      heights[index] = interpolateRaster(d, rasterWindow, point.col, point.row);
      // MOLA is elevation-only; it carries no mineral/material classification.
      materials[index] = 0;
    }
    if (j % 4 === 0) ctx.postMessage({ type: 'progress', id, progress: j / (res - 1) });
  }
  return { heights, materials };
}

function makeCacheKey(face: number, cx: number, cy: number, res: number, chunks: number): string {
  return `${DEM_CACHE_VERSION}|${sourceKey}|${chunks}|${res}|${face}|${cx}|${cy}`;
}

async function decodeCachedTile(blob: Blob, face: number, cx: number, cy: number, res: number): Promise<{
  heights: Float32Array; materials: Uint8Array;
} | null> {
  const expectedBytes = HEADER_BYTES + res * res * 5;
  if (blob.size !== expectedBytes) return null;
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x4d415253 || view.getUint32(4, true) !== 1 ||
      view.getUint32(8, true) !== face || view.getUint32(12, true) !== cx ||
      view.getUint32(16, true) !== cy || view.getUint32(20, true) !== res) return null;
  const heights = new Float32Array(res * res);
  const heightBytes = new Uint8Array(buffer, HEADER_BYTES, res * res * 4);
  new Uint8Array(heights.buffer).set(heightBytes);
  const materials = new Uint8Array(buffer, HEADER_BYTES + res * res * 4, res * res).slice();
  return { heights, materials };
}

async function generate(message: any, token: number): Promise<void> {
  const { id, face, cx, cy, res, chunks } = message;
  if (!dem || !sourceKey) throw new Error('No ready MOLA DEM. Use Load MOLA and wait for it to finish indexing.');
  const cacheKey = makeCacheKey(face, cx, cy, res, chunks);
  let cacheError = '';
  if (!cacheReadDisabled) {
    try {
      const record = await getCachedTerrainTile(cacheKey);
      if (record) {
        const decoded = await decodeCachedTile(record.blob, face, cx, cy, res);
        if (decoded) {
          if (token !== generationRevision) return;
          ctx.postMessage({
            type: 'done', id, blob: record.blob, crc: record.crc,
            heights: decoded.heights, materials: decoded.materials, cached: true,
          }, [decoded.heights.buffer, decoded.materials.buffer]);
          return;
        }
      }
    } catch (error) {
      cacheReadDisabled = true;
      cacheWriteDisabled = true;
      cacheError = error instanceof Error ? error.message : String(error);
    }
  }

  if (token !== generationRevision) return;
  const { heights, materials } = await sampleTile(id, token, face, cx, cy, res, chunks);
  if (token !== generationRevision) return;
  const header = new Uint32Array([0x4d415253, 1, face, cx, cy, res]);
  let crcState = crc32Init();
  crcState = crc32Update(crcState, new Uint8Array(header.buffer));
  crcState = crc32Update(crcState, new Uint8Array(heights.buffer));
  crcState = crc32Update(crcState, materials);
  const crc = crc32Digest(crcState);
  const blob = new Blob([
    header.buffer as ArrayBuffer,
    heights.buffer as ArrayBuffer,
    materials.buffer as ArrayBuffer,
  ], { type: 'application/octet-stream' });
  if (!cacheWriteDisabled) {
    try {
      await cacheTerrainTile({ key: cacheKey, blob, crc });
    } catch (error) {
      cacheWriteDisabled = true;
      cacheError = error instanceof Error ? error.message : String(error);
    }
  }
  if (token !== generationRevision) return;
  ctx.postMessage({
    type: 'done', id, blob, crc, heights, materials,
    cached: false, cacheError,
  }, [heights.buffer, materials.buffer]);
}

ctx.onmessage = event => {
  const message = event.data;
  if (message.type === 'stop') {
    generationRevision++;
    return;
  }
  if (message.type === 'set-dem-blob' || message.type === 'set-dem-url') {
    void openDem(message);
    return;
  }
  if (message.type === 'generate') {
    const token = ++generationRevision;
    void generate(message, token).catch(error => {
      if (token !== generationRevision) return;
      ctx.postMessage({
        type: 'error', id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
};

// Region selection for "save chunks around a starting position" exports.
//
// The planet is partitioned into 6 faces of N×N tiles (the same F#-x-y grid as
// the .mars headers). A region is an angular disc around a lat/lon starting
// position: tiles whose center lies within `radiusTiles` tile-widths of the
// start are kept, everything else is discarded (never generated).
//
// Selection is exact and cheap for any density: the candidate box is derived
// from the exact inverse cube-sphere projection of the start position onto
// each face, and every candidate is verified by angular distance — the cost
// scales with the region, not the planet. This is what lets region mode run
// even the highest-density presets for a small play area.

import { MARS_RADIUS_M } from './config';

export type Vec3 = { x: number; y: number; z: number };

export type RegionSpec = {
  lat: number;          // degrees, -90..90 (positive north)
  lon: number;          // degrees, -180..180 (positive east of the prime meridian)
  radiusTiles: number;  // region radius in tiles, measured at the starting tile
};

export type RegionTile = { face: number; x: number; y: number };

export type RegionPlan = {
  tiles: RegionTile[];      // kept tiles, nearest-to-spawn first (generation order)
  center: RegionTile;       // the tile containing the starting position
  tileAngleRad: number;     // angular width of one tile at the center
  radiusKm: number;         // approximate physical radius of the region
  chunkCount: number;
};

// --- vector / cube-sphere math (same model as the terrain worker) -----------

export function normVec(p: Vec3): Vec3 {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}

/** Forward cube-sphere mapping: face + (u, v) in [-1, 1]² -> unit direction. */
export function faceDirVec(face: number, u: number, v: number): Vec3 {
  let p: Vec3;
  if (face === 0) p = { x: 1, y: v, z: -u };
  else if (face === 1) p = { x: -1, y: v, z: u };
  else if (face === 2) p = { x: u, y: 1, z: -v };
  else if (face === 3) p = { x: u, y: -1, z: v };
  else if (face === 4) p = { x: u, y: v, z: 1 };
  else p = { x: -u, y: v, z: -1 };
  const { x, y, z } = p;
  const x2 = x * x, y2 = y * y, z2 = z * z;
  return normVec({
    x: x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3),
    y: y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3),
    z: z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3),
  });
}

/**
 * Exact inverse of the spherized forward map: the (u, v) whose faceDirVec has
 * the same direction as `d` on the given face. Values outside [-1, 1] mean the
 * direction falls outside that face's square.
 *
 * The naive plane (gnomonic) projection inverts faceDirVec's pre-normalization
 * but NOT its spherization — the parameter error grows near face edges/corners
 * (up to ~0.2, i.e. thousands of tiles at high densities). So the gnomonic
 * estimate is refined with Newton iterations against the true forward map.
 */
export function faceUV(face: number, d: Vec3): { u: number; v: number } {
  const g = (f: number, dir: Vec3): { u: number; v: number } => {
    if (f === 0) return { u: -dir.z / dir.x, v: dir.y / dir.x };
    if (f === 1) return { u: -dir.z / dir.x, v: -dir.y / dir.x };
    if (f === 2) return { u: dir.x / dir.y, v: -dir.z / dir.y };
    if (f === 3) return { u: -dir.x / dir.y, v: -dir.z / dir.y };
    if (f === 4) return { u: dir.x / dir.z, v: dir.y / dir.z };
    return { u: dir.x / dir.z, v: -dir.y / dir.z };
  };
  const G = g(face, d);
  let u = G.u, v = G.v;
  for (let i = 0; i < 12; i++) {
    const h = g(face, faceDirVec(face, u, v));
    const ru = h.u - G.u, rv = h.v - G.v;
    if (Math.abs(ru) < 1e-13 && Math.abs(rv) < 1e-13) break;
    const e = 1e-7;
    const hU = g(face, faceDirVec(face, u + e, v));
    const hV = g(face, faceDirVec(face, u, v + e));
    const juu = (hU.u - h.u) / e, juv = (hV.u - h.u) / e;
    const jvu = (hU.v - h.v) / e, jvv = (hV.v - h.v) / e;
    const det = juu * jvv - juv * jvu;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
    u -= (jvv * ru - juv * rv) / det;
    v -= (-jvu * ru + juu * rv) / det;
  }
  return { u, v };
}

/** Latitude/longitude (degrees) to a unit direction. Matches the app's globe
 *  convention: lat = asin(y), lon = atan2(z, x). */
export function latLonToVec(lat: number, lon: number): Vec3 {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return normVec({
    x: Math.cos(la) * Math.cos(lo),
    y: Math.sin(la),
    z: Math.cos(la) * Math.sin(lo),
  });
}

/** Unit direction back to latitude/longitude (degrees). */
export function vecToLatLon(d: Vec3): { lat: number; lon: number } {
  const n = normVec(d);
  return {
    lat: (Math.asin(Math.max(-1, Math.min(1, n.y))) * 180) / Math.PI,
    lon: (Math.atan2(n.z, n.x) * 180) / Math.PI,
  };
}

/** Great-circle angle (radians) between two directions. */
export function angularDistance(a: Vec3, b: Vec3): number {
  const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(d);
}

function tileUV(nPerFace: number, tile: number): number {
  return -1 + (2 * (tile + 0.5)) / nPerFace;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// --- region planning ---------------------------------------------------------

/**
 * Plan the saved region around a starting position. Returns every tile whose
 * center lies within `radiusTiles` tile-widths (angular) of the start, in
 * nearest-first generation order so the spawn area is ready almost
 * immediately and the outer ring finishes just as the player needs it.
 */
export function planRegion(nPerFace: number, spec: RegionSpec): RegionPlan {
  const N = Math.max(1, Math.floor(nPerFace));
  const radius = Math.max(0, spec.radiusTiles);
  const centerDir = latLonToVec(spec.lat, spec.lon);

  // Face whose plane contains the start direction (dominant axis).
  const ax = Math.abs(centerDir.x), ay = Math.abs(centerDir.y), az = Math.abs(centerDir.z);
  let face: number;
  if (ax >= ay && ax >= az) face = centerDir.x >= 0 ? 0 : 1;
  else if (ay >= az) face = centerDir.y >= 0 ? 2 : 3;
  else face = centerDir.z >= 0 ? 4 : 5;

  const { u: cu, v: cv } = faceUV(face, centerDir);
  const cx = clampInt(Math.round(((cu + 1) / 2) * N - 0.5), 0, N - 1);
  const cy = clampInt(Math.round(((cv + 1) / 2) * N - 0.5), 0, N - 1);
  const center: RegionTile = { face, x: cx, y: cy };

  // Angular width of one tile at the center (take the larger of the u/v steps
  // so the radius is never underestimated).
  const tu = tileUV(N, cx), tv = tileUV(N, cy);
  const c0 = faceDirVec(face, tu, tv);
  const du = angularDistance(c0, faceDirVec(face, tu + 2 / N, tv));
  const dv = angularDistance(c0, faceDirVec(face, tu, tv + 2 / N));
  const tileAngleRad = Math.max(du, dv) || 1e-9;
  const maxAngle = Math.min(Math.PI, radius * tileAngleRad);
  const radiusKm = (radius * tileAngleRad * MARS_RADIUS_M) / 1000;

  // Candidate boxes: parameter-space position of the start on every face, with
  // a half-width that covers radiusTiles after cube-sphere distortion (~2×)
  // plus a margin. Each candidate is then verified by exact angular distance.
  const half = Math.ceil(radius * 2) + 2;
  const tiles: ({ face: number; x: number; y: number; dist: number })[] = [];

  for (let f = 0; f < 6; f++) {
    const { u: gu, v: gv } = faceUV(f, centerDir);
    if (!Number.isFinite(gu) || !Number.isFinite(gv)) continue;
    const reach = 1 + (2 * half) / N;
    if (Math.abs(gu) > reach || Math.abs(gv) > reach) continue; // face too far away
    const gx = ((gu + 1) / 2) * N - 0.5;
    const gy = ((gv + 1) / 2) * N - 0.5;
    const x0 = Math.max(0, Math.floor(gx - half)), x1 = Math.min(N - 1, Math.ceil(gx + half));
    const y0 = Math.max(0, Math.floor(gy - half)), y1 = Math.min(N - 1, Math.ceil(gy + half));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = faceDirVec(f, tileUV(N, x), tileUV(N, y));
        const dist = angularDistance(centerDir, d);
        // The spawn tile is always kept, even at radius 0.
        if (dist <= maxAngle || (f === face && x === cx && y === cy)) tiles.push({ face: f, x, y, dist });
      }
    }
  }

  // Nearest-first (the spawn tile leads), deterministic tie-break in grid order.
  tiles.sort((a, b) => (a.dist - b.dist) || (a.face - b.face) || (a.y - b.y) || (a.x - b.x));

  return {
    tiles: tiles.map(({ face: f, x, y }) => ({ face: f, x, y })),
    center,
    tileAngleRad,
    radiusKm,
    chunkCount: tiles.length,
  };
}

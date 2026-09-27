// Terrain geometry helpers for the 3D renderer.
//
// Generated tiles live on the cube-sphere: a tile is a cube face plus an (x, y)
// index into that face's N x N grid, holding res x res elevations in meters.
// The globe renderer places every vertex in planet-centered coordinates
// (origin at the core, +Y north) so the mesh is an actual planet the camera
// can orbit. A local tangent-frame projection remains for non-curved layouts.
//
// Everything here is pure math (no three.js): the renderer turns the returned
// typed arrays into BufferGeometry attributes.

import { MARS_RADIUS_M } from './config';
import { Vec3, faceDirVec, faceUV, normVec, vecToLatLon } from './region';

// --- small vector helpers (kept local; region.ts owns the planetary ones) ---

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Orthonormal tangent frame at a unit direction: east (+X), north, up (+Y). */
export type Frame = { east: Vec3; north: Vec3; up: Vec3 };

export function localFrame(dir: Vec3): Frame {
  const up = normVec(dir);
  // Planet north is +Y; fall back to +X at the poles where that is degenerate.
  let ref: Vec3 = { x: 0, y: 1, z: 0 };
  if (Math.abs(dot(ref, up)) > 0.99999) ref = { x: 1, y: 0, z: 0 };
  const d = dot(ref, up);
  const north = normVec({ x: ref.x - up.x * d, y: ref.y - up.y * d, z: ref.z - up.z * d });
  const east = normVec(cross(up, north));
  return { east, north, up };
}

/**
 * Scene coordinates. In planet-centered mode the origin is the planet centre,
 * +Y is north, and a surface point sits at `dir * (R + elevation)`. The older
 * local-frame layout (X = east, Y = up, Z = -north) is still available when
 * curvature is off.
 */
export type LocalPoint = { x: number; y: number; z: number };

/**
 * Planet-centered position of a surface point: origin at the core, +Y north.
 * Used by the globe renderer so the generated terrain actually looks like a
 * planet rather than a tangent patch.
 */
export function projectToPlanet(
  dir: Vec3,
  elevationM: number,
  exaggeration: number,
): LocalPoint {
  const r = MARS_RADIUS_M + elevationM * exaggeration;
  return { x: dir.x * r, y: dir.y * r, z: dir.z * r };
}

/** Inverse of projectToPlanet: scene point -> unit direction from the core. */
export function planetToDirection(p: LocalPoint): Vec3 {
  return normVec(p);
}

/**
 * Project a surface point onto the local tangent frame.
 *
 * `curvature: false` uses an azimuthal-equidistant projection: distance from
 * the anchor is preserved (R * angle), the terrain is laid out flat and relief
 * reads clearly. `curvature: true` is planet-centered (see projectToPlanet) so
 * the whole sphere is in one coordinate system and distant tiles drop below
 * the horizon.
 */
export function projectToFrame(
  dir: Vec3,
  elevationM: number,
  frame: Frame,
  exaggeration: number,
  curvature: boolean,
): LocalPoint {
  if (curvature) return projectToPlanet(dir, elevationM, exaggeration);
  const h = elevationM * exaggeration;
  const c = Math.max(-1, Math.min(1, dot(dir, frame.up)));
  const w: Vec3 = {
    x: dir.x - frame.up.x * c,
    y: dir.y - frame.up.y * c,
    z: dir.z - frame.up.z * c,
  };
  const t = Math.hypot(w.x, w.y, w.z);
  if (t < 1e-12) return { x: 0, y: h, z: 0 };
  const s = (MARS_RADIUS_M * Math.atan2(t, c)) / t;
  const b: Vec3 = { x: w.x * s, y: w.y * s, z: w.z * s };
  return { x: dot(b, frame.east), y: h, z: -dot(b, frame.north) };
}

/** Inverse of projectToFrame (ignores the local height): local point -> unit direction. */
export function frameToDirection(p: LocalPoint, frame: Frame, curvature: boolean): Vec3 {
  if (curvature) return planetToDirection(p);
  const rho = Math.hypot(p.x, p.z);
  if (rho < 1e-9) return frame.up;
  const theta = rho / MARS_RADIUS_M;
  const ct = Math.cos(theta), st = Math.sin(theta);
  // tangent = east * (x / rho) + north * (-z / rho)
  return normVec({
    x: frame.up.x * ct + (frame.east.x * p.x - frame.north.x * p.z) / rho * st,
    y: frame.up.y * ct + (frame.east.y * p.x - frame.north.y * p.z) / rho * st,
    z: frame.up.z * ct + (frame.east.z * p.x - frame.north.z * p.z) / rho * st,
  });
}

// --- tile bookkeeping --------------------------------------------------------

export type TileRef = { face: number; x: number; y: number };

export const tileKey = (face: number, x: number, y: number): string => `${face}-${x}-${y}`;

export type TileRecord = {
  face: number;
  x: number;
  y: number;
  heights: Float32Array;
  materials: Uint8Array | null;
  dir: Vec3;      // unit direction of the tile centre (cached)
};

/** Complete tiles keyed by `tileKey`. */
export type TileIndex = Map<string, TileRecord>;

/** Parameter-space centre of a tile: (u, v) in [-1, 1]. */
export function tileUV(nPerFace: number, tile: number): number {
  return -1 + (2 * (tile + 0.5)) / nPerFace;
}

export function tileCenterDir(face: number, x: number, y: number, nPerFace: number): Vec3 {
  return faceDirVec(face, tileUV(nPerFace, x), tileUV(nPerFace, y));
}

/**
 * Angular width (radians) of one tile at the given centre. The larger of the
 * u/v steps is used so a window radius is never underestimated.
 */
export function tileAngleRad(face: number, x: number, y: number, nPerFace: number): number {
  const u = tileUV(nPerFace, x), v = tileUV(nPerFace, y);
  const step = 2 / nPerFace;
  const c = tileCenterDir(face, x, y, nPerFace);
  const du = angleBetween(c, faceDirVec(face, u + step, v));
  const dv = angleBetween(c, faceDirVec(face, u, v + step));
  return Math.max(du, dv) || 1e-9;
}

export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(normVec(a), normVec(b)))));
}

// --- sampling ----------------------------------------------------------------

export type TerrainSample = {
  lat: number;
  lon: number;
  elevation: number | null;  // metres, null when the tile isn't generated yet
  material: number | null;
  tile: TileRef | null;
};

function bilinear(h: Float32Array, res: number, gi: number, gj: number): number {
  const i0 = Math.max(0, Math.min(res - 1, Math.floor(gi)));
  const j0 = Math.max(0, Math.min(res - 1, Math.floor(gj)));
  const i1 = Math.min(res - 1, i0 + 1);
  const j1 = Math.min(res - 1, j0 + 1);
  const ti = Math.max(0, Math.min(1, gi - i0));
  const tj = Math.max(0, Math.min(1, gj - j0));
  const a = h[j0 * res + i0], b = h[j0 * res + i1];
  const c = h[j1 * res + i0], d = h[j1 * res + i1];
  return (a + (b - a) * ti) * (1 - tj) + (c + (d - c) * ti) * tj;
}

/**
 * Sample the generated terrain under a unit direction: the tile that contains
 * it plus the bilinearly interpolated elevation and material id. Returns null
 * elevation when the tile hasn't been generated.
 */
export function sampleTerrain(
  dir: Vec3,
  index: TileIndex,
  nPerFace: number,
  res: number,
): TerrainSample {
  const { lat, lon } = vecToLatLon(dir);
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  let face: number;
  if (ax >= ay && ax >= az) face = dir.x >= 0 ? 0 : 1;
  else if (ay >= az) face = dir.y >= 0 ? 2 : 3;
  else face = dir.z >= 0 ? 4 : 5;

  const uv = faceUV(face, normVec(dir));
  const inside = Math.abs(uv.u) <= 1 && Math.abs(uv.v) <= 1;
  // Tile-space position: tile x spans u in [x - 0.5, x + 0.5] of these units.
  const fx = ((uv.u + 1) / 2) * nPerFace - 0.5;
  const fy = ((uv.v + 1) / 2) * nPerFace - 0.5;
  const tx = Math.max(0, Math.min(nPerFace - 1, Math.round(fx)));
  const ty = Math.max(0, Math.min(nPerFace - 1, Math.round(fy)));
  const rec = inside ? index.get(tileKey(face, tx, ty)) : undefined;
  if (!rec || rec.heights.length !== res * res) {
    return { lat, lon, elevation: null, material: null, tile: { face, x: tx, y: ty } };
  }
  const gi = (fx - tx + 0.5) * (res - 1);
  const gj = (fy - ty + 0.5) * (res - 1);
  const elevation = bilinear(rec.heights, res, gi, gj);
  let material: number | null = null;
  if (rec.materials && rec.materials.length === res * res) {
    material = rec.materials[Math.round(gj) * res + Math.round(gi)] ?? null;
  }
  return { lat, lon, elevation, material, tile: { face, x: tx, y: ty } };
}

// --- colour ------------------------------------------------------------------

export type ShadeMode = 'material' | 'elevation' | 'slope';

// MOLA is a topography-only DEM; it does not provide material classes.
export const MATERIAL_LABELS = ['Unclassified MOLA surface'];
const MATERIAL_HEX = ['#a9603d'];

// Elevation ramp, low basins -> dusty summits.
const ELEVATION_STOPS: [number, string][] = [
  [-8000, '#3b2f36'],
  [-3000, '#6b4b40'],
  [-500, '#8f5a3c'],
  [1500, '#b06a41'],
  [5000, '#c9875a'],
  [10000, '#dda377'],
  [16000, '#e9c39c'],
  [21000, '#f2ddc4'],
];
const SLOPE_FLAT = '#d9c9bb';   // dust-covered flats
const SLOPE_STEEP = '#3a2f2c';  // exposed rock

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

const MATERIAL_RGB = MATERIAL_HEX.map(hexToLinear);
const ELEVATION_RGB = ELEVATION_STOPS.map(([h, hex]) => ({ h, c: hexToLinear(hex) }));
const SLOPE_A = hexToLinear(SLOPE_FLAT);
const SLOPE_B = hexToLinear(SLOPE_STEEP);

/** sRGB hex of a material id, for UI swatches. */
export function materialHex(id: number): string {
  return MATERIAL_HEX[id] ?? MATERIAL_HEX[0];
}

export function elevationColor(elevationM: number): [number, number, number] {
  const s = ELEVATION_RGB;
  if (elevationM <= s[0].h) return s[0].c;
  for (let i = 1; i < s.length; i++) {
    if (elevationM <= s[i].h) {
      const t = (elevationM - s[i - 1].h) / (s[i].h - s[i - 1].h);
      return [
        s[i - 1].c[0] + (s[i].c[0] - s[i - 1].c[0]) * t,
        s[i - 1].c[1] + (s[i].c[1] - s[i - 1].c[1]) * t,
        s[i - 1].c[2] + (s[i].c[2] - s[i - 1].c[2]) * t,
      ];
    }
  }
  return s[s.length - 1].c;
}

// --- mesh building -----------------------------------------------------------

export type TileGeometry = {
  positions: Float32Array;   // 3 per vertex, local frame metres
  normals: Float32Array;
  colors: Float32Array;      // linear RGB
  indices: Uint32Array;
  minElevation: number;
  maxElevation: number;
  meanElevation: number;
  center: LocalPoint;        // tile centre in local frame (for camera framing)
  extent: number;            // half-size of the tile in local metres
};

export type BuildTileOptions = {
  face: number;
  x: number;
  y: number;
  nPerFace: number;
  res: number;
  heights: Float32Array;
  materials: Uint8Array | null;
  frame: Frame;
  exaggeration: number;
  curvature: boolean;
  shade: ShadeMode;
  /**
   * Relief shading (hillshade z-factor): exaggerates the terrain's slopes in
   * the lighting normals only, leaving the geometry untouched. At vertex
   * spacings of kilometres Mars is nearly flat, so without it the sun
   * direction barely changes the image. 1 = physically true normals.
   */
  reliefShading?: number;
  /** Heights of a same-face neighbour tile, or null when it isn't available. */
  neighbor: (face: number, x: number, y: number) => Float32Array | null;
};

/**
 * Build one tile's mesh in the local tangent frame.
 *
 * Tiles share edge vertices exactly (the generator samples the same (u, v) on
 * both sides of a border), so a window of tiles assembles seamlessly. Vertex
 * normals are differenced on a padded grid that reads the neighbouring tiles'
 * edge rows, which keeps the shading continuous across those shared edges
 * instead of creasing every tile boundary.
 */
export function buildTileGeometry(o: BuildTileOptions): TileGeometry {
  const { face, x, y, nPerFace: N, res, heights, materials, frame } = o;
  const pad = res + 2;

  // Padded height grid: interior from this tile, borders from same-face
  // neighbours, clamped at face edges (cross-face borders fall back to the
  // nearest edge value — a mild shading seam on the cube's corners only).
  const paddedHeight = (i: number, j: number): number => {
    if (i >= 0 && i < res && j >= 0 && j < res) return heights[j * res + i];
    const fx = i < 0 ? -1 : i >= res ? 1 : 0;
    const fy = j < 0 ? -1 : j >= res ? 1 : 0;
    const ci = Math.max(0, Math.min(res - 1, i));
    const cj = Math.max(0, Math.min(res - 1, j));
    const nx = x + fx, ny = y + fy;
    if (fx === 0 && fy === 0) return heights[cj * res + ci];
    if (nx < 0 || nx >= N || ny < 0 || ny >= N) return heights[cj * res + ci];
    const nh = o.neighbor(face, nx, ny);
    if (!nh || nh.length !== res * res) return heights[cj * res + ci];
    const i2 = i - fx * (res - 1);
    const j2 = j - fy * (res - 1);
    return nh[j2 * res + i2];
  };

  // Padded local positions (one extra ring so every interior vertex has both
  // neighbours available for central differencing).
  const pp = new Float64Array(pad * pad * 3);
  for (let pj = 0; pj < pad; pj++) {
    const j = pj - 1;
    const v = -1 + (2 * (y + j / (res - 1))) / N;
    for (let pi = 0; pi < pad; pi++) {
      const i = pi - 1;
      const u = -1 + (2 * (x + i / (res - 1))) / N;
      const k = pj * pad + pi;
      const p = projectToFrame(faceDirVec(face, u, v), paddedHeight(i, j), frame, o.exaggeration, o.curvature);
      pp[k * 3] = p.x;
      pp[k * 3 + 1] = p.y;
      pp[k * 3 + 2] = p.z;
    }
  }

  const boost = Math.max(1, o.reliefShading ?? 1);
  const count = res * res;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  let minE = Infinity, maxE = -Infinity, sumE = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const src = (j * res + i);
      const k = src * 3;
      const pk = ((j + 1) * pad + (i + 1)) * 3;
      positions[k] = pp[pk];
      positions[k + 1] = pp[pk + 1];
      positions[k + 2] = pp[pk + 2];

      // Central differences across the padded ring.
      const li = ((j + 1) * pad + i) * 3;         // i - 1
      const ri = ((j + 1) * pad + (i + 2)) * 3;   // i + 1
      const dj = (j * pad + (i + 1)) * 3;         // j - 1
      const uj = ((j + 2) * pad + (i + 1)) * 3;   // j + 1
      const ax = pp[ri] - pp[li], ay = pp[ri + 1] - pp[li + 1], az = pp[ri + 2] - pp[li + 2];
      const bx = pp[uj] - pp[dj], by = pp[uj + 1] - pp[dj + 1], bz = pp[uj + 2] - pp[dj + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      // Lighting vertical: +Y in the flat layout; radial (outward) on the
      // planet so southern-hemisphere tiles aren't flipped inside-out.
      let ux = 0, uy = 1, uz = 0;
      if (o.curvature) {
        const d = faceDirVec(face, -1 + (2 * (x + i / (res - 1))) / N, -1 + (2 * (y + j / (res - 1))) / N);
        ux = d.x; uy = d.y; uz = d.z;
      }
      if (nx * ux + ny * uy + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz; }

      // Lighting normal: scale the tilt away from the local vertical by the
      // relief-shading factor. The planet's own curvature isn't exaggerated
      // along with the relief.
      const nu = nx * ux + ny * uy + nz * uz;
      let lx = ux * nu + (nx - ux * nu) * boost;
      let ly = uy * nu + (ny - uy * nu) * boost;
      let lz = uz * nu + (nz - uz * nu) * boost;
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx /= ll; ly /= ll; lz /= ll;
      normals[k] = lx;
      normals[k + 1] = ly;
      normals[k + 2] = lz;

      const h = heights[src];
      if (h < minE) minE = h;
      if (h > maxE) maxE = h;
      sumE += h;

      // Colour: palette by material / elevation, then a slope term that
      // darkens exposed rock on steep faces (dust settles on the flats).
      const upness = Math.max(0, Math.min(1, nx * ux + ny * uy + nz * uz));
      let cr: number, cg: number, cb: number;
      if (o.shade === 'material' && materials && materials.length === count) {
        const c = MATERIAL_RGB[materials[src]] ?? MATERIAL_RGB[0];
        cr = c[0]; cg = c[1]; cb = c[2];
      } else if (o.shade === 'slope') {
        const t = Math.max(0, Math.min(1, (1 - upness) * 2.2));
        cr = SLOPE_A[0] + (SLOPE_B[0] - SLOPE_A[0]) * t;
        cg = SLOPE_A[1] + (SLOPE_B[1] - SLOPE_A[1]) * t;
        cb = SLOPE_A[2] + (SLOPE_B[2] - SLOPE_A[2]) * t;
      } else {
        const c = elevationColor(h);
        cr = c[0]; cg = c[1]; cb = c[2];
      }
      const shade = 0.68 + 0.32 * upness;
      colors[k] = cr * shade;
      colors[k + 1] = cg * shade;
      colors[k + 2] = cb * shade;
    }
  }

  // Grid triangles. Winding is derived from the geometry so every cube face
  // ends up front-facing (the (u, v) axes flip direction between faces).
  const quads = (res - 1) * (res - 1);
  const indices = new Uint32Array(quads * 6);
  let t = 0;
  const a = 0, b = 1, c = res;
  const pax = positions[a * 3], pay = positions[a * 3 + 1], paz = positions[a * 3 + 2];
  const e1x = positions[b * 3] - pax, e1y = positions[b * 3 + 1] - pay, e1z = positions[b * 3 + 2] - paz;
  const e2x = positions[c * 3] - pax, e2y = positions[c * 3 + 1] - pay, e2z = positions[c * 3 + 2] - paz;
  const gx = e1y * e2z - e1z * e2y;
  const gy = e1z * e2x - e1x * e2z;
  const gz = e1x * e2y - e1y * e2x;
  const flip = gx * normals[0] + gy * normals[1] + gz * normals[2] < 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const v0 = j * res + i;
      const v1 = v0 + 1;
      const v2 = v0 + res;
      const v3 = v2 + 1;
      if (flip) {
        indices[t++] = v0; indices[t++] = v2; indices[t++] = v1;
        indices[t++] = v1; indices[t++] = v2; indices[t++] = v3;
      } else {
        indices[t++] = v0; indices[t++] = v1; indices[t++] = v2;
        indices[t++] = v1; indices[t++] = v3; indices[t++] = v2;
      }
    }
  }

  // Tile centre + extent in local metres (used to frame the camera).
  const centreDir = faceDirVec(face, tileUV(N, x), tileUV(N, y));
  let meanH = sumE / count;
  if (!Number.isFinite(meanH)) meanH = 0;
  const center = projectToFrame(centreDir, meanH, frame, o.exaggeration, o.curvature);
  let extent = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = (j * res + i) * 3;
      const d = Math.hypot(
        positions[k] - center.x,
        positions[k + 1] - center.y,
        positions[k + 2] - center.z,
      );
      if (d > extent) extent = d;
    }
  }

  return {
    positions,
    normals,
    colors,
    indices,
    minElevation: Number.isFinite(minE) ? minE : 0,
    maxElevation: Number.isFinite(maxE) ? maxE : 0,
    meanElevation: meanH,
    center,
    extent,
  };
}

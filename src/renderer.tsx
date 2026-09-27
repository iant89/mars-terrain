// Interactive 3D terrain renderer.
//
// Generated .mars tiles are drawn on a real sphere (planet-centered metres,
// see terrain.ts) so the view is a planet, not a tangent patch. The camera
// orbits that planet: drag to pan at a constant altitude, wheel to zoom.
// Close-up cruise altitude is 1 km; zooming out reveals the whole globe.
//
// Every generated chunk is meshed. Chunks on the far side of the planet
// (below the horizon) are hidden; everything else stays in the scene, so
// orbiting never drops terrain that should be on the globe.
//
// Directions, tile centres and lat/lon are all kept in the geographic planet
// frame (lon = atan2(z, x)); they cross into three.js scene space only
// through planetToScene/sceneToPlanet, which flips the handedness so the
// globe is drawn north-up with east on the right instead of mirrored. Camera
// controls assume that: dragging right moves the terrain right (west-ward
// camera motion), and in fly mode D moves the camera east.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  Mountain, X, Eye, EyeOff, Grid3x3, Sun, Move3d, Crosshair, Camera, Layers, Info,
} from 'lucide-react';
import { formatMeters, fmt, MARS_RADIUS_M } from './config';
import { Chunk } from './types';
import { Vec3, faceDirVec } from './region';
import {
  ShadeMode, TileIndex, TileRecord, TileRef,
  MATERIAL_LABELS, angleBetween, buildTileGeometry, localFrame,
  materialHex, planetToScene, projectToPlanet, sampleTerrain, sceneToPlanet,
  tileCenterDir, tileKey,
} from './terrain';

// Hard cap on simultaneously resident tile meshes. Practical presets fit
// comfortably (16² → 1,536, 32² → 6,144); this only bites on huge runs.
const MAX_TILES = 8192;
const SYNC_MS = 180;        // queue poll interval
const BUILD_BUDGET_MS = 7;  // per-frame budget for streaming tile meshes in
const MIN_ALTITUDE_M = 1_000;
const MAX_ALTITUDE_M = MARS_RADIUS_M * 14;
const CRUISE_ALTITUDE_M = 1_000;

const DEG = Math.PI / 180;
const ELEVATION_LEGEND =
  'linear-gradient(90deg,#3b2f36,#6b4b40,#8f5a3c,#b06a41,#c9875a,#dda377,#e9c39c,#f2ddc4)';

const PLANET_FRAME = localFrame({ x: 0, y: 1, z: 0 });

type Hud = {
  fps: number;
  tiles: number;
  triangles: number;
  span: number;
  lat: number;
  lon: number;
  elevation: number | null;
  agl: number;
  material: number | null;
  tile: string | null;
};

const EMPTY_HUD: Hud = {
  fps: 0, tiles: 0, triangles: 0, span: 0,
  lat: 0, lon: 0, elevation: null, agl: 0, material: null, tile: null,
};

export type TerrainViewerProps = {
  /** Live accessor for the queue — polled instead of passed as a prop so a
   *  running generation never re-renders React. */
  getChunks: () => Chunk[];
  nPerFace: number;
  resolution: number;
  /** Tile the view starts centred on (region centre, or a picked chunk). */
  focus: TileRef | null;
  onClose: () => void;
};

type GlobeCam = { lat: number; lon: number; altitude: number };

function dirFromLatLon(lat: number, lon: number): Vec3 {
  const clat = Math.cos(lat), slat = Math.sin(lat);
  const clon = Math.cos(lon), slon = Math.sin(lon);
  return { x: clat * clon, y: slat, z: clat * slon };
}

function latLonRadFromDir(dir: Vec3): { lat: number; lon: number } {
  const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, dir.y / n))),
    lon: Math.atan2(dir.z, dir.x),
  };
}

/** Pull the camera back so the whole planet sits in the view. */
function planetViewAltitude(fovDeg: number): number {
  const half = (fovDeg * DEG * 0.72) / 2;
  const s = Math.sin(Math.max(0.12, half));
  return Math.max(CRUISE_ALTITUDE_M * 8, MARS_RADIUS_M / s - MARS_RADIUS_M);
}

function clampLat(lat: number): number {
  return Math.max(-Math.PI / 2 + 0.002, Math.min(Math.PI / 2 - 0.002, lat));
}

function wrapLon(lon: number): number {
  let a = lon;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function applyGlobeCamera(camera: THREE.PerspectiveCamera, g: GlobeCam, surfaceElev = 0) {
  // Scene space, so the globe is drawn the right way round (east on the
  // right); the camera's lat/lon stay in the planet frame.
  const d = planetToScene(dirFromLatLon(g.lat, g.lon));
  // Altitude is height above the local surface, so a 1 km cruise clears Olympus
  // instead of burying the camera inside it.
  const r = MARS_RADIUS_M + surfaceElev + g.altitude;
  camera.position.set(d.x * r, d.y * r, d.z * r);
  const slat = Math.sin(g.lat), clat = Math.cos(g.lat);
  const clon = Math.cos(g.lon), slon = Math.sin(g.lon);
  // Local north, in scene space: screen up is north, so screen right is east.
  const up = planetToScene({ x: -slat * clon, y: clat, z: -slat * slon });
  camera.up.set(up.x, up.y, up.z);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(1, Math.min(g.altitude * 0.02, g.altitude * 0.25, 8_000));
  camera.far = r + MARS_RADIUS_M * 1.5;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

function makeStarField(): THREE.Points {
  const n = 3200;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const radius = MARS_RADIUS_M * 90;
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    pos[i * 3] = s * Math.cos(phi) * radius;
    pos[i * 3 + 1] = u * radius;
    pos[i * 3 + 2] = s * Math.sin(phi) * radius;
    const b = 0.5 + Math.random() * 0.5;
    const tint = Math.random();
    col[i * 3] = b;
    col[i * 3 + 1] = b * (tint < 0.12 ? 0.82 : 1);
    col[i * 3 + 2] = b * (tint > 0.88 ? 0.88 : 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.8,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export function TerrainViewer({ getChunks, nPerFace, resolution, focus, onClose }: TerrainViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  const [shade, setShade] = useState<ShadeMode>('elevation');
  // 1 = true scale: every vertex sits at its actual elevation in metres.
  const [exaggeration, setExaggeration] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [follow, setFollow] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [mode, setMode] = useState<'orbit' | 'fly'>('orbit');
  const [sunAz, setSunAz] = useState(135);
  const [sunEl, setSunEl] = useState(32);
  const [relief, setRelief] = useState(6);
  const [flySpeedIdx, setFlySpeedIdx] = useState(26);
  const [uiHidden, setUiHidden] = useState(false);
  const [focusTile, setFocusTile] = useState<TileRef | null>(focus);
  const [hud, setHud] = useState<Hud>(EMPTY_HUD);
  const [empty, setEmpty] = useState(false);
  const [voidView, setVoidView] = useState(false);

  // --- three.js handles ------------------------------------------------------
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const gridRef = useRef<THREE.LineSegments | null>(null);
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const hemiRef = useRef<THREE.HemisphereLight | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const planetRef = useRef<THREE.Mesh | null>(null);

  // --- tile data -------------------------------------------------------------
  const indexRef = useRef<TileIndex>(new Map());
  const seenRef = useRef<Map<string, Chunk>>(new Map());
  const meshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const buildQueueRef = useRef<TileRecord[]>([]);
  const geoKeyRef = useRef('');
  const lastSyncRef = useRef(0);
  const lastGridRef = useRef(0);
  const framedOnceRef = useRef(false);
  const fpsRef = useRef(0);
  const cameraTouchedRef = useRef(false);
  const fitGoalRef = useRef<{ lat: number; lon: number; altitude: number | null } | null>(null);

  const globeRef = useRef<GlobeCam>({
    lat: 0,
    lon: 0,
    altitude: planetViewAltitude(48),
  });
  const keysRef = useRef<Set<string>>(new Set());
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  const focusKey = focusTile ? tileKey(focusTile.face, focusTile.x, focusTile.y) : '';

  const paramsRef = useRef({
    shade, exaggeration, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile, relief,
  });
  paramsRef.current = {
    shade, exaggeration, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile, relief,
  };

  const disposeMesh = useCallback((mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    (mesh.parent ?? groupRef.current)?.remove(mesh);
  }, []);

  const applyCameraPose = useCallback((camera: THREE.PerspectiveCamera) => {
    const p = paramsRef.current;
    const g = globeRef.current;
    const dir = dirFromLatLon(g.lat, g.lon);
    const elev = (sampleTerrain(dir, indexRef.current, p.nPerFace, p.resolution).elevation ?? 0) * p.exaggeration;
    applyGlobeCamera(camera, g, elev);
  }, []);

  /** Hide tiles on the far side of the planet; everything else stays drawn. */
  const updateVisibility = useCallback((): number => {
    const camera = cameraRef.current;
    if (!camera) return 0;
    const len = camera.position.length() || 1;
    // Tile directions are planet-frame, so compare against the camera in the
    // same frame rather than against its scene position.
    const cam = sceneToPlanet(camera.position);
    const cx = cam.x / len;
    const cy = cam.y / len;
    const cz = cam.z / len;
    // Horizon: a surface point is hidden once it dips behind the limb.
    const horizon = (MARS_RADIUS_M * 0.982) / len;
    let vis = 0;
    for (const [key, mesh] of meshesRef.current) {
      const rec = indexRef.current.get(key);
      if (!rec) {
        mesh.visible = false;
        continue;
      }
      const show = rec.dir.x * cx + rec.dir.y * cy + rec.dir.z * cz > horizon;
      mesh.visible = show;
      if (show) vis++;
    }
    return vis;
  }, []);

  /** Tile-boundary overlay for the meshes currently in the scene. */
  const rebuildGrid = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const p = paramsRef.current;
    const res = p.resolution;
    const N = p.nPerFace;
    const corners = [[0, 0], [res - 1, 0], [res - 1, res - 1], [0, res - 1]] as const;
    const pts: number[] = [];
    for (const [key, mesh] of meshesRef.current) {
      const rec = indexRef.current.get(key);
      const st = mesh.userData.stats as { extent: number } | undefined;
      if (!rec || !st || !mesh.visible) continue;
      const lift = Math.max(40, st.extent * 0.008);
      for (let ci = 0; ci < 4; ci++) {
        const [i0, j0] = corners[ci];
        const [i1, j1] = corners[(ci + 1) % 4];
        for (const [i, j] of [[i0, j0], [i1, j1]] as const) {
          const u = -1 + (2 * (rec.x + i / (res - 1))) / N;
          const v = -1 + (2 * (rec.y + j / (res - 1))) / N;
          const h = (rec.heights[j * res + i] ?? 0) + lift / Math.max(0.001, p.exaggeration);
          const pt = projectToPlanet(faceDirVec(rec.face, u, v), h, p.exaggeration);
          pts.push(pt.x, pt.y, pt.z);
        }
      }
    }
    grid.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    grid.geometry.computeBoundingSphere();
    grid.visible = p.showGrid;
  }, []);

  /**
   * Stream queued tile meshes into the scene, nearest first, stopping once
   * `budgetMs` of wall time is spent (at least one tile per call).
   */
  const drainQueue = useCallback((budgetMs: number) => {
    const queue = buildQueueRef.current;
    const group = groupRef.current;
    const material = materialRef.current;
    if (!queue.length || !group || !material) return;
    const p = paramsRef.current;
    const N = p.nPerFace;
    const res = p.resolution;
    const geoKey = geoKeyRef.current;
    const index = indexRef.current;
    const neighbor = (f: number, x: number, y: number): Float32Array | null =>
      index.get(tileKey(f, x, y))?.heights ?? null;
    const nbrMaskOf = (rec: TileRecord): number => {
      let m = 0;
      for (let dy = -1, bit = 0; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, bit++) {
          if ((dx || dy) && index.has(tileKey(rec.face, rec.x + dx, rec.y + dy))) m |= 1 << bit;
        }
      }
      return m;
    };

    const t0 = performance.now();
    let built = 0;
    while (queue.length) {
      if (built > 0 && performance.now() - t0 > budgetMs) break;
      const rec = queue.shift()!;
      const key = tileKey(rec.face, rec.x, rec.y);
      if (!index.has(key)) continue;
      const nbrMask = nbrMaskOf(rec);
      const existing = meshesRef.current.get(key);
      if (existing && !existing.userData.stale && existing.userData.geoKey === geoKey &&
        existing.userData.heights === rec.heights && existing.userData.nbrMask === nbrMask &&
        existing.userData.stats) {
        continue;
      }

      const g = buildTileGeometry({
        face: rec.face,
        x: rec.x,
        y: rec.y,
        nPerFace: N,
        res,
        heights: rec.heights,
        materials: rec.materials,
        frame: PLANET_FRAME,
        exaggeration: p.exaggeration,
        curvature: true,
        shade: p.shade,
        reliefShading: p.relief,
        neighbor,
      });

      let mesh = existing;
      if (mesh && mesh.geometry.getAttribute('position')?.count === res * res &&
        mesh.geometry.index?.count === g.indices.length) {
        const geo = mesh.geometry;
        (geo.getAttribute('position').array as Float32Array).set(g.positions);
        (geo.getAttribute('normal').array as Float32Array).set(g.normals);
        (geo.getAttribute('color').array as Float32Array).set(g.colors);
        (geo.index!.array as Uint32Array).set(g.indices);
        geo.getAttribute('position').needsUpdate = true;
        geo.getAttribute('normal').needsUpdate = true;
        geo.getAttribute('color').needsUpdate = true;
        geo.index!.needsUpdate = true;
        geo.computeBoundingSphere();
      } else {
        if (mesh) disposeMesh(mesh);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
        geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
        geo.computeBoundingSphere();
        mesh = new THREE.Mesh(geo, material);
        group.add(mesh);
        meshesRef.current.set(key, mesh);
      }
      mesh.visible = true;
      mesh.userData.stale = false;
      mesh.userData.geoKey = geoKey;
      mesh.userData.heights = rec.heights;
      mesh.userData.nbrMask = nbrMask;
      mesh.userData.stats = { cx: g.center.x, cz: g.center.z, extent: g.extent, mean: g.meanElevation };
      built++;
    }
    if (built > 0) {
      const now = performance.now();
      if (!buildQueueRef.current.length || now - lastGridRef.current > 250) {
        lastGridRef.current = now;
        updateVisibility();
        rebuildGrid();
      }
    }
  }, [disposeMesh, rebuildGrid, updateVisibility]);

  /**
   * Point the globe camera and make sure every generated chunk has a mesh
   * (or is queued for one). Tiles are not dropped when they leave the view —
   * they stay on the planet and are only hidden when they go behind the limb.
   */
  const buildWindow = useCallback((op: 'auto' | 'frame' | 'recenter') => {
    const camera = cameraRef.current;
    if (!camera) return;
    const p = paramsRef.current;
    const N = p.nPerFace;
    const index = indexRef.current;

    if (index.size === 0) {
      for (const mesh of meshesRef.current.values()) disposeMesh(mesh);
      meshesRef.current.clear();
      buildQueueRef.current = [];
      setEmpty(true);
      setVoidView(false);
      if (gridRef.current) {
        gridRef.current.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      }
      framedOnceRef.current = true;
      applyCameraPose(camera);
      return;
    }
    setEmpty(false);

    const first = index.values().next().value as TileRecord | undefined;
    const focusRec = p.focusTile
      ? index.get(tileKey(p.focusTile.face, p.focusTile.x, p.focusTile.y))
      : undefined;
    const anchorRec = focusRec ?? first;
    if (!anchorRec) {
      applyCameraPose(camera);
      return;
    }

    const look = latLonRadFromDir(anchorRec.dir);
    const overview = planetViewAltitude(camera.fov);
    if (op === 'frame' || !framedOnceRef.current) {
      globeRef.current.lat = look.lat;
      globeRef.current.lon = look.lon;
      globeRef.current.altitude = overview;
      fitGoalRef.current = null;
      framedOnceRef.current = true;
    } else if (op === 'recenter') {
      fitGoalRef.current = { lat: look.lat, lon: look.lon, altitude: overview };
    } else if (p.follow) {
      const g = globeRef.current;
      const dLat = look.lat - g.lat;
      const dLon = Math.atan2(Math.sin(look.lon - g.lon), Math.cos(look.lon - g.lon));
      if (Math.hypot(dLat, dLon) > 0.002) {
        fitGoalRef.current = { lat: look.lat, lon: look.lon, altitude: null };
      }
    }

    applyCameraPose(camera);

    const geoKey = `${N}|${p.resolution}|${p.exaggeration}|${p.shade}|${p.relief}|planet`;
    geoKeyRef.current = geoKey;

    // Planet-frame camera position: `rec.dir` is planet-frame too, and the
    // two must match or "nearest tile first" ranks the wrong hemisphere.
    const cam = sceneToPlanet(camera.position);
    const ranked: { rec: TileRecord; d: number }[] = [];
    for (const rec of index.values()) {
      const d = Math.hypot(
        rec.dir.x * MARS_RADIUS_M - cam.x,
        rec.dir.y * MARS_RADIUS_M - cam.y,
        rec.dir.z * MARS_RADIUS_M - cam.z,
      );
      ranked.push({ rec, d });
    }
    ranked.sort((a, b) => a.d - b.d || a.rec.face - b.rec.face || a.rec.y - b.rec.y || a.rec.x - b.rec.x);
    if (ranked.length > MAX_TILES) ranked.length = MAX_TILES;

    const keep = new Set(ranked.map(c => tileKey(c.rec.face, c.rec.x, c.rec.y)));
    const overBudget = index.size > MAX_TILES;
    for (const [key, mesh] of [...meshesRef.current]) {
      if (!index.has(key) || (overBudget && !keep.has(key))) {
        disposeMesh(mesh);
        meshesRef.current.delete(key);
      }
    }

    const nbrMaskOf = (rec: TileRecord): number => {
      let m = 0;
      for (let dy = -1, bit = 0; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, bit++) {
          if ((dx || dy) && index.has(tileKey(rec.face, rec.x + dx, rec.y + dy))) m |= 1 << bit;
        }
      }
      return m;
    };
    const queue: TileRecord[] = [];
    for (const { rec } of ranked) {
      const mesh = meshesRef.current.get(tileKey(rec.face, rec.x, rec.y));
      if (mesh && !mesh.userData.stale && mesh.userData.geoKey === geoKey &&
        mesh.userData.heights === rec.heights && mesh.userData.nbrMask === nbrMaskOf(rec) &&
        mesh.userData.stats) {
        continue;
      }
      queue.push(rec);
    }
    buildQueueRef.current = queue;

    updateVisibility();
    rebuildGrid();
    drainQueue(op === 'frame' || meshesRef.current.size === 0 ? 24 : BUILD_BUDGET_MS);
  }, [disposeMesh, applyCameraPose, rebuildGrid, drainQueue, updateVisibility]);

  const buildWindowRef = useRef(buildWindow);
  buildWindowRef.current = buildWindow;
  const drainQueueRef = useRef(drainQueue);
  drainQueueRef.current = drainQueue;
  const updateVisibilityRef = useRef(updateVisibility);
  updateVisibilityRef.current = updateVisibility;
  const rebuildGridRef = useRef(rebuildGrid);
  rebuildGridRef.current = rebuildGrid;

  useEffect(() => {
    buildWindowRef.current('auto');
  }, [focusKey, exaggeration, shade, relief, nPerFace, resolution]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);
  useEffect(() => {
    if (materialRef.current) materialRef.current.wireframe = wireframe;
  }, [wireframe]);

  // --- queue sync ------------------------------------------------------------

  const syncTiles = useCallback((): boolean => {
    const chunks = getChunks();
    const index = indexRef.current;
    const seen = seenRef.current;
    let added = false;
    let complete = 0;
    let idsMatch = true;
    let newest: TileRecord | null = null;

    for (const c of chunks) {
      if (c.status !== 'complete' || !c.heights) continue;
      complete++;
      if (!seen.has(c.id)) idsMatch = false;
      const prev = seen.get(c.id);
      if (prev === c) continue;
      seen.set(c.id, c);
      const rec: TileRecord = {
        face: c.face,
        x: c.x,
        y: c.y,
        heights: c.heights,
        materials: c.materials ?? null,
        dir: tileCenterDir(c.face, c.x, c.y, paramsRef.current.nPerFace),
      };
      index.set(tileKey(c.face, c.x, c.y), rec);
      added = true;
      newest = rec;
    }

    if (complete !== seen.size || !idsMatch) {
      const live = new Set<string>();
      for (const c of chunks) if (c.status === 'complete' && c.heights) live.add(c.id);
      for (const [id, chunk] of [...seen]) {
        if (live.has(id)) continue;
        seen.delete(id);
        const key = tileKey(chunk.face, chunk.x, chunk.y);
        index.delete(key);
        const mesh = meshesRef.current.get(key);
        if (mesh) disposeMesh(mesh);
        meshesRef.current.delete(key);
        added = true;
      }
    }

    if (newest && paramsRef.current.follow) {
      setFocusTile({ face: newest.face, x: newest.x, y: newest.y });
    }
    return added;
  }, [getChunks, disposeMesh]);

  // --- scene setup -----------------------------------------------------------

  useEffect(() => {
    const mountEl = mountRef.current;
    if (!mountEl) return;
    const w = Math.max(320, mountEl.clientWidth);
    const h = Math.max(240, mountEl.clientHeight);

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x05040a);
    scene.fog = null;

    const camera = new THREE.PerspectiveCamera(48, w / h, 1, 1e8);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    rendererRef.current = renderer;
    mountEl.appendChild(renderer.domElement);

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    materialRef.current = material;

    const group = new THREE.Group();
    groupRef.current = group;
    scene.add(group);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(MARS_RADIUS_M - 12_000, 96, 64),
      new THREE.MeshStandardMaterial({
        color: 0x7a3926,
        roughness: 0.97,
        metalness: 0.02,
      }),
    );
    planetRef.current = planet;
    scene.add(planet);

    const atmos = new THREE.Mesh(
      new THREE.SphereGeometry(MARS_RADIUS_M * 1.04, 64, 48),
      new THREE.MeshBasicMaterial({
        color: 0xd4784a,
        transparent: true,
        opacity: 0.16,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    scene.add(atmos);

    const stars = makeStarField();
    scene.add(stars);

    const gridMat = new THREE.LineBasicMaterial({ color: 0xffb389, transparent: true, opacity: 0.28 });
    const gridGeo = new THREE.BufferGeometry();
    const grid = new THREE.LineSegments(gridGeo, gridMat);
    grid.frustumCulled = false;
    gridRef.current = grid;
    scene.add(grid);

    const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
    sunRef.current = sun;
    scene.add(sun);
    const hemi = new THREE.HemisphereLight(0xc9a48a, 0x1a0c0a, 0.22);
    hemiRef.current = hemi;
    scene.add(hemi);

    const el = renderer.domElement;
    const onPointerDown = (e: PointerEvent) => {
      cameraTouchedRef.current = true;
      draggingRef.current = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      const g = globeRef.current;
      const hh = Math.max(1, el.clientHeight);
      // Grab-the-planet: one pixel matches the angular size of a pixel at
      // the surface under the camera, so altitude is unchanged while panning.
      const sens = (2 * Math.tan((camera.fov * DEG) / 2)) / hh;
      // East is drawn on the right (planetToScene), so walking the camera west
      // for a rightward drag is what carries the terrain right with the
      // cursor; dragging down likewise walks it north.
      g.lat = clampLat(g.lat + dy * sens);
      g.lon = wrapLon(g.lon - dx * sens / Math.max(0.12, Math.cos(g.lat)));
    };
    const onPointerUp = (e: PointerEvent) => {
      draggingRef.current = null;
      el.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTouchedRef.current = true;
      const g = globeRef.current;
      g.altitude = Math.max(
        MIN_ALTITUDE_M,
        Math.min(MAX_ALTITUDE_M, g.altitude * Math.exp(e.deltaY * 0.0012)),
      );
    };
    const onContext = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'c', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        cameraTouchedRef.current = true;
      }
      keysRef.current.add(k);
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const onResize = () => {
      if (!mountEl || !cameraRef.current || !rendererRef.current) return;
      const nw = Math.max(320, mountEl.clientWidth);
      const nh = Math.max(240, mountEl.clientHeight);
      cameraRef.current.aspect = nw / nh;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(nw, nh);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mountEl);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsClock = last;
    let hudClock = last;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = paramsRef.current;
      const camera = cameraRef.current;
      const g = globeRef.current;

      if (now - lastSyncRef.current > SYNC_MS) {
        lastSyncRef.current = now;
        if (syncTiles()) buildWindowRef.current('auto');
        if (indexRef.current.size > meshesRef.current.size) buildWindowRef.current('auto');
      }

      if (p.autoRotate && !draggingRef.current) {
        g.lon = wrapLon(g.lon + dt * 0.08);
      }
      const goal = fitGoalRef.current;
      if (goal) {
        if (cameraTouchedRef.current) {
          fitGoalRef.current = null;
        } else {
          const k = 1 - Math.exp(-dt * 2.5);
          const dLon = Math.atan2(Math.sin(goal.lon - g.lon), Math.cos(goal.lon - g.lon));
          g.lat += (goal.lat - g.lat) * k;
          g.lon = wrapLon(g.lon + dLon * k);
          if (goal.altitude !== null) g.altitude += (goal.altitude - g.altitude) * k;
          const close = Math.abs(goal.lat - g.lat) < 0.001 && Math.abs(dLon) < 0.001 &&
            (goal.altitude === null || Math.abs(goal.altitude - g.altitude) < 20);
          if (close) fitGoalRef.current = null;
        }
      }

      if (p.mode === 'fly') {
        const keys = keysRef.current;
        const speed = 4 * Math.pow(1.09, p.flySpeedIdx) * (keys.has('shift') ? 4 : 1);
        const rate = dt * 0.42 * (speed / 40);
        let mf = 0, ms = 0, mv = 0;
        if (keys.has('w') || keys.has('arrowup')) mf += 1;
        if (keys.has('s') || keys.has('arrowdown')) mf -= 1;
        if (keys.has('d') || keys.has('arrowright')) ms += 1;
        if (keys.has('a') || keys.has('arrowleft')) ms -= 1;
        if (keys.has(' ') || keys.has('e')) mv += 1;
        if (keys.has('q') || keys.has('c')) mv -= 1;
        if (mf || ms) {
          g.lat = clampLat(g.lat + mf * rate);
          g.lon = wrapLon(g.lon + ms * rate / Math.max(0.12, Math.cos(g.lat)));
        }
        if (mv) {
          g.altitude = Math.max(
            MIN_ALTITUDE_M,
            Math.min(MAX_ALTITUDE_M, g.altitude * Math.exp(mv * dt * 0.85)),
          );
        }
      }

      if (camera) applyCameraPose(camera);

      if (sunRef.current) {
        const az = p.sunAz * DEG;
        const sEl = Math.sin(p.sunEl * DEG);
        const cEl = Math.cos(p.sunEl * DEG);
        // The sun bearing is set over the planet, so place it in the planet
        // frame and convert — otherwise un-mirroring the globe would light it
        // from the opposite side.
        const sunDir = planetToScene({ x: Math.sin(az) * cEl, y: sEl, z: -Math.cos(az) * cEl });
        sunRef.current.position.set(sunDir.x, sunDir.y, sunDir.z);
        sunRef.current.position.multiplyScalar(MARS_RADIUS_M * 20);
        sunRef.current.intensity = 1.5 + 1.4 * Math.max(0, sEl);
      }
      if (hemiRef.current) hemiRef.current.intensity = 0.12 + 0.18 * Math.max(0.15, Math.sin(p.sunEl * DEG));

      drainQueueRef.current(BUILD_BUDGET_MS);
      const vis = updateVisibilityRef.current();

      if (rendererRef.current && sceneRef.current && camera) {
        rendererRef.current.render(sceneRef.current, camera);
      }

      frames++;
      if (now - fpsClock > 500) {
        fpsRef.current = Math.round((frames * 1000) / (now - fpsClock));
        frames = 0;
        fpsClock = now;
      }
      if (now - hudClock > 180) {
        hudClock = now;
        let elevation: number | null = null;
        let matId: number | null = null;
        let lat = 0, lon = 0, agl = 0, tile: string | null = null;
        if (camera) {
          const dir = dirFromLatLon(g.lat, g.lon);
          const s = sampleTerrain(dir, indexRef.current, p.nPerFace, p.resolution);
          lat = s.lat;
          lon = s.lon;
          elevation = s.elevation;
          matId = s.material;
          tile = s.tile ? `F${s.tile.face}-${s.tile.x}-${s.tile.y}` : null;
          agl = g.altitude;
        }
        const tiles = vis;
        setHud({
          fps: fpsRef.current,
          tiles,
          triangles: tiles * (p.resolution - 1) * (p.resolution - 1) * 2,
          span: g.altitude,
          lat, lon, elevation, agl, material: matId, tile,
        });
        const noneVisible = indexRef.current.size > 0 && vis === 0 && meshesRef.current.size > 0;
        setVoidView(noneVisible);
        rebuildGridRef.current();
      }
    };
    raf = requestAnimationFrame(loop);
    buildWindowRef.current('frame');

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      for (const mesh of meshesRef.current.values()) disposeMesh(mesh);
      meshesRef.current.clear();
      buildQueueRef.current = [];
      gridGeo.dispose();
      gridMat.dispose();
      material.dispose();
      planet.geometry.dispose();
      (planet.material as THREE.Material).dispose();
      atmos.geometry.dispose();
      (atmos.material as THREE.Material).dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      renderer.dispose();
      if (el.parentElement === mountEl) mountEl.removeChild(el);
      sceneRef.current = null;
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions ---------------------------------------------------------------

  const recenter = useCallback(() => {
    cameraTouchedRef.current = false;
    buildWindowRef.current('recenter');
  }, []);

  const dropToCruise = useCallback(() => {
    cameraTouchedRef.current = false;
    const g = globeRef.current;
    fitGoalRef.current = { lat: g.lat, lon: g.lon, altitude: CRUISE_ALTITUDE_M };
  }, []);

  const focusOnNearest = useCallback(() => {
    const index = indexRef.current;
    if (index.size === 0) return;
    const g = globeRef.current;
    const camDir = dirFromLatLon(g.lat, g.lon);
    let best: TileRecord | null = null;
    let bestD = Infinity;
    for (const rec of index.values()) {
      const d = angleBetween(rec.dir, camDir);
      if (d < bestD) { bestD = d; best = rec; }
    }
    if (best) {
      setFocusTile({ face: best.face, x: best.x, y: best.y });
      const look = latLonRadFromDir(best.dir);
      cameraTouchedRef.current = false;
      fitGoalRef.current = { lat: look.lat, lon: look.lon, altitude: null };
    }
  }, []);

  const screenshot = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = `mars-terrain-${focusKey || 'view'}.png`;
    a.click();
  }, [focusKey]);

  const flySpeed = useMemo(() => 4 * Math.pow(1.09, flySpeedIdx), [flySpeedIdx]);
  const focusLabel = focusTile ? `F${focusTile.face}-${focusTile.x}-${focusTile.y}` : '—';

  return (
    <div className="viewer">
      <div className="viewerHead">
        <div className="viewerTitle">
          <div className="viewerLogo"><Mountain /></div>
          <div>
            <span>TERRAIN RENDERER</span>
            <h2>Orbit the generated planet</h2>
          </div>
        </div>
        <div className="viewerHeadMeta">
          <span><b>{fmt(hud.tiles)}</b> tiles in view</span>
          <span><b>{fmt(hud.triangles)}</b> tris</span>
          <span>focus <b>{focusLabel}</b></span>
          <span>{nPerFace} × {nPerFace} grid · {resolution}² verts/tile</span>
        </div>
        <div className="viewerHeadActions">
          <button onClick={() => setUiHidden(v => !v)} title={uiHidden ? 'Show controls' : 'Hide controls'}>
            {uiHidden ? <Eye /> : <EyeOff />}
          </button>
          <button onClick={onClose} title="Close renderer"><X /></button>
        </div>
      </div>

      <div className="viewerBody">
        {!uiHidden && (
          <aside className="viewerPanel">
            <section>
              <h3><Move3d /> Camera</h3>
              <div className="seg">
                <button className={mode === 'orbit' ? 'on' : ''} onClick={() => setMode('orbit')}>Orbit</button>
                <button className={mode === 'fly' ? 'on' : ''} onClick={() => setMode('fly')}>Fly</button>
              </div>
              {mode === 'fly' ? (
                <>
                  <label className="sliderRow">
                    <span>SPEED</span>
                    <b>{formatMeters(flySpeed)}/s</b>
                    <input type="range" min={0} max={60} step={1} value={flySpeedIdx}
                      onChange={e => setFlySpeedIdx(Number(e.target.value))} />
                  </label>
                  <p className="hint">
                    <b>WASD</b> pan at the current altitude · <b>Q</b> closer · <b>E</b> farther ·
                    {' '}<b>Shift</b> boost. Altitude never changes while panning.
                  </p>
                </>
              ) : (
                <>
                  <p className="hint">
                    Drag to orbit the planet · wheel to zoom (down to {formatMeters(MIN_ALTITUDE_M)}) ·
                    {' '}panning keeps your altitude
                  </p>
                  <label className="checkRow">
                    <input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} />
                    <span>Auto-rotate</span>
                  </label>
                </>
              )}
              <button className="panelBtn" onClick={recenter}
                title="Pull back until the whole planet is in view"><Crosshair /> Show whole planet</button>
              <button className="panelBtn" onClick={dropToCruise}
                title="Descend to 1 km above the surface and keep that altitude while panning">
                <Crosshair /> Cruise at {formatMeters(CRUISE_ALTITUDE_M)}
              </button>
            </section>

            <section>
              <h3><Layers /> Shading</h3>
              <div className="seg">
                <button className={shade === 'material' ? 'on' : ''} onClick={() => setShade('material')}>Material</button>
                <button className={shade === 'elevation' ? 'on' : ''} onClick={() => setShade('elevation')}>Elevation</button>
                <button className={shade === 'slope' ? 'on' : ''} onClick={() => setShade('slope')}>Slope</button>
              </div>
              {shade === 'material' && (
                <>
                  <ul className="legend">
                    {MATERIAL_LABELS.map((label, i) => (
                      <li key={label}><i style={{ background: materialHex(i) }} />{label}</li>
                    ))}
                  </ul>
                  <p className="hint">MOLA supplies elevations, not mineral or surface-material classifications.</p>
                </>
              )}
              {shade === 'elevation' && (
                <div className="ramp">
                  <i style={{ background: ELEVATION_LEGEND }} />
                  <div><span>−8 km</span><span>+6 km</span><span>+21 km</span></div>
                </div>
              )}
              {shade === 'slope' && (
                <div className="ramp">
                  <i style={{ background: 'linear-gradient(90deg,#d9c9bb,#3a2f2c)' }} />
                  <div><span>flat dust</span><span>exposed rock</span></div>
                </div>
              )}
            </section>

            <section>
              <h3><Mountain /> Relief</h3>
              <label className="sliderRow" title="1× draws every chunk at its true elevation — 1 metre up is 1 metre across, straight from the MOLA-scale height grid. Higher values exaggerate relief vertically for readability.">
                <span>VERTICAL SCALE</span>
                <b>{exaggeration.toFixed(1)}×{exaggeration === 1 ? ' · true' : ''}</b>
                <input type="range" min={1} max={8} step={0.5} value={exaggeration}
                  onChange={e => setExaggeration(Number(e.target.value))} />
              </label>
            </section>

            <section>
              <h3><Grid3x3 /> Visible tiles</h3>
              <p className="hint">
                Every generated chunk is drawn on the planet. Chunks on the far side
                of the globe stay hidden until you orbit them into view.
              </p>
              <label className="checkRow">
                <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
                <span>Tile grid</span>
              </label>
              <label className="checkRow">
                <input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)} />
                <span>Wireframe</span>
              </label>
              <label className="checkRow">
                <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
                <span>Follow generation</span>
              </label>
              <button className="panelBtn" onClick={focusOnNearest}><Crosshair /> Center on nearest tile</button>
            </section>

            <section>
              <h3><Sun /> Sun</h3>
              <label className="sliderRow">
                <span>AZIMUTH</span>
                <b>{sunAz}°</b>
                <input type="range" min={0} max={359} step={1} value={sunAz}
                  onChange={e => setSunAz(Number(e.target.value))} />
              </label>
              <label className="sliderRow">
                <span>ELEVATION</span>
                <b>{sunEl}°</b>
                <input type="range" min={2} max={85} step={1} value={sunEl}
                  onChange={e => setSunEl(Number(e.target.value))} />
              </label>
              <label className="sliderRow" title="Exaggerates slopes in the lighting only (hillshade z-factor), so the sun direction reads on nearly flat terrain. 1× = true slopes.">
                <span>RELIEF SHADING</span>
                <b>{relief}×</b>
                <input type="range" min={1} max={20} step={1} value={relief}
                  onChange={e => setRelief(Number(e.target.value))} />
              </label>
            </section>

            <section>
              <h3><Camera /> Capture</h3>
              <button className="panelBtn" onClick={screenshot}><Camera /> Save PNG</button>
            </section>
          </aside>
        )}

        <div className="viewerStage" ref={mountRef}>
          {empty && (
            <div className="viewerEmpty">
              <Info />
              <h3>Planet ready — no tiles yet</h3>
              <p>
                The globe is here. Run generation and completed chunks appear on the
                surface; orbit to see the far side, zoom in to {formatMeters(MIN_ALTITUDE_M)}.
              </p>
            </div>
          )}
          {voidView && !empty && (
            <div className="viewerVoid">
              <Info />
              <span>No generated chunks on this hemisphere — orbit around, or use “Center on nearest tile”.</span>
            </div>
          )}

          <div className="viewerHud">
            <div className="hudRow">
              <span>LAT</span><b>{hud.lat >= 0 ? `${hud.lat.toFixed(3)}° N` : `${(-hud.lat).toFixed(3)}° S`}</b>
              <span>LON</span><b>{hud.lon >= 0 ? `${hud.lon.toFixed(3)}° E` : `${(-hud.lon).toFixed(3)}° W`}</b>
            </div>
            <div className="hudRow">
              <span>ELEV</span>
              <b>{hud.elevation === null ? 'no data' : `${Math.round(hud.elevation).toLocaleString('en-US')} m`}</b>
              <span>AGL</span>
              <b>{formatMeters(hud.agl)}</b>
            </div>
            <div className="hudRow">
              <span>TILE</span><b>{hud.tile ?? '—'}</b>
              {hud.material !== null &&
                <><span>MAT</span><b>{MATERIAL_LABELS[hud.material] ?? hud.material}</b></>}
            </div>
            <div className="hudRow dim">
              <span>FPS</span><b>{hud.fps}</b>
            </div>
          </div>

          <div className="viewerHint">
            {mode === 'fly'
              ? 'WASD pan at this altitude · Q closer · E farther · Shift boost'
              : 'Drag to orbit · wheel to zoom · altitude stays put while panning'}
          </div>
        </div>
      </div>
    </div>
  );
}

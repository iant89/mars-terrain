// Interactive 3D terrain renderer.
//
// Draws the generated .mars tiles as a seamless mesh in a local tangent frame
// (see terrain.ts). Tile selection is viewport-driven: on every rebuild the
// renderer picks the generated tiles that are actually visible from the
// camera — inside the view frustum and within the view distance — and streams
// their meshes in under a per-frame time budget. Whatever you look at fills
// in, no matter how large the run is (nearest tiles first, bounded by
// MAX_TILES); chunks outside the view are dropped instead of accumulating.
//
// The tangent frame re-anchors to the camera's look point as you pan or fly
// across the planet: the flat layout stays accurate everywhere (the
// azimuthal-equidistant projection is only good near its anchor) and local
// coordinates stay small. Re-anchoring re-expresses the camera pose in the new
// frame, so the view is continuous across the jump.
//
// Relief is drawn at true scale by default (1 m vertical per 1 m horizontal,
// straight from the Float32 elevation grids); the VERTICAL SCALE slider
// exaggerates it on demand.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  Mountain, X, Eye, EyeOff, Grid3x3, Sun, Move3d, Crosshair, Camera, Layers, Info,
} from 'lucide-react';
import { formatMeters, fmt, MARS_RADIUS_M } from './config';
import { Chunk } from './types';
import { Vec3, faceDirVec } from './region';
import {
  Frame, LocalPoint, ShadeMode, TileIndex, TileRecord, TileRef,
  MATERIAL_LABELS, angleBetween, buildTileGeometry, frameToDirection, localFrame,
  materialHex, projectToFrame, sampleTerrain, tileAngleRad, tileCenterDir, tileKey,
} from './terrain';

// Hard budget of simultaneously drawn tiles (a tile is ~2k triangles / ~64 KB
// of GPU buffers). Viewport selection is nearest-first, so this only bites
// when more tiles than this are on screen at once (zoomed far out).
const MAX_TILES = 2600;
// Largest manual view distance the UI offers, in tile-widths.
const MAX_VIEW_TILES = 48;
const SYNC_MS = 180;        // queue poll interval
const REBUILD_MS = 120;     // minimum delay between viewport reselections
const BUILD_BUDGET_MS = 7;  // per-frame budget for streaming tile meshes in
// Past this much drift between the camera's look point and the frame anchor,
// the local frame re-anchors (keeps the projection accurate planet-wide and
// vertex coordinates small). Re-anchoring is deferred while a drag is held.
const REANCHOR_FLAT = 0.44;    // ~25°: the flat layout starts distorting past ~30°
const REANCHOR_CURVED = 0.7;   // ~40°: the curved layout is exact anywhere
// Angular radius from the frame anchor that each layout can draw without
// visible distortion (the flat layout stretches circumferentially with
// distance: 4.7% at 30°, 21% at 60°).
const SEL_ANGLE_FLAT = 1.05;   // ~60°
const SEL_ANGLE_CURVED = 1.55; // ~89°: the true sphere just dips under the horizon

const DEG = Math.PI / 180;
const ELEVATION_LEGEND =
  'linear-gradient(90deg,#3b2f36,#6b4b40,#8f5a3c,#b06a41,#c9875a,#dda377,#e9c39c,#f2ddc4)';

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

function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#1c1012');
  grad.addColorStop(0.42, '#5b3524');
  grad.addColorStop(0.5, '#a9663c');
  grad.addColorStop(0.58, '#6d3f28');
  grad.addColorStop(1, '#180d0c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function TerrainViewer({ getChunks, nPerFace, resolution, focus, onClose }: TerrainViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  const [shade, setShade] = useState<ShadeMode>('material');
  // 1 = true scale: every vertex sits at its actual elevation in metres.
  // Higher values exaggerate relief vertically (opt-in, for readability).
  const [exaggeration, setExaggeration] = useState(1);
  // View distance: how far from the camera generated tiles are drawn. Auto
  // mode follows the camera zoom (zoom out to reveal more terrain, with fog
  // hiding the edge); the slider pins a fixed distance in tile-widths.
  const [autoView, setAutoView] = useState(true);
  const [viewTiles, setViewTiles] = useState(6);
  const [effViewTiles, setEffViewTiles] = useState(6);
  const [curvature, setCurvature] = useState(false);
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
  const [locked, setLocked] = useState(false);

  // --- three.js handles ------------------------------------------------------
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const gridRef = useRef<THREE.LineSegments | null>(null);
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const hemiRef = useRef<THREE.HemisphereLight | null>(null);
  const fogRef = useRef<THREE.Fog | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);

  // --- tile data -------------------------------------------------------------
  const indexRef = useRef<TileIndex>(new Map());
  const seenRef = useRef<Map<string, Chunk>>(new Map());
  const meshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  // The current viewport window: everything the renderer knows about the
  // active frame and the selected tile set.
  const windowRef = useRef<{
    anchorDir: Vec3;      // planet direction the local frame is centred on
    frame: Frame;
    anchorGen: number;    // bumped on every re-anchor (invalidates meshes)
    tileAngle: number;    // angular width of one tile at the anchor (rad)
    viewDist: number;     // metres; tiles farther than this are not drawn
    tiles: TileRecord[];  // the selected (visible) tiles, nearest first
    meanElevation: number;
  } | null>(null);
  // Monotonic anchor generation: every (re-)anchor gets a fresh id, so caches
  // and mesh keys can never collide with a previous window's.
  const anchorSeqRef = useRef(0);
  // Local-frame centre + bounding radius per tile, keyed by tileKey. Valid
  // for one anchor/relief signature only (see cacheSigRef).
  const centerCacheRef = useRef<Map<string, { x: number; y: number; z: number; r: number }>>(new Map());
  const cacheSigRef = useRef('');
  const buildQueueRef = useRef<TileRecord[]>([]);
  const selectedKeysRef = useRef<Set<string>>(new Set());
  const geoKeyRef = useRef('');
  const dirtyRef = useRef(false);
  const lastSyncRef = useRef(0);
  const lastRebuildRef = useRef(0);
  const lastGridRef = useRef(0);
  const framedKeyRef = useRef('');
  const framedOnceRef = useRef(false);
  const framedNRef = useRef(0);
  const fpsRef = useRef(0);
  // Snapshot of the camera pose at the last selection: the render loop
  // compares against it to reselect when the camera moves or turns.
  const camPoseRef = useRef<{ pos: THREE.Vector3; dir: THREE.Vector3 } | null>(null);
  // Cleared for good once the user drags, zooms or flies — until then the
  // camera may ease itself (e.g. following generation).
  const cameraTouchedRef = useRef(false);
  // Orbit target the render loop eases towards while the camera is untouched.
  const fitGoalRef = useRef<{ target: THREE.Vector3; distance: number | null } | null>(null);

  const orbitRef = useRef({ theta: 0.6, phi: 1.02, distance: 1000, target: new THREE.Vector3() });
  const flyRef = useRef({ pos: new THREE.Vector3(0, 5000, 2000), yaw: 0, pitch: -0.2 });
  const keysRef = useRef<Set<string>>(new Set());
  const draggingRef = useRef<{ button: number; x: number; y: number; pan: boolean } | null>(null);
  const lockedRef = useRef(false);

  const focusKey = focusTile ? tileKey(focusTile.face, focusTile.x, focusTile.y) : '';

  // Everything the render loop and the rebuild routine need, mirrored from
  // React state so the three.js effect can stay mounted for the whole session.
  const paramsRef = useRef({
    shade, exaggeration, curvature, viewTiles, autoView, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile, relief,
  });
  paramsRef.current = {
    shade, exaggeration, curvature, viewTiles, autoView, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile, relief,
  };

  // --- window construction ---------------------------------------------------

  const disposeMesh = useCallback((mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    (mesh.parent ?? groupRef.current)?.remove(mesh);
  }, []);

  /** Camera pose from the orbit/fly state (shared by the render loop and the
   *  window rebuild, which needs a fresh frustum). */
  const applyCameraPose = useCallback((camera: THREE.PerspectiveCamera) => {
    const p = paramsRef.current;
    if (p.mode === 'orbit') {
      const o = orbitRef.current;
      const sinP = Math.sin(o.phi);
      camera.position.set(
        o.target.x + o.distance * sinP * Math.sin(o.theta),
        o.target.y + o.distance * Math.cos(o.phi),
        o.target.z + o.distance * sinP * Math.cos(o.theta),
      );
      camera.lookAt(o.target);
    } else {
      const f = flyRef.current;
      const cp = Math.cos(f.pitch);
      tmpA.set(Math.sin(f.yaw) * cp, Math.sin(f.pitch), -Math.cos(f.yaw) * cp);
      camera.position.copy(f.pos);
      camera.lookAt(tmpB.copy(f.pos).add(tmpA));
    }
    camera.updateMatrixWorld(true);
  }, []);

  /** Tile-boundary overlay for the meshes currently in the scene. */
  const rebuildGrid = useCallback(() => {
    const grid = gridRef.current;
    const win = windowRef.current;
    if (!grid || !win) return;
    const p = paramsRef.current;
    const res = p.resolution;
    const N = p.nPerFace;
    const corners = [[0, 0], [res - 1, 0], [res - 1, res - 1], [0, res - 1]] as const;
    const pts: number[] = [];
    for (const [key, mesh] of meshesRef.current) {
      const rec = indexRef.current.get(key);
      const st = mesh.userData.stats as { extent: number } | undefined;
      if (!rec || !st) continue;
      // Lifted slightly so the outline reads over the relief.
      const lift = Math.max(20, st.extent * 0.004);
      for (let ci = 0; ci < 4; ci++) {
        const [i0, j0] = corners[ci];
        const [i1, j1] = corners[(ci + 1) % 4];
        for (const [i, j] of [[i0, j0], [i1, j1]] as const) {
          const u = -1 + (2 * (rec.x + i / (res - 1))) / N;
          const v = -1 + (2 * (rec.y + j / (res - 1))) / N;
          const h = (rec.heights[j * res + i] ?? 0) + lift / Math.max(0.001, p.exaggeration);
          const pt = projectToFrame(faceDirVec(rec.face, u, v), h, win.frame, p.exaggeration, p.curvature);
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
   * `budgetMs` of wall time is spent (at least one tile per call). Big
   * re-anchors and zoom-outs therefore fill in progressively over a few
   * frames instead of freezing the tab.
   */
  const drainQueue = useCallback((budgetMs: number) => {
    const queue = buildQueueRef.current;
    const group = groupRef.current;
    const material = materialRef.current;
    const win = windowRef.current;
    if (!queue.length || !group || !material || !win) return;
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
      if (!selectedKeysRef.current.has(key)) continue;
      const nbrMask = nbrMaskOf(rec);
      const existing = meshesRef.current.get(key);
      if (existing && !existing.userData.stale && existing.userData.geoKey === geoKey &&
        existing.userData.heights === rec.heights && existing.userData.nbrMask === nbrMask &&
        existing.userData.stats) {
        continue; // already built with these exact inputs
      }

      const g = buildTileGeometry({
        face: rec.face,
        x: rec.x,
        y: rec.y,
        nPerFace: N,
        res,
        heights: rec.heights,
        materials: rec.materials,
        frame: win.frame,
        exaggeration: p.exaggeration,
        curvature: p.curvature,
        shade: p.shade,
        reliefShading: p.relief,
        neighbor,
      });

      let mesh = existing;
      if (mesh && mesh.geometry.getAttribute('position')?.count === res * res &&
        mesh.geometry.index?.count === g.indices.length) {
        // Same vertex count -> refresh the buffers in place (no realloc).
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
        rebuildGrid();
      }
    }
  }, [disposeMesh, rebuildGrid]);

  /**
   * Rebuild the visible window. `op`:
   *  - 'auto': reselect what the camera sees (re-anchoring the frame if the
   *    look point has drifted far, and sliding the target when the focus
   *    tile moved — e.g. Follow generation).
   *  - 'frame': full camera framing on the focus tile.
   *  - 'recenter': keep the look point, fit the orbit distance to the
   *    terrain visible around it.
   */
  const buildWindow = useCallback((op: 'auto' | 'frame' | 'recenter') => {
    const group = groupRef.current;
    const camera = cameraRef.current;
    if (!group || !camera) return;
    const p = paramsRef.current;
    const N = p.nPerFace;
    const res = p.resolution;
    const index = indexRef.current;

    const clearAll = () => {
      for (const mesh of meshesRef.current.values()) disposeMesh(mesh);
      meshesRef.current.clear();
      buildQueueRef.current = [];
      selectedKeysRef.current = new Set();
      windowRef.current = null;
      camPoseRef.current = null;
      fitGoalRef.current = null;
      setEmpty(true);
      setVoidView(false);
      if (gridRef.current) {
        gridRef.current.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      }
    };
    if (index.size === 0) {
      clearAll();
      return;
    }
    setEmpty(false);

    // Effective focus: the requested tile if it's generated, else the first
    // tile that completed (live preview).
    const first = index.values().next().value as TileRecord | undefined;
    const focusRec = p.focusTile
      ? index.get(tileKey(p.focusTile.face, p.focusTile.x, p.focusTile.y))
      : undefined;
    const anchorRec = focusRec ?? first;
    const focusTile: TileRef | null = anchorRec
      ? { face: anchorRec.face, x: anchorRec.x, y: anchorRec.y }
      : null;
    if (!focusTile) {
      clearAll();
      return;
    }

    // --- frame anchor ---------------------------------------------------------
    const prev = windowRef.current;
    let frame: Frame;
    let anchorDir: Vec3;
    let anchorGen: number;
    if (prev) {
      frame = prev.frame;
      anchorDir = prev.anchorDir;
      anchorGen = prev.anchorGen;
    } else {
      anchorDir = tileCenterDir(focusTile.face, focusTile.x, focusTile.y, N);
      frame = localFrame(anchorDir);
      anchorGen = 1;
    }
    const reanchorLimit = p.curvature ? REANCHOR_CURVED : REANCHOR_FLAT;
    // Where the frame wants to be: the tile being framed on explicit jumps,
    // else the point the camera is looking at.
    let candDir: Vec3;
    if (op === 'frame') {
      candDir = tileCenterDir(focusTile.face, focusTile.x, focusTile.y, N);
    } else {
      const look = p.mode === 'orbit' ? orbitRef.current.target : flyRef.current.pos;
      candDir = frameToDirection(look as unknown as LocalPoint, frame, p.curvature);
    }
    // Defer re-anchoring while a drag is held: the world stays put for the
    // gesture and re-projects once the pointer is released (pointerup pokes
    // the dirty flag).
    let reanchored = false;
    if (prev && !draggingRef.current && angleBetween(candDir, anchorDir) > reanchorLimit) {
      const oldFrame = frame;
      const nextFrame = localFrame(candDir);
      // Re-express the camera state in the new frame so the view continues
      // seamlessly: same look point, same height above the ground.
      const movePoint = (pt: THREE.Vector3): THREE.Vector3 => {
        const dir = frameToDirection(pt as unknown as LocalPoint, oldFrame, p.curvature);
        const elev = sampleTerrain(dir, index, N, res).elevation ?? 0;
        const base = projectToFrame(dir, elev, nextFrame, p.exaggeration, p.curvature);
        return new THREE.Vector3(base.x, base.y + (pt.y - elev * p.exaggeration), base.z);
      };
      orbitRef.current.target.copy(movePoint(orbitRef.current.target));
      flyRef.current.pos.copy(movePoint(flyRef.current.pos));
      if (fitGoalRef.current) fitGoalRef.current.target = movePoint(fitGoalRef.current.target);
      frame = nextFrame;
      anchorDir = candDir;
      anchorGen = ++anchorSeqRef.current;
      centerCacheRef.current.clear();
      // Existing meshes are in the old projection — hide them until each is
      // rebuilt from the queue.
      for (const mesh of meshesRef.current.values()) {
        mesh.visible = false;
        mesh.userData.stale = true;
      }
      reanchored = true;
    }
    // Tile centres depend on the anchor, the grid density and the relief
    // parameters.
    const sig = `${anchorGen}|${N}|${res}|${p.exaggeration}|${p.curvature ? 1 : 0}`;
    if (cacheSigRef.current !== sig) {
      cacheSigRef.current = sig;
      centerCacheRef.current.clear();
    }

    // --- camera framing (before the frustum is taken) --------------------------
    const tileAngle = tileAngleRad(focusTile.face, focusTile.x, focusTile.y, N);
    const groundR = MARS_RADIUS_M * tileAngle; // one tile-width in metres
    const focusLocal = () => {
      const fdir = tileCenterDir(focusTile!.face, focusTile!.x, focusTile!.y, N);
      const elev = sampleTerrain(fdir, index, N, res).elevation ?? 0;
      return projectToFrame(fdir, elev, frame, p.exaggeration, p.curvature);
    };
    if (op === 'frame' || !framedOnceRef.current || framedNRef.current !== N) {
      framedKeyRef.current = `${N}|${focusTile.face}-${focusTile.x}-${focusTile.y}`;
      framedOnceRef.current = true;
      framedNRef.current = N;
      fitGoalRef.current = null;
      const tp = focusLocal();
      const D = Math.max(3000, groundR * 0.75 * 2.2);
      orbitRef.current.target.set(tp.x, tp.y, tp.z);
      orbitRef.current.distance = D;
      flyRef.current.pos.set(tp.x + D * 0.45, tp.y + D * 0.35, tp.z + D * 0.55);
      const d = new THREE.Vector3(tp.x, tp.y, tp.z).sub(flyRef.current.pos).normalize();
      flyRef.current.yaw = Math.atan2(d.x, -d.z);
      flyRef.current.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    }

    // --- camera pose + view distance ------------------------------------------
    const camDist = p.mode === 'orbit'
      ? orbitRef.current.distance
      : Math.max(2000, flyRef.current.pos.y);
    const viewDist = p.autoView
      ? Math.max(45_000, camDist * 2.6 + groundR)
      : Math.max(groundR * 1.05, p.viewTiles * groundR);
    setEffViewTiles(Math.max(1, Math.round(viewDist / groundR)));
    // Refresh the projection before taking the frustum, so the far plane
    // always covers the view distance being selected against.
    camera.near = Math.max(0.5, camDist / 3000);
    camera.far = viewDist * 2.2 + camDist;
    camera.updateProjectionMatrix();
    applyCameraPose(camera);
    scratchMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    scratchFrustum.setFromProjectionMatrix(scratchMat);
    const camPos = camera.position;

    // --- selection: every generated tile visible from the camera ---------------
    const selAngle = p.curvature ? SEL_ANGLE_CURVED : SEL_ANGLE_FLAT;
    const margin = viewDist * 0.05;
    const centerCache = centerCacheRef.current;
    const chosen: { rec: TileRecord; d: number }[] = [];
    for (const rec of index.values()) {
      if (angleBetween(rec.dir, anchorDir) > selAngle) continue;
      const key = tileKey(rec.face, rec.x, rec.y);
      let c = centerCache.get(key);
      if (!c) {
        const lc = projectToFrame(rec.dir, 0, frame, p.exaggeration, p.curvature);
        const ta = tileAngleRad(rec.face, rec.x, rec.y, N);
        c = { x: lc.x, y: lc.y, z: lc.z, r: MARS_RADIUS_M * ta * 0.75 + 26_000 * p.exaggeration };
        centerCache.set(key, c);
      }
      const d = Math.hypot(c.x - camPos.x, c.y - camPos.y, c.z - camPos.z) - c.r;
      if (d > viewDist + margin) continue;
      scratchSphere.center.set(c.x, c.y, c.z);
      scratchSphere.radius = c.r + margin;
      if (!scratchFrustum.intersectsSphere(scratchSphere)) continue;
      chosen.push({ rec, d });
    }
    chosen.sort((a, b) =>
      a.d - b.d || a.rec.face - b.rec.face || a.rec.y - b.rec.y || a.rec.x - b.rec.x);
    if (chosen.length > MAX_TILES) chosen.length = MAX_TILES;
    setVoidView(chosen.length === 0);

    // --- drop meshes that left the view; queue the rest -------------------------
    const geoKey = `${N}|${res}|${p.exaggeration}|${p.curvature ? 1 : 0}|${p.shade}|${p.relief}|${anchorGen}`;
    geoKeyRef.current = geoKey;
    const selected = new Set(chosen.map(c => tileKey(c.rec.face, c.rec.x, c.rec.y)));
    selectedKeysRef.current = selected;
    if (selected.size > 0) {
      for (const [key, mesh] of [...meshesRef.current]) {
        if (!selected.has(key)) {
          disposeMesh(mesh);
          meshesRef.current.delete(key);
        }
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
    for (const { rec } of chosen) {
      const mesh = meshesRef.current.get(tileKey(rec.face, rec.x, rec.y));
      if (mesh && !mesh.userData.stale && mesh.userData.geoKey === geoKey &&
        mesh.userData.heights === rec.heights && mesh.userData.nbrMask === nbrMaskOf(rec) &&
        mesh.userData.stats) {
        continue;
      }
      queue.push(rec);
    }
    buildQueueRef.current = queue;

    // --- window record, fog and camera planes -----------------------------------
    const lookPt = p.mode === 'orbit' ? orbitRef.current.target : flyRef.current.pos;
    const lookDir = frameToDirection(lookPt as unknown as LocalPoint, frame, p.curvature);
    const meanElevation = sampleTerrain(lookDir, index, N, res).elevation ?? 0;
    windowRef.current = {
      anchorDir, frame, anchorGen, tileAngle, viewDist,
      tiles: chosen.map(c => c.rec),
      meanElevation,
    };
    {
      // Fog bounds what's drawn: the view distance, and — in the flat layout —
      // the angular cap that the projection can draw without distortion.
      const fog = fogRef.current;
      const edge = MARS_RADIUS_M * selAngle;
      const far = Math.max(2000, Math.min(viewDist * 1.05, camDist + edge));
      if (fog) {
        fog.near = far * 0.55;
        fog.far = far;
      }
    }

    // --- follow / recenter -------------------------------------------------------
    const effKey = `${N}|${focusTile.face}-${focusTile.x}-${focusTile.y}`;
    if (op === 'recenter') {
      // Keep the look point; fit the orbit distance to the visible terrain.
      const t = orbitRef.current.target;
      let reach = 0;
      for (const { rec } of chosen) {
        const c = centerCache.get(tileKey(rec.face, rec.x, rec.y));
        if (c) reach = Math.max(reach, Math.hypot(c.x - t.x, c.z - t.z) + c.r);
      }
      if (reach > 0) orbitRef.current.distance = Math.max(3000, reach * 1.9);
      fitGoalRef.current = null;
      // The distance change moved the camera: reselect with the new pose.
      dirtyRef.current = true;
    } else if (framedKeyRef.current !== effKey) {
      framedKeyRef.current = effKey;
      // Focus moved (Follow generation, Center on nearest tile): slide the
      // orbit target there, keeping the user's zoom and angles.
      const tp = focusLocal();
      fitGoalRef.current = { target: new THREE.Vector3(tp.x, tp.y, tp.z), distance: null };
      const D = orbitRef.current.distance;
      flyRef.current.pos.set(tp.x + D * 0.45, tp.y + D * 0.35, tp.z + D * 0.55);
      const d = new THREE.Vector3(tp.x, tp.y, tp.z).sub(flyRef.current.pos).normalize();
      flyRef.current.yaw = Math.atan2(d.x, -d.z);
      flyRef.current.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    }

    // --- grid + first build burst -------------------------------------------------
    rebuildGrid();
    drainQueue(op === 'frame' || reanchored || meshesRef.current.size === 0 ? 24 : BUILD_BUDGET_MS);

    // Snapshot for the camera-motion dirty check in the render loop.
    camPoseRef.current = {
      pos: camera.position.clone(),
      dir: camera.getWorldDirection(scratchVec3).clone(),
    };
  }, [disposeMesh, applyCameraPose, rebuildGrid, drainQueue]);

  const buildWindowRef = useRef(buildWindow);
  buildWindowRef.current = buildWindow;
  const drainQueueRef = useRef(drainQueue);
  drainQueueRef.current = drainQueue;

  // Reselect on any change that alters geometry or the visible set.
  useEffect(() => {
    buildWindowRef.current('auto');
  }, [focusKey, viewTiles, autoView, exaggeration, curvature, shade, relief, nPerFace, resolution]);

  // Grid overlay / wireframe are cheap: apply without rebuilding geometry.
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
      if (prev === c) continue;           // unchanged object identity
      seen.set(c.id, c);
      // Keyed by tile (face-x-y), not by chunk id: the geometry lookups and
      // the sampler all address tiles by their cube-sphere position.
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

    // Removals (reset, re-generate) show up as a count mismatch.
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
    // Without "Follow generation" the view stays where it is and newly
    // completed chunks simply stream into it wherever they are.
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
    const sky = makeSkyTexture();
    scene.background = sky;
    const fog = new THREE.Fog(0x8a5238, 1e4, 1e6);
    fogRef.current = fog;
    scene.fog = fog;

    const camera = new THREE.PerspectiveCamera(48, w / h, 1, 1e6);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
      preserveDrawingBuffer: true, // screenshots
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
    });
    materialRef.current = material;

    const group = new THREE.Group();
    groupRef.current = group;
    scene.add(group);

    const gridMat = new THREE.LineBasicMaterial({ color: 0xffb389, transparent: true, opacity: 0.22 });
    const gridGeo = new THREE.BufferGeometry();
    const grid = new THREE.LineSegments(gridGeo, gridMat);
    grid.frustumCulled = false;
    gridRef.current = grid;
    scene.add(grid);

    const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    sunRef.current = sun;
    scene.add(sun);
    const hemi = new THREE.HemisphereLight(0xffd2ac, 0x2a1512, 0.55);
    hemiRef.current = hemi;
    scene.add(hemi);

    // --- interaction ---------------------------------------------------------
    const el = renderer.domElement;
    const onPointerDown = (e: PointerEvent) => {
      cameraTouchedRef.current = true;
      if (paramsRef.current.mode === 'fly') {
        if (!lockedRef.current) el.requestPointerLock?.();
        return;
      }
      draggingRef.current = { button: e.button, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (lockedRef.current && paramsRef.current.mode === 'fly') {
        const f = flyRef.current;
        f.yaw += (e.movementX || 0) * 0.0022;
        f.pitch = Math.max(-1.5, Math.min(1.5, f.pitch - (e.movementY || 0) * 0.0022));
        return;
      }
      const d = draggingRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      const o = orbitRef.current;
      if (d.pan) {
        const scale = o.distance * 0.0016;
        const fwd = tmpA.set(-Math.sin(o.theta), 0, -Math.cos(o.theta));
        const right = tmpB.crossVectors(fwd, UP);
        o.target.addScaledVector(right, -dx * scale);
        o.target.addScaledVector(fwd, dy * scale);
      } else {
        o.theta -= dx * 0.005;
        o.phi = Math.max(0.04, Math.min(1.54, o.phi - dy * 0.005));
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      draggingRef.current = null;
      el.releasePointerCapture?.(e.pointerId);
      // A drag may have carried the look point past the re-anchor threshold
      // (deferred during the gesture): reselect now.
      dirtyRef.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTouchedRef.current = true;
      const o = orbitRef.current;
      const max = Math.max(2e6, MARS_RADIUS_M * 4);
      o.distance = Math.max(5, Math.min(max, o.distance * Math.exp(e.deltaY * 0.0012)));
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
      if (e.key === 'Escape' && lockedRef.current) document.exitPointerLock?.();
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
    const onLockChange = () => {
      lockedRef.current = document.pointerLockElement === el;
      setLocked(lockedRef.current);
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerlockchange', onLockChange);

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

    // --- frame loop ----------------------------------------------------------
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let fpsClock = last;
    let hudClock = last;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      // Own clock: requestAnimationFrame timestamps can use a different time
      // origin than performance.now() in some environments.
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const p = paramsRef.current;
      const camera = cameraRef.current;

      // 1. Queue sync: new tiles mark the viewport dirty.
      if (now - lastSyncRef.current > SYNC_MS) {
        lastSyncRef.current = now;
        if (syncTiles()) dirtyRef.current = true;
        if (!windowRef.current && indexRef.current.size > 0) dirtyRef.current = true;
      }

      // 2. Orbit easing / auto-rotate, then fly movement — before the pose
      //    is applied so this frame renders the eased position.
      if (p.mode === 'orbit') {
        const o = orbitRef.current;
        if (p.autoRotate) o.theta += dt * 0.08;
        const goal = fitGoalRef.current;
        if (goal) {
          if (cameraTouchedRef.current) {
            fitGoalRef.current = null;
          } else {
            const k = 1 - Math.exp(-dt * 2.5);
            o.target.lerp(goal.target, k);
            if (goal.distance !== null) o.distance += (goal.distance - o.distance) * k;
            if (o.target.distanceTo(goal.target) < 1 &&
              (goal.distance === null || Math.abs(goal.distance - o.distance) < 1)) {
              fitGoalRef.current = null;
            }
          }
        }
      } else {
        const f = flyRef.current;
        const keys = keysRef.current;
        const speed = 4 * Math.pow(1.09, p.flySpeedIdx) * (keys.has('shift') ? 4 : 1);
        const cp = Math.cos(f.pitch);
        const fwd = tmpA.set(Math.sin(f.yaw) * cp, Math.sin(f.pitch), -Math.cos(f.yaw) * cp);
        const right = tmpB.set(Math.cos(f.yaw), 0, Math.sin(f.yaw));
        let mf = 0, ms = 0, mv = 0;
        if (keys.has('w') || keys.has('arrowup')) mf += 1;
        if (keys.has('s') || keys.has('arrowdown')) mf -= 1;
        if (keys.has('d') || keys.has('arrowright')) ms += 1;
        if (keys.has('a') || keys.has('arrowleft')) ms -= 1;
        if (keys.has(' ') || keys.has('e')) mv += 1;
        if (keys.has('q') || keys.has('c')) mv -= 1;
        if (mf || ms || mv) {
          tmpC.set(0, 0, 0)
            .addScaledVector(fwd, mf)
            .addScaledVector(right, ms)
            .addScaledVector(UP, mv);
          if (tmpC.lengthSq() > 0) f.pos.addScaledVector(tmpC.normalize(), speed * dt);
        }
      }

      // 3. Camera pose from the orbit/fly state.
      if (camera) applyCameraPose(camera);

      // 4. Viewport reselection trigger: the camera moved or turned since
      //    the last selection.
      const pose = camPoseRef.current;
      const win = windowRef.current;
      if (camera && pose && win) {
        camera.getWorldDirection(scratchVec3);
        if (camera.position.distanceTo(pose.pos) > Math.max(60, win.viewDist * 0.015) ||
          scratchVec3.angleTo(pose.dir) > 0.02) {
          dirtyRef.current = true;
        }
      }

      // 5. Reselect (throttled).
      if (dirtyRef.current && now - lastRebuildRef.current > REBUILD_MS) {
        dirtyRef.current = false;
        lastRebuildRef.current = now;
        buildWindowRef.current('auto');
      }

      // Sun: azimuth measured from north, clockwise, in local coordinates.
      if (sunRef.current) {
        const az = p.sunAz * DEG;
        const sEl = Math.sin(p.sunEl * DEG);
        sunRef.current.position.set(
          Math.sin(az) * Math.cos(p.sunEl * DEG),
          sEl,
          -Math.cos(az) * Math.cos(p.sunEl * DEG),
        );
        sunRef.current.position.multiplyScalar(Math.max(1e4, (windowRef.current?.viewDist ?? 1e4) * 2));
        sunRef.current.intensity = 1.6 + 1.4 * Math.max(0, sEl);
      }
      if (hemiRef.current) hemiRef.current.intensity = 0.35 + 0.35 * Math.max(0.15, Math.sin(p.sunEl * DEG));

      // 6. Stream pending tile meshes in (time-budgeted).
      drainQueueRef.current(BUILD_BUDGET_MS);

      // 7. Render.
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
        const win2 = windowRef.current;
        let elevation: number | null = null;
        let material: number | null = null;
        let lat = 0, lon = 0, agl = 0, tile: string | null = null;
        if (win2 && camera) {
          // Orbit: report the point being looked at (the camera can hover far
          // outside the generated window). Fly: the ground under the camera.
          const probe = p.mode === 'orbit' ? orbitRef.current.target : camera.position;
          const dir = frameToDirection(probe as unknown as LocalPoint, win2.frame, p.curvature);
          const s = sampleTerrain(dir, indexRef.current, p.nPerFace, p.resolution);
          lat = s.lat;
          lon = s.lon;
          elevation = s.elevation;
          material = s.material;
          tile = s.tile ? `F${s.tile.face}-${s.tile.x}-${s.tile.y}` : null;
          if (elevation !== null) agl = camera.position.y - elevation * p.exaggeration;
        }
        const tiles = win2?.tiles.length ?? 0;
        setHud({
          fps: fpsRef.current,
          tiles,
          triangles: tiles * (p.resolution - 1) * (p.resolution - 1) * 2,
          span: win2?.viewDist ?? 0,
          lat, lon, elevation, agl, material, tile,
        });
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
      document.removeEventListener('pointerlockchange', onLockChange);
      if (document.pointerLockElement === el) document.exitPointerLock?.();
      for (const mesh of meshesRef.current.values()) disposeMesh(mesh);
      meshesRef.current.clear();
      buildQueueRef.current = [];
      windowRef.current = null;
      gridGeo.dispose();
      gridMat.dispose();
      material.dispose();
      sky.dispose();
      renderer.dispose();
      if (el.parentElement === mountEl) mountEl.removeChild(el);
      sceneRef.current = null;
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions ---------------------------------------------------------------

  // Fit the orbit distance to the terrain visible around the look point.
  const recenter = useCallback(() => {
    buildWindowRef.current('recenter');
  }, []);

  const focusOnNearest = useCallback(() => {
    const index = indexRef.current;
    if (index.size === 0) return;
    const win = windowRef.current;
    const camera = cameraRef.current;
    const refocus = () => window.setTimeout(() => buildWindowRef.current('frame'), 0);
    if (!win || !camera) {
      const any = index.values().next().value as TileRecord | undefined;
      if (any) {
        setFocusTile({ face: any.face, x: any.x, y: any.y });
        refocus();
      }
      return;
    }
    // Orbit mode is centred on its target; fly mode uses the point under the
    // camera. This keeps "Center on nearest tile" aligned with what the user
    // is actually looking at after panning.
    const probe = paramsRef.current.mode === 'orbit' ? orbitRef.current.target : camera.position;
    const camDir = frameToDirection(
      probe as unknown as LocalPoint,
      win.frame,
      paramsRef.current.curvature,
    );
    let best: TileRecord | null = null;
    let bestD = Infinity;
    for (const rec of index.values()) {
      const d = angleBetween(rec.dir, camDir);
      if (d < bestD) { bestD = d; best = rec; }
    }
    if (best) setFocusTile({ face: best.face, x: best.x, y: best.y });
    refocus();
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
            <h2>Fly the generated surface</h2>
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
                    Click the view to capture the mouse · <b>WASD</b> move · <b>Q/E</b> down/up ·
                    {' '}<b>Shift</b> boost · <b>Esc</b> release
                  </p>
                </>
              ) : (
                <>
                  <p className="hint">
                    Drag to orbit · wheel to zoom · right-drag or <b>Shift</b>-drag to pan ·
                    {' '}the HUD reports the point at the centre of the view
                  </p>
                  <label className="checkRow">
                    <input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} />
                    <span>Auto-rotate</span>
                  </label>
                </>
              )}
              <button className="panelBtn" onClick={recenter}
                title="Fit the orbit distance to the terrain visible around the view centre"><Crosshair /> Recenter view</button>
            </section>

            <section>
              <h3><Layers /> Shading</h3>
              <div className="seg">
                <button className={shade === 'material' ? 'on' : ''} onClick={() => setShade('material')}>Material</button>
                <button className={shade === 'elevation' ? 'on' : ''} onClick={() => setShade('elevation')}>Elevation</button>
                <button className={shade === 'slope' ? 'on' : ''} onClick={() => setShade('slope')}>Slope</button>
              </div>
              {shade === 'material' && (
                <ul className="legend">
                  {MATERIAL_LABELS.map((label, i) => (
                    <li key={label}><i style={{ background: materialHex(i) }} />{label}</li>
                  ))}
                </ul>
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
              <label className="checkRow">
                <input type="checkbox" checked={curvature} onChange={e => setCurvature(e.target.checked)} />
                <span>Planet curvature</span>
              </label>
            </section>

            <section>
              <h3><Grid3x3 /> Visible tiles</h3>
              <label className="sliderRow">
                <span>VIEW DISTANCE</span>
                <b>{autoView ? `auto · ~${effViewTiles}` : viewTiles} tile{(autoView ? effViewTiles : viewTiles) === 1 ? '' : 's'}</b>
                <input type="range" min={2} max={MAX_VIEW_TILES} step={1}
                  value={autoView ? Math.max(2, Math.min(MAX_VIEW_TILES, effViewTiles)) : viewTiles}
                  onChange={e => { setAutoView(false); setViewTiles(Number(e.target.value)); }} />
              </label>
              <label className="checkRow" title="The view distance follows the camera: zoom out to reveal more generated terrain, zoom in for local detail. Fog hides the edge of what's drawn.">
                <input type="checkbox" checked={autoView} onChange={e => {
                  if (!e.target.checked) setViewTiles(Math.max(2, Math.min(MAX_VIEW_TILES, effViewTiles)));
                  setAutoView(e.target.checked);
                }} />
                <span>Auto view distance</span>
              </label>
              <p className="hint">
                Every generated chunk inside the camera's view is drawn — pan or fly anywhere and
                the terrain streams in around you, bounded by the view distance{autoView ? '' : ' set above'}.
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
              <h3>No generated terrain yet</h3>
              <p>
                Run generation and tiles appear here as the worker finishes them — or open a single
                chunk with the eye button in the Complete tab.
              </p>
            </div>
          )}
          {voidView && !empty && (
            <div className="viewerVoid">
              <Info />
              <span>No generated chunks in this direction — zoom out to widen the view, or use “Center on nearest tile”.</span>
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
              <span>{mode === 'fly' ? 'AGL' : 'ALT'}</span>
              <b>{hud.elevation === null ? '—' : formatMeters(hud.agl)}</b>
            </div>
            <div className="hudRow">
              <span>TILE</span><b>{hud.tile ?? '—'}</b>
              {hud.material !== null &&
                <><span>MAT</span><b>{MATERIAL_LABELS[hud.material] ?? hud.material}</b></>}
            </div>
            <div className="hudRow dim">
              <span>FPS</span><b>{hud.fps}</b>
              <span>VIEW</span><b>{formatMeters(hud.span * 2)}</b>
            </div>
          </div>

          <div className="viewerHint">
            {mode === 'fly'
              ? (locked ? 'Mouse look active · WASD move · Esc to release' : 'Click to look around · WASD to move')
              : 'Drag to orbit · wheel to zoom · Shift-drag to pan'}
          </div>
        </div>
      </div>
    </div>
  );
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const scratchVec3 = new THREE.Vector3();
const scratchMat = new THREE.Matrix4();
const scratchFrustum = new THREE.Frustum();
const scratchSphere = new THREE.Sphere();

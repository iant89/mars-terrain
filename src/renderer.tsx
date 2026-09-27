// Interactive 3D terrain renderer.
//
// Draws the generated .mars tiles as a seamless mesh in a local tangent frame
// (see terrain.ts): pick a focus tile, choose how many tiles around it to show,
// and orbit or fly over the result while the rest of the planet keeps
// generating. Tiles stream into the scene as the worker completes them, so the
// view doubles as a live preview of a run.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  Mountain, X, Eye, EyeOff, Grid3x3, Sun, Move3d, Crosshair, Camera, Layers, Info,
} from 'lucide-react';
import { formatMeters, fmt } from './config';
import { Chunk } from './types';
import { faceDirVec } from './region';
import {
  Frame, LocalPoint, ShadeMode, TileIndex, TileRecord, TileRef,
  MATERIAL_LABELS, angleBetween, buildTileGeometry, frameToDirection, localFrame,
  materialHex, projectToFrame, sampleTerrain, tileAngleRad, tileCenterDir, tileKey,
} from './terrain';

// How many tiles a window may hold (a tile is ~2k triangles / ~50 KB of GPU
// buffers) and the largest window radius the UI offers, in tiles.
const MAX_TILES = 900;
const MAX_RADIUS = 12;
const SYNC_MS = 180;      // queue poll interval
const REBUILD_MS = 220;   // minimum delay between window rebuilds

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
  const [exaggeration, setExaggeration] = useState(2);
  const [radius, setRadius] = useState(4);
  const [curvature, setCurvature] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [follow, setFollow] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [mode, setMode] = useState<'orbit' | 'fly'>('orbit');
  const [sunAz, setSunAz] = useState(135);
  const [sunEl, setSunEl] = useState(32);
  const [flySpeedIdx, setFlySpeedIdx] = useState(26);
  const [uiHidden, setUiHidden] = useState(false);
  const [focusTile, setFocusTile] = useState<TileRef | null>(focus);
  const [hud, setHud] = useState<Hud>(EMPTY_HUD);
  const [empty, setEmpty] = useState(false);
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
  const windowRef = useRef<{
    center: TileRef;
    frame: Frame;
    windowAngle: number;
    tiles: TileRecord[];
    span: number;
    meanElevation: number;
  } | null>(null);
  const dirtyRef = useRef(false);
  const lastSyncRef = useRef(0);
  const lastRebuildRef = useRef(0);
  const framedKeyRef = useRef('');
  const framedOnceRef = useRef(false);
  const framedNRef = useRef(0);
  const fpsRef = useRef(0);
  // Cleared for good once the user drags, zooms or flies — until then the
  // camera keeps fitting itself to the growing/sliding window.
  const cameraTouchedRef = useRef(false);

  const orbitRef = useRef({ theta: 0.6, phi: 1.02, distance: 1000, target: new THREE.Vector3() });
  const flyRef = useRef({ pos: new THREE.Vector3(0, 5000, 2000), yaw: 0, pitch: -0.2 });
  const keysRef = useRef<Set<string>>(new Set());
  const draggingRef = useRef<{ button: number; x: number; y: number; pan: boolean } | null>(null);
  const lockedRef = useRef(false);

  const focusKey = focusTile ? tileKey(focusTile.face, focusTile.x, focusTile.y) : '';

  // Everything the render loop and the rebuild routine need, mirrored from
  // React state so the three.js effect can stay mounted for the whole session.
  const paramsRef = useRef({
    shade, exaggeration, curvature, radius, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile,
  });
  paramsRef.current = {
    shade, exaggeration, curvature, radius, sunAz, sunEl, wireframe, showGrid,
    autoRotate, follow, mode, flySpeedIdx, nPerFace, resolution, focusTile,
  };

  // --- window construction ---------------------------------------------------

  const disposeMesh = useCallback((mesh: THREE.Mesh) => {
    mesh.geometry.dispose();
    (mesh.parent ?? groupRef.current)?.remove(mesh);
  }, []);

  /**
   * Rebuild the visible window: select the tiles around the focus, refresh
   * their meshes (reusing buffers where possible), the tile grid overlay, the
   * fog/clipping ranges and — when asked — the camera framing.
   */
  const buildWindow = useCallback((frameCamera: boolean) => {
    const group = groupRef.current;
    const index = indexRef.current;
    if (!group) return;

    const p = paramsRef.current;
    const N = p.nPerFace;
    const res = p.resolution;

    const clearWindow = () => {
      for (const mesh of meshesRef.current.values()) disposeMesh(mesh);
      meshesRef.current.clear();
      windowRef.current = null;
      framedKeyRef.current = '';
      setEmpty(true);
      if (gridRef.current) {
        gridRef.current.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      }
    };

    // Focus: the requested tile, else the first tile that completed.
    let center = p.focusTile;
    if (!center) {
      const any = index.size ? (index.values().next().value as TileRecord) : undefined;
      center = any ? { face: any.face, x: any.x, y: any.y } : null;
    }
    if (!center) {
      clearWindow();
      return;
    }

    const centerDir = tileCenterDir(center.face, center.x, center.y, N);
    const frame = localFrame(centerDir);
    const tileAngle = tileAngleRad(center.face, center.x, center.y, N);
    const windowAngle = Math.min(Math.PI * 0.49, Math.max(tileAngle, p.radius * tileAngle));

    // Tiles inside the window, nearest first.
    const candidates: { rec: TileRecord; d: number }[] = [];
    for (const rec of index.values()) {
      const c = Math.max(-1, Math.min(1,
        rec.dir.x * centerDir.x + rec.dir.y * centerDir.y + rec.dir.z * centerDir.z));
      const d = Math.acos(c);
      if (d <= windowAngle) candidates.push({ rec, d });
    }
    candidates.sort((a, b) =>
      a.d - b.d || a.rec.face - b.rec.face || a.rec.y - b.rec.y || a.rec.x - b.rec.x);
    const chosen = candidates.slice(0, MAX_TILES);
    if (chosen.length === 0) {
      // Nothing generated inside the window yet — keep the empty state rather
      // than framing a camera around nothing.
      clearWindow();
      return;
    }
    setEmpty(false);

    const geoKey = `${N}|${res}|${p.exaggeration}|${p.curvature ? 1 : 0}|${p.shade}` +
      `|${center.face}-${center.x}-${center.y}`;
    const neighbor = (f: number, x: number, y: number): Float32Array | null =>
      index.get(tileKey(f, x, y))?.heights ?? null;

    // Drop meshes that left the window.
    const keep = new Set(chosen.map(c => tileKey(c.rec.face, c.rec.x, c.rec.y)));
    for (const [key, mesh] of [...meshesRef.current]) {
      if (!keep.has(key)) {
        disposeMesh(mesh);
        meshesRef.current.delete(key);
      }
    }

    let span = 0;
    let meanSum = 0;
    const gridPoints: number[] = [];
    const corners = [[0, 0], [res - 1, 0], [res - 1, res - 1], [0, res - 1]] as const;

    for (const { rec } of chosen) {
      const key = tileKey(rec.face, rec.x, rec.y);
      const g = buildTileGeometry({
        face: rec.face,
        x: rec.x,
        y: rec.y,
        nPerFace: N,
        res,
        heights: rec.heights,
        materials: rec.materials,
        frame,
        exaggeration: p.exaggeration,
        curvature: p.curvature,
        shade: p.shade,
        neighbor,
      });

      let mesh = meshesRef.current.get(key);
      const existing = mesh?.geometry;
      if (mesh && existing &&
        existing.getAttribute('position')?.count === res * res &&
        mesh.userData.geoKey === geoKey) {
        // Same window parameters -> refresh the buffers in place (no realloc).
        const pos = existing.getAttribute('position') as THREE.BufferAttribute;
        const nrm = existing.getAttribute('normal') as THREE.BufferAttribute;
        const col = existing.getAttribute('color') as THREE.BufferAttribute;
        (pos.array as Float32Array).set(g.positions);
        (nrm.array as Float32Array).set(g.normals);
        (col.array as Float32Array).set(g.colors);
        pos.needsUpdate = true;
        nrm.needsUpdate = true;
        col.needsUpdate = true;
        existing.computeBoundingSphere();
      } else {
        if (mesh) disposeMesh(mesh);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
        geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
        geo.computeBoundingSphere();
        mesh = new THREE.Mesh(geo, materialRef.current!);
        mesh.userData.geoKey = geoKey;
        group.add(mesh);
        meshesRef.current.set(key, mesh);
      }

      const reach = Math.hypot(g.center.x, g.center.z) + g.extent;
      if (reach > span) span = reach;
      meanSum += g.meanElevation;

      // Tile boundary outline, lifted slightly so it reads over the relief.
      const lift = Math.max(20, g.extent * 0.004);
      for (let ci = 0; ci < 4; ci++) {
        const [i0, j0] = corners[ci];
        const [i1, j1] = corners[(ci + 1) % 4];
        for (const [i, j] of [[i0, j0], [i1, j1]] as const) {
          const u = -1 + (2 * (rec.x + i / (res - 1))) / N;
          const v = -1 + (2 * (rec.y + j / (res - 1))) / N;
          const h = (rec.heights[j * res + i] ?? 0) + lift / Math.max(0.001, p.exaggeration);
          const pt = projectToFrame(faceDirVec(rec.face, u, v), h, frame, p.exaggeration, p.curvature);
          gridPoints.push(pt.x, pt.y, pt.z);
        }
      }
    }

    const mean = chosen.length ? meanSum / chosen.length : 0;
    windowRef.current = {
      center,
      frame,
      windowAngle,
      tiles: chosen.map(c => c.rec),
      span: Math.max(span, 1000),
      meanElevation: mean,
    };

    if (gridRef.current) {
      const geo = gridRef.current.geometry;
      geo.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
      geo.computeBoundingSphere();
      gridRef.current.visible = p.showGrid;
    }

    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const winSpan = windowRef.current.span;
    if (scene && fogRef.current && camera) {
      const far = Math.max(2e4, Math.min(4e7, winSpan * 12));
      fogRef.current.near = Math.max(far * 0.06, 200);
      fogRef.current.far = far;
      camera.near = Math.max(0.5, winSpan / 4000);
      camera.far = far * 1.5;
      camera.updateProjectionMatrix();
    }
    if (sunRef.current) sunRef.current.position.setLength(Math.max(1e4, winSpan * 4));

    // Camera framing: full framing on the first build, on Recenter, whenever
    // the tile grid changes size, and continuously while the user hasn't taken
    // manual control (the window grows and slides as chunks stream in, so an
    // untouched camera keeps the whole window in frame). Once they drag, zoom
    // or fly, moving the focus (follow mode) only slides the orbit target so
    // the user's zoom and angles survive.
    const centerKey = `${N}|${center.face}-${center.x}-${center.y}`;
    const moved = framedKeyRef.current !== centerKey;
    const autoFit = !cameraTouchedRef.current;
    if (frameCamera || moved || autoFit) {
      const full = frameCamera || autoFit || !framedOnceRef.current || framedNRef.current !== N;
      framedKeyRef.current = centerKey;
      framedOnceRef.current = true;
      framedNRef.current = N;
      const target = new THREE.Vector3(0, mean * p.exaggeration, 0);
      orbitRef.current.target.copy(target);
      if (full) {
        orbitRef.current.distance = winSpan * 1.9;
        flyRef.current.pos.set(winSpan * 0.9, mean * p.exaggeration + winSpan * 0.35, winSpan * 1.1);
        const d = target.clone().sub(flyRef.current.pos).normalize();
        flyRef.current.yaw = Math.atan2(d.x, -d.z);
        flyRef.current.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      }
    }
  }, [disposeMesh]);

  const buildWindowRef = useRef(buildWindow);
  buildWindowRef.current = buildWindow;

  // Rebuild on any change that alters geometry or the window contents.
  useEffect(() => {
    buildWindowRef.current(false);
  }, [focusKey, radius, exaggeration, curvature, shade, nPerFace, resolution]);

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
    // Without "Follow generation" the focus never moves on its own: the view
    // stays on the tile it opened on (or the one picked via "Center on nearest
    // tile"), and new chunks inside that window stream in as they complete.
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
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTouchedRef.current = true;
      const o = orbitRef.current;
      const max = Math.max(2e4, (windowRef.current?.span ?? 1e4) * 20);
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

      if (now - lastSyncRef.current > SYNC_MS) {
        lastSyncRef.current = now;
        if (syncTiles()) dirtyRef.current = true;
        if (!windowRef.current && indexRef.current.size > 0) dirtyRef.current = true;
      }
      if (dirtyRef.current && now - lastRebuildRef.current > REBUILD_MS) {
        dirtyRef.current = false;
        lastRebuildRef.current = now;
        buildWindowRef.current(false);
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
        sunRef.current.position.multiplyScalar(Math.max(1e4, windowRef.current?.span ?? 1e4) * 4);
        sunRef.current.intensity = 1.6 + 1.4 * Math.max(0, sEl);
      }
      if (hemiRef.current) hemiRef.current.intensity = 0.35 + 0.35 * Math.max(0.15, Math.sin(p.sunEl * DEG));

      if (p.mode === 'orbit') {
        const o = orbitRef.current;
        if (p.autoRotate) o.theta += dt * 0.08;
        const sinP = Math.sin(o.phi);
        camera.position.set(
          o.target.x + o.distance * sinP * Math.sin(o.theta),
          o.target.y + o.distance * Math.cos(o.phi),
          o.target.z + o.distance * sinP * Math.cos(o.theta),
        );
        camera.lookAt(o.target);
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
        camera.position.copy(f.pos);
        camera.lookAt(f.pos.x + fwd.x, f.pos.y + fwd.y, f.pos.z + fwd.z);
      }

      if (rendererRef.current && sceneRef.current) {
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
        const win = windowRef.current;
        let elevation: number | null = null;
        let material: number | null = null;
        let lat = 0, lon = 0, agl = 0, tile: string | null = null;
        if (win) {
          // Orbit: report the point being looked at (the camera can hover far
          // outside the generated window). Fly: the ground under the camera.
          const probe = p.mode === 'orbit' ? orbitRef.current.target : camera.position;
          const dir = frameToDirection(probe as unknown as LocalPoint, win.frame, p.curvature);
          const s = sampleTerrain(dir, indexRef.current, p.nPerFace, p.resolution);
          lat = s.lat;
          lon = s.lon;
          elevation = s.elevation;
          material = s.material;
          tile = s.tile ? `F${s.tile.face}-${s.tile.x}-${s.tile.y}` : null;
          if (elevation !== null) agl = camera.position.y - elevation * p.exaggeration;
        }
        setHud({
          fps: fpsRef.current,
          tiles: meshesRef.current.size,
          triangles: meshesRef.current.size * (p.resolution - 1) * (p.resolution - 1) * 2,
          span: win?.span ?? 0,
          lat, lon, elevation, agl, material, tile,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    buildWindowRef.current(true);

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

  const recenter = useCallback(() => {
    buildWindowRef.current(true);
  }, []);

  const focusOnNearest = useCallback(() => {
    const index = indexRef.current;
    if (index.size === 0) return;
    const win = windowRef.current;
    const camera = cameraRef.current;
    const refocus = () => window.setTimeout(() => buildWindowRef.current(true), 0);
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
          <span><b>{fmt(hud.tiles)}</b> tiles</span>
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
              <button className="panelBtn" onClick={recenter}><Crosshair /> Recenter view</button>
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
              <label className="sliderRow">
                <span>VERTICAL SCALE</span>
                <b>{exaggeration.toFixed(1)}×</b>
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
                <span>WINDOW RADIUS</span>
                <b>{radius} tile{radius === 1 ? '' : 's'}</b>
                <input type="range" min={1} max={MAX_RADIUS} step={1} value={radius}
                  onChange={e => setRadius(Number(e.target.value))} />
              </label>
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
              <span>SPAN</span><b>{formatMeters(hud.span * 2)}</b>
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

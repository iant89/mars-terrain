import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { fromArrayBuffer } from 'geotiff';
import {
  FileImage, Globe2, Pause, Play, Square, RefreshCw, Download,
  CheckCircle2, Clock3, AlertTriangle, X, Database, HardDrive, Layers3, Settings2, AlertOctagon,
} from 'lucide-react';
import * as THREE from 'three';
import { Chunk } from './types';
import {
  PRESETS, deriveConfig, formatBytes, formatMeters, fmt, Config, PRACTICAL_CHUNK_LIMIT,
} from './config';
import {
  ZipEntry, buildZipBlob, planZipParts, zipPartName, crc32OfBlob,
  ZIP_PART_MAX_FILES, ZIP_PART_MAX_BYTES,
} from './zip';
import './style.css';

const faces = ['+X', '−X', '+Y', '−Y', '+Z', '−Z'];

function makeInitialChunks(N: number): Chunk[] {
  const out: Chunk[] = [];
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        out.push({
          id: `F${face}-${x}-${y}`,
          face, x, y,
          status: 'pending',
          size: 0,
          progress: 0,
        });
      }
    }
  }
  return out;
}

// --- shared math for cube-sphere mapping (same as worker) ---
type Vec3 = { x: number; y: number; z: number };
function normVec(p: Vec3): Vec3 {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}
function faceDirVec(face: number, u: number, v: number): Vec3 {
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

function Globe({ chunks, onClose }: { chunks: Chunk[]; onClose: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const globeMeshRef = useRef<THREE.Mesh | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const geoRef = useRef<THREE.BufferGeometry | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const texRef = useRef<THREE.CanvasTexture | null>(null);
  const animRef = useRef<number>(0);
  const chunksRef = useRef<Chunk[]>(chunks);
  chunksRef.current = chunks;

  // init three.js once
  useEffect(() => {
    if (!mount.current) return;
    const mountEl = mount.current;
    const w = mountEl.clientWidth;
    const h = mountEl.clientHeight;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 10);
    camera.position.z = 3.15;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    rendererRef.current = renderer;
    mountEl.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    // canvas texture for emissive overlay
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx2d = canvas.getContext('2d')!;
    ctx2d.fillStyle = '#000000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    canvasRef.current = canvas;

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    texRef.current = tex;

    const globeMat = new THREE.MeshStandardMaterial({
      color: 0xa44224,
      roughness: 0.82,
      metalness: 0.05,
      emissive: new THREE.Color(0xff6a3d),
      emissiveMap: tex,
      emissiveIntensity: 0.0,
    });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), globeMat);
    globeMeshRef.current = globe;
    group.add(globe);

    group.add(
      new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.006, 24, 16)),
        new THREE.LineBasicMaterial({ color: 0xeaa27a, transparent: true, opacity: 0.12 }),
      ),
    );

    // chunk markers as Points
    const geo = new THREE.BufferGeometry();
    geoRef.current = geo;
    const mat = new THREE.PointsMaterial({
      size: 0.035,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    pointsRef.current = points;
    group.add(points);

    scene.add(new THREE.HemisphereLight(0xffd1ad, 0x180c13, 2.5));
    const dl = new THREE.DirectionalLight(0xffab78, 3);
    dl.position.set(3, 2, 4);
    scene.add(dl);

    let drag = false, lx = 0, ly = 0;
    let autoRot = true;
    renderer.domElement.onpointerdown = e => {
      drag = true; autoRot = false;
      lx = e.clientX; ly = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    renderer.domElement.onpointermove = e => {
      if (drag && groupRef.current) {
        groupRef.current.rotation.y += (e.clientX - lx) * 0.008;
        groupRef.current.rotation.x += (e.clientY - ly) * 0.008;
        groupRef.current.rotation.x = Math.max(-1.2, Math.min(1.2, groupRef.current.rotation.x));
        lx = e.clientX; ly = e.clientY;
      }
    };
    const stopDrag = () => { drag = false; setTimeout(() => { autoRot = true; }, 1200); };
    renderer.domElement.onpointerup = stopDrag;
    renderer.domElement.onpointerleave = stopDrag;

    const onResize = () => {
      if (!mountEl || !cameraRef.current || !rendererRef.current) return;
      const nw = mountEl.clientWidth;
      const nh = mountEl.clientHeight;
      cameraRef.current.aspect = nw / nh;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(nw, nh);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mountEl);

    function loop() {
      animRef.current = requestAnimationFrame(loop);
      if (groupRef.current && autoRot && !drag) {
        groupRef.current.rotation.y += 0.0015;
      }
      // pulsate generating chunks
      if (geoRef.current && chunksRef.current.length) {
        const colors = geoRef.current.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (colors) {
          const t = Date.now() * 0.004;
          const pulse = 0.65 + 0.35 * Math.sin(t * 1.7);
          let needsUpdate = false;
          for (let i = 0; i < chunksRef.current.length; i++) {
            const c = chunksRef.current[i];
            if (c.status === 'generating') {
              colors.setXYZ(i, 1.0 * pulse, 0.75 * pulse, 0.45 * pulse);
              needsUpdate = true;
            }
          }
          if (needsUpdate) colors.needsUpdate = true;
        }
      }
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    }
    loop();

    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
      renderer.dispose();
      geo.dispose();
      mat.dispose();
      globeMat.dispose();
      tex.dispose();
      if (renderer.domElement.parentElement === mountEl) {
        mountEl.removeChild(renderer.domElement);
      }
    };
  }, []);

  // react to chunks changes
  useEffect(() => {
    if (!geoRef.current || !pointsRef.current || !canvasRef.current || !texRef.current || !globeMeshRef.current) return;
    const count = chunks.length;
    if (count === 0) return;
    const N = Math.round(Math.sqrt(count / 6));
    if (!Number.isFinite(N) || N <= 0) return;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const MARS_R = 3_389_500;
    const exaggeration = 14;

    for (let i = 0; i < count; i++) {
      const c = chunks[i];
      const u = -1 + (2 * (c.x + 0.5)) / N;
      const v = -1 + (2 * (c.y + 0.5)) / N;
      const dir = faceDirVec(c.face, u, v);

      let r = 1.012;
      if (c.status === 'complete' && c.heights && c.heights.length > 0) {
        let sum = 0;
        const h = c.heights;
        const step = h.length > 200 ? 8 : 1;
        let sampled = 0;
        for (let k = 0; k < h.length; k += step) {
          sum += h[k];
          sampled++;
        }
        const avg = sampled ? sum / sampled : 0;
        r = 1.008 + (avg / MARS_R) * exaggeration + 0.018;
        if (r < 1.004) r = 1.004;
        if (r > 1.18) r = 1.18;
      } else if (c.status === 'pending') {
        r = 1.008;
      } else if (c.status === 'error') {
        r = 1.01;
      } else if (c.status === 'generating') {
        r = 1.016;
      }

      positions[i * 3] = dir.x * r;
      positions[i * 3 + 1] = dir.y * r;
      positions[i * 3 + 2] = dir.z * r;

      let cr, cg, cb;
      if (c.status === 'complete') {
        const hasH = c.heights ? 1 : 0;
        cr = 0.96;
        cg = hasH ? 0.56 : 0.42;
        cb = hasH ? 0.28 : 0.22;
      } else if (c.status === 'generating') {
        cr = 1.0; cg = 0.78; cb = 0.38;
      } else if (c.status === 'error') {
        cr = 0.95; cg = 0.18; cb = 0.18;
      } else {
        cr = 0.18; cg = 0.16; cb = 0.15;
      }
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }

    const geo = geoRef.current;
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();

    const mat = pointsRef.current.material as THREE.PointsMaterial;
    if (N <= 16) mat.size = 0.045;
    else if (N <= 32) mat.size = 0.032;
    else if (N <= 64) mat.size = 0.02;
    else if (N <= 128) mat.size = 0.012;
    else mat.size = 0.008;

    // update emissive canvas texture
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const completeCount = chunks.filter(c => c.status === 'complete').length;
    const generatingCount = chunks.filter(c => c.status === 'generating').length;

    const globeMat = globeMeshRef.current.material as THREE.MeshStandardMaterial;
    if (completeCount > 0 || generatingCount > 0) {
      globeMat.emissiveIntensity = Math.min(1.2, 0.15 + (completeCount / count) * 0.9 + (generatingCount / count) * 0.6);
    } else {
      globeMat.emissiveIntensity = 0;
    }

    const drawPending = count <= 20000;
    const dotSize = N <= 32 ? 4 : N <= 64 ? 3 : 2;

    for (let i = 0; i < count; i++) {
      const c = chunks[i];
      if (!drawPending && c.status === 'pending') continue;
      const u = -1 + (2 * (c.x + 0.5)) / N;
      const v = -1 + (2 * (c.y + 0.5)) / N;
      const dir = faceDirVec(c.face, u, v);
      const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      const lon = Math.atan2(dir.z, dir.x);
      const x = ((lon + Math.PI) / (2 * Math.PI)) * canvas.width;
      const y = ((Math.PI / 2 - lat) / Math.PI) * canvas.height;

      if (c.status === 'complete') {
        let brightness = 1;
        if (c.heights) {
          const h = c.heights;
          let s = 0;
          for (let k = 0; k < h.length; k += 16) s += h[k];
          const avg = s / (h.length / 16);
          brightness = 0.7 + Math.max(0, Math.min(1, (avg + 2000) / 10000)) * 0.8;
        }
        const r = Math.floor(255 * brightness);
        const g = Math.floor(140 * brightness);
        const b = Math.floor(70 * brightness);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      } else if (c.status === 'generating') {
        ctx.fillStyle = '#ffeb8a';
        ctx.fillRect(x - dotSize, y - dotSize, dotSize * 2, dotSize * 2);
      } else if (c.status === 'error') {
        ctx.fillStyle = '#ff3a3a';
        ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      } else if (drawPending) {
        ctx.fillStyle = 'rgba(40,30,28,0.9)';
        ctx.fillRect(x, y, 1, 1);
      }
    }

    texRef.current.needsUpdate = true;
  }, [chunks]);

  const complete = chunks.filter(c => c.status === 'complete').length;
  const generating = chunks.filter(c => c.status === 'generating').length;
  const errors = chunks.filter(c => c.status === 'error').length;

  return (
    <div className="modal">
      <div className="globeHead">
        <div><span>PLANETARY OVERVIEW</span><h2>Mars generation map</h2></div>
        <button onClick={onClose}><X /></button>
      </div>
      <div ref={mount} className="globeCanvas" />
      <div className="globeLegend">
        <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{complete}</b> / {chunks.length} sectors generated
          {generating > 0 && <span style={{ color: '#ffcf7a' }}>● {generating} generating</span>}
          {errors > 0 && <span style={{ color: '#ff6b6b' }}>● {errors} error</span>}
          <span style={{ opacity: 0.7 }}>Drag to explore • points = chunk centers • glow = completed terrain</span>
        </span>
      </div>
    </div>
  );
}

function App() {
  const [presetId, setPresetId] = useState<string>('n32');
  const cfg: Config = useMemo(
    () => deriveConfig(PRESETS.find(p => p.id === presetId) ?? PRESETS[1]),
    [presetId],
  );
  const N = cfg.nPerFace;

  // Build the chunk list only for practical presets. Unpractical presets produce
  // so many chunks (millions to billions) that keeping them in React state
  // would hang the browser; we still expose their derived numbers.
  const [chunks, setChunks] = useState<Chunk[]>(() => makeInitialChunks(32));
  const prevNRef = useRef(32);

  // Current chunk list, kept in sync by updateChunks so the worker message
  // handlers and the generation pump always see up-to-date sector states
  // without re-rendering.
  const chunksRef = useRef<Chunk[]>(chunks);
  const updateChunks = useCallback((fn: (cs: Chunk[]) => Chunk[]) => {
    const next = fn(chunksRef.current);
    chunksRef.current = next;
    setChunks(next);
  }, []);

  useEffect(() => {
    if (cfg.practical) {
      sessionRef.current = false;
      setPack({ status: 'idle', message: '' });
      updateChunks(() => makeInitialChunks(N));
      prevNRef.current = N;
    }
  }, [N, cfg.practical, updateChunks]);

  const [tab, setTab] = useState<'pending' | 'complete' | 'error'>('pending');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [globe, setGlobe] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [dem, setDem] = useState<string>('');
  const [pack, setPack] = useState<{ status: 'idle' | 'packing' | 'done'; message: string }>({ status: 'idle', message: '' });
  const demInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const packingRef = useRef(false);
  const sessionRef = useRef(false); // true while a generation run should auto-package on finish
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const runningRef = useRef(running);
  runningRef.current = running;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const done = chunks.filter(c => c.status === 'complete').length;
  const total = chunks.reduce((a, c) => a + c.size, 0);
  const pct = chunks.length ? Math.round(done / chunks.length * 100) : 0;

  const reset = useCallback(() => {
    setRunning(false);
    setPaused(false);
    sessionRef.current = false;
    setPack({ status: 'idle', message: '' });
    updateChunks(() => makeInitialChunks(cfgRef.current.nPerFace));
  }, [updateChunks]);

  async function chooseDem(file: File) {
    try {
      const tiff = await fromArrayBuffer(await file.arrayBuffer());
      const image = await tiff.getImage();
      setDem(`${file.name} · ${image.getWidth()} × ${image.getHeight()}`);
    } catch {
      setDem(`${file.name} · unable to read GeoTIFF`);
    }
  }

  useEffect(() => {
    fetch('./Mars_MGS_MOLA_DEM_mosaic_global_463m.tif')
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(b => chooseDem(new File([b], 'Mars_MGS_MOLA_DEM_mosaic_global_463m.tif')))
      .catch(() => {});
  }, []);

  const pumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    worker.current = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
    worker.current.onmessage = e => {
      const d = e.data;
      if (d.type === 'progress') {
        updateChunks(cs => cs.map(c => c.id === d.id ? { ...c, progress: d.progress } : c));
      }
      if (d.type === 'done') {
        const blob: Blob = d.blob;
        updateChunks(cs => cs.map(c => c.id === d.id
          ? { ...c, status: 'complete', progress: 1, size: blob.size, blob, crc: d.crc, heights: d.heights }
          : c));
        busy.current = false;
        pumpRef.current(); // continue the queue from the message handler, not an effect
      }
    };
    return () => worker.current?.terminate();
  }, [updateChunks]);

  function stop() {
    setRunning(false);
    setPaused(false);
    worker.current?.postMessage({ type: 'stop' });
    busy.current = false;
    updateChunks(cs => cs.map(c => c.status === 'generating'
      ? { ...c, status: 'error', progress: 0, error: 'Generation interrupted — no partial file saved' }
      : c));
  }

  function retry(id: string) {
    sessionRef.current = true;
    updateChunks(cs => cs.map(c => c.id === id ? { ...c, status: 'pending', progress: 0, error: undefined } : c));
    setRunning(true);
  }

  function dl(c: Chunk) {
    if (!c.blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(c.blob);
    a.download = `${c.id}.mars`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function triggerDownload(blob: Blob, name: string) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Package every completed tile into one or more zip archives and hand them
  // to the browser as downloads. Splits when the file count or overall size
  // exceeds the per-archive caps (see zip.ts); split parts are named
  // `<base>_PART-#.zip`. Large archives are composed from the existing tile
  // blobs without copying their payloads.
  const exportZip = useCallback(async () => {
    if (packingRef.current) return;
    const ready = chunksRef.current.filter(c => c.status === 'complete' && c.blob);
    if (ready.length === 0) return;
    packingRef.current = true;
    try {
      setPack({ status: 'packing', message: `Packaging ${fmt(ready.length)} sectors…` });
      await new Promise(r => setTimeout(r, 0));
      const entries: ZipEntry[] = [];
      for (const c of ready) {
        const blob = c.blob!;
        entries.push({ name: `${c.id}.mars`, blob, crc32: typeof c.crc === 'number' ? c.crc : await crc32OfBlob(blob) });
      }
      const parts = planZipParts(entries);
      const base = `mars-terrain-${cfgRef.current.nPerFace}x${cfgRef.current.nPerFace}`;
      const built: { blob: Blob; name: string }[] = [];
      for (let i = 0; i < parts.length; i++) {
        setPack({ status: 'packing', message: `Building ${parts.length > 1 ? `part ${i + 1} of ${parts.length}` : 'archive'}…` });
        await new Promise(r => setTimeout(r, 0));
        built.push({ blob: buildZipBlob(parts[i]), name: zipPartName(base, i + 1, parts.length) });
      }
      const totalBytes = built.reduce((a, b) => a + b.blob.size, 0);
      setPack({
        status: 'done',
        message: built.length > 1
          ? `Packaged ${fmt(entries.length)} sectors into ${built.length} parts (${formatBytes(totalBytes)}) · ${built.map(b => b.name).join(' · ')} · downloading…`
          : `Packaged ${fmt(entries.length)} sectors (${formatBytes(totalBytes)}) · downloading ${built[0].name}…`,
      });
      for (const b of built) {
        triggerDownload(b.blob, b.name);
        await new Promise(r => setTimeout(r, 750));
      }
    } catch (err) {
      console.error('zip export failed', err);
      setPack({ status: 'done', message: 'Packaging failed — see console. Completed sectors can still be downloaded individually.' });
    } finally {
      packingRef.current = false;
    }
  }, []);

  // Generation pump: picks the next sector and hands it to the worker. Called
  // from the worker's done handler and from the [running, paused] effect below
  // (start/pause transitions only) — never chained through chunk state, so it
  // cannot nest updates.
  const pump = useCallback(() => {
    const cs = chunksRef.current;
    if (!runningRef.current || pausedRef.current || busy.current) return;
    const next = cs.find(c => c.status === 'pending' || c.status === 'error');
    if (!next) {
      if (runningRef.current) setRunning(false);
      // A generation run finished cleanly — package and download automatically.
      if (sessionRef.current && cs.length > 0 && cs.every(c => c.status === 'complete')) {
        sessionRef.current = false;
        void exportZip();
      }
      return;
    }
    busy.current = true;
    updateChunks(list => list.map(c => c.id === next.id ? { ...c, status: 'generating', error: undefined } : c));
    worker.current?.postMessage({
      type: 'generate',
      id: next.id,
      face: next.face,
      cx: next.x,
      cy: next.y,
      res: cfgRef.current.resolution,
      chunks: cfgRef.current.nPerFace,
    });
  }, [updateChunks, exportZip]);
  pumpRef.current = pump;

  // Wake the pump on start/pause/stop/resume transitions only.
  useEffect(() => {
    pumpRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, paused]);

  const visible = chunks.filter(c =>
    tab === 'pending' ? ['pending', 'generating'].includes(c.status) : c.status === tab);

  return (
    <main>
      <input ref={demInput} type="file" hidden accept=".tif,.tiff,image/tiff"
        onChange={e => e.target.files?.[0] && chooseDem(e.target.files[0])} />

      <header>
        <div className="brand">
          <div className="logo"><Layers3 /></div>
          <div>
            <span>MARS TERRAIN SYSTEM</span>
            <h1>Ares Foundry</h1>
          </div>
        </div>
        <div className="headActions">
          <button className="folder" onClick={() => demInput.current?.click()} title="Load MOLA GeoTIFF">
            <FileImage /><span>{dem ? 'MOLA DEM loaded' : 'Load MOLA DEM'}</span>
          </button>
          <button className="folder" onClick={() => setConfigOpen(o => !o)} title="Generation settings">
            <Settings2 /><span>Settings</span>
          </button>
          <button className="globe" onClick={() => setGlobe(true)} aria-label="Open globe"><Globe2 /></button>
        </div>
      </header>

      {configOpen && (
        <section className="configPanel">
          <div className="configHead">
            <div>
              <span className="eyebrow"><i /> GENERATION PRESET</span>
              <h2>Chunk density</h2>
              <p>Choose how many cube-face tiles partition the planet. All downstream constants (vertex spacing, output size, etc.) are derived automatically.</p>
            </div>
            {!cfg.practical && (
              <div className="configWarn">
                <AlertOctagon />
                <span>This preset is not runnable in-browser — totals exceed {formatBytes(PRACTICAL_CHUNK_LIMIT * cfg.bytesPerChunk)}. Values are shown for planning.</span>
              </div>
            )}
          </div>
          <div className="presetGrid">
            {PRESETS.map(p => {
              const c = deriveConfig(p);
              const active = p.id === presetId;
              return (
                <button
                  key={p.id}
                  className={`preset ${active ? 'active' : ''} ${c.practical ? '' : 'theoretical'}`}
                  onClick={() => { setPresetId(p.id); if (c.practical) reset(); }}
                >
                  <h3>{p.label}</h3>
                  <small>{c.practical ? '' : 'THEORETICAL'}</small>
                  <p>{p.description}</p>
                  <dl>
                    <div><dt>Total sectors</dt><dd>{fmt(c.totalChunks)}</dd></div>
                    <div><dt>Vertex spacing</dt><dd>{formatMeters(c.sourceSpacingM)}</dd></div>
                    <div><dt>Est. output</dt><dd>{formatBytes(c.estimatedTotalBytes)}</dd></div>
                  </dl>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="hero">
        <div>
          <span className="eyebrow"><i /> LOCAL GENERATION PIPELINE</span>
          <h2>Forge the red planet,<br /><em>one sector at a time.</em></h2>
          <p>Deterministic cube-sphere terrain informed by NASA MOLA elevation characteristics. Generated entirely on your device.</p>
        </div>
        <div className="orbit">
          <Globe2 />
          <span>{fmt(cfg.totalChunks)}</span>
          <small>SECTORS</small>
        </div>
      </section>

      <section className="status">
        <div className="metric"><CheckCircle2 /><div><b>{done}</b><span>COMPLETE</span></div></div>
        <div className="metric"><Clock3 /><div><b>{Math.max(0, chunks.length - done)}</b><span>REMAINING</span></div></div>
        <div className="metric"><HardDrive /><div><b>{formatBytes(total)}</b><span>GENERATED</span></div></div>
        <div className="progress">
          <div><span>TOTAL PROGRESS</span><b>{pct}%</b></div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      </section>

      <section className="controls">
        <div>
          <button
            className="primary"
            onClick={() => { sessionRef.current = true; setRunning(true); setPaused(false); }}
            disabled={(running && !paused) || !cfg.practical}
            title={!cfg.practical ? 'This preset is too large to run in-browser' : ''}
          >
            <Play /> {done ? 'Resume generation' : 'Begin generation'}
          </button>
          <button onClick={() => setPaused(!paused)} disabled={!running}><Pause /> {paused ? 'Paused' : 'Pause'}</button>
          <button onClick={stop} disabled={!running}><Square /> Stop</button>
          {cfg.practical && (
            <button onClick={reset} title="Reset queue"><RefreshCw /> Reset</button>
          )}
          <button
            onClick={() => void exportZip()}
            disabled={done === 0 || pack.status === 'packing'}
            title={done === 0 ? 'Generate sectors first' : 'Package completed sectors into zip file(s) and download them'}
          >
            <Download /> {pack.status === 'packing' ? 'Packaging…' : 'Download ZIP'}
          </button>
        </div>
        <span>
          {cfg.resolution} × {cfg.resolution} vertices per chunk ·
          {' '}{formatMeters(cfg.sourceSpacingM)} source spacing ·
          {' '}{formatMeters(cfg.sourceDepthM)} vertical step ·
          {' '}MARS binary · preset <b>{cfg.preset.label}</b>
        </span>
      </section>

      {pack.status !== 'idle' && (
        <div className="packBar">
          {pack.status === 'packing' ? <RefreshCw className="spin" /> : <CheckCircle2 />}
          <span>{pack.message}</span>
        </div>
      )}

      <section className="queue">
        <div className="tabs">
          {(['pending', 'complete', 'error'] as const).map(t => (
            <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
              {t === 'pending' ? 'Queue' : t[0].toUpperCase() + t.slice(1)}
              {' '}<b>{chunks.filter(c => t === 'pending' ? ['pending', 'generating'].includes(c.status) : c.status === t).length}</b>
            </button>
          ))}
        </div>
        <div className="list">
          {!cfg.practical ? (
            <div className="empty">
              <AlertOctagon style={{ width: 32, height: 32, color: '#c95c4b', marginBottom: 12 }} />
              <p>This preset ({cfg.preset.label}) is too large to manage in a browser tab — {fmt(cfg.totalChunks)} sectors would require {formatBytes(cfg.estimatedTotalBytes)} of output.</p>
              <p>Select a smaller preset or the headless/streaming generator to proceed.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">No sectors in this view.</div>
          ) : visible.map(c => (
            <article key={c.id}>
              <div className={`chunkIcon ${c.status}`}>
                {c.status === 'complete' ? <CheckCircle2 /> :
                  c.status === 'error' ? <AlertTriangle /> :
                  <span>{String(c.face + 1).padStart(2, '0')}</span>}
              </div>
              <div className="chunkInfo">
                <h3>Sector {c.id}</h3>
                <p>Cube face {faces[c.face]} · Tile {c.x + 1},{c.y + 1} · {fmt(cfg.verticesPerChunk)} vertices</p>
                {c.status === 'generating' && <div className="mini"><i style={{ width: `${c.progress * 100}%` }} /></div>}
                {c.error && <small>{c.error}</small>}
              </div>
              <div className="chunkEnd">
                <b>{c.status === 'complete' ? formatBytes(c.size) : c.status === 'generating' ? `${Math.round(c.progress * 100)}%` : '—'}</b>
                <span>{c.status}</span>
              </div>
              {c.status === 'complete' && c.blob && (
                <button className="iconBtn" onClick={() => dl(c)}><Download /></button>
              )}
              {c.status === 'error' && (
                <button className="iconBtn" onClick={() => retry(c.id)}><RefreshCw /></button>
              )}
            </article>
          ))}
        </div>
      </section>

      <footer>
        <Database /> NASA MOLA-inspired planetary model <span>•</span> All processing stays local
      </footer>

      {globe && <Globe chunks={chunks} onClose={() => setGlobe(false)} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

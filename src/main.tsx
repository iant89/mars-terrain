import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { fromArrayBuffer } from 'geotiff';
import {
  FileImage, Globe2, Pause, Play, Square, RefreshCw, FolderOpen, Download,
  CheckCircle2, Clock3, AlertTriangle, X, Database, HardDrive, Layers3, Settings2, AlertOctagon,
} from 'lucide-react';
import * as THREE from 'three';
import { Chunk } from './types';
import {
  PRESETS, deriveConfig, formatBytes, formatMeters, fmt, Config, PRACTICAL_CHUNK_LIMIT,
} from './config';
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

function Globe({ chunks, onClose }: { chunks: Chunk[]; onClose: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mount.current) return;
    const w = mount.current.clientWidth;
    const h = mount.current.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 10);
    camera.position.z = 3.15;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    mount.current.appendChild(renderer.domElement);
    const group = new THREE.Group();
    scene.add(group);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.MeshStandardMaterial({ color: 0xa44224, roughness: 0.82, metalness: 0.05, wireframe: false }),
    );
    group.add(globe);
    group.add(new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1.006, 24, 16)),
      new THREE.LineBasicMaterial({ color: 0xeaa27a, transparent: true, opacity: 0.12 }),
    ));
    scene.add(new THREE.HemisphereLight(0xffd1ad, 0x180c13, 2.5));
    const dl = new THREE.DirectionalLight(0xffab78, 3);
    dl.position.set(3, 2, 4);
    scene.add(dl);
    let drag = false, lx = 0, ly = 0;
    renderer.domElement.onpointerdown = e => {
      drag = true; lx = e.clientX; ly = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    renderer.domElement.onpointermove = e => {
      if (drag) {
        group.rotation.y += (e.clientX - lx) * 0.008;
        group.rotation.x += (e.clientY - ly) * 0.008;
        lx = e.clientX; ly = e.clientY;
      }
    };
    renderer.domElement.onpointerup = () => { drag = false; };
    let id = 0;
    function loop() {
      id = requestAnimationFrame(loop);
      if (!drag) group.rotation.y += 0.0015;
      renderer.render(scene, camera);
    }
    loop();
    return () => {
      cancelAnimationFrame(id);
      renderer.dispose();
      mount.current?.removeChild(renderer.domElement);
    };
  }, []);
  return (
    <div className="modal">
      <div className="globeHead">
        <div><span>PLANETARY OVERVIEW</span><h2>Mars generation map</h2></div>
        <button onClick={onClose}><X /></button>
      </div>
      <div ref={mount} className="globeCanvas" />
      <div className="globeLegend">
        <b>{chunks.filter(c => c.status === 'complete').length}</b> / {chunks.length} surface sectors generated
        <span>Drag to explore</span>
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
  useEffect(() => {
    if (cfg.practical) {
      setChunks(makeInitialChunks(N));
      prevNRef.current = N;
    }
  }, [N, cfg.practical]);

  const [tab, setTab] = useState<'pending' | 'complete' | 'error'>('pending');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [globe, setGlobe] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [dem, setDem] = useState<string>('');
  const demInput = useRef<HTMLInputElement>(null);
  const outputInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const done = chunks.filter(c => c.status === 'complete').length;
  const total = chunks.reduce((a, c) => a + c.size, 0);
  const pct = chunks.length ? Math.round(done / chunks.length * 100) : 0;

  const reset = useCallback(() => {
    setRunning(false);
    setPaused(false);
    setChunks(makeInitialChunks(cfgRef.current.nPerFace));
  }, []);

  async function chooseDir() {
    if (!('showDirectoryPicker' in window)) { outputInput.current?.click(); return; }
    const d = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    setDir(d);
    const names = new Set<string>();
    for await (const [name] of (d as any).entries()) names.add(name);
    setChunks(cs => cs.map(c => names.has(`${c.id}.mars`) ? { ...c, status: 'complete', size: 0, progress: 1 } : c));
  }

  async function chooseDem(file: File) {
    try {
      const tiff = await fromArrayBuffer(await file.arrayBuffer());
      const image = await tiff.getImage();
      setDem(`${file.name} · ${image.getWidth()} × ${image.getHeight()}`);
    } catch {
      setDem(`${file.name} · unable to read GeoTIFF`);
    }
  }

  function chooseOutputFiles(files: FileList | null) {
    if (!files) return;
    const names = new Set(Array.from(files).map(f => f.name));
    const mola = Array.from(files).find(f => f.name === 'Mars_MGS_MOLA_DEM_mosaic_global_463m.tif')?.name;
    if (mola) setDem(mola);
    setChunks(cs => cs.map(c => names.has(`${c.id}.mars`) ? { ...c, status: 'complete', size: 0, progress: 1 } : c));
  }

  useEffect(() => {
    fetch('./Mars_MGS_MOLA_DEM_mosaic_global_463m.tif')
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(b => chooseDem(new File([b], 'Mars_MGS_MOLA_DEM_mosaic_global_463m.tif')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    worker.current = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
    worker.current.onmessage = async e => {
      const d = e.data;
      if (d.type === 'progress') {
        setChunks(cs => cs.map(c => c.id === d.id ? { ...c, progress: d.progress } : c));
      }
      if (d.type === 'done') {
        const blob: Blob = d.blob;
        if (dir) {
          try {
            const f = await dir.getFileHandle(`${d.id}.mars`, { create: true });
            const w = await f.createWritable();
            await w.write(blob);
            await w.close();
          } catch {}
        }
        setChunks(cs => cs.map(c => c.id === d.id
          ? { ...c, status: 'complete', progress: 1, size: blob.size, blob, heights: d.heights }
          : c));
        busy.current = false;
      }
    };
    return () => worker.current?.terminate();
  }, [dir]);

  useEffect(() => {
    if (!running || paused || busy.current) return;
    const next = chunks.find(c => c.status === 'pending' || c.status === 'error');
    if (!next) { setRunning(false); return; }
    busy.current = true;
    setChunks(cs => cs.map(c => c.id === next.id ? { ...c, status: 'generating', error: undefined } : c));
    worker.current?.postMessage({
      type: 'generate',
      id: next.id,
      face: next.face,
      cx: next.x,
      cy: next.y,
      res: cfg.resolution,
      chunks: N,
    });
  }, [running, paused, chunks, cfg.resolution, N]);

  function stop() {
    setRunning(false);
    setPaused(false);
    worker.current?.postMessage({ type: 'stop' });
    busy.current = false;
    setChunks(cs => cs.map(c => c.status === 'generating'
      ? { ...c, status: 'error', progress: 0, error: 'Generation interrupted — no partial file saved' }
      : c));
  }

  function retry(id: string) {
    setChunks(cs => cs.map(c => c.id === id ? { ...c, status: 'pending', progress: 0, error: undefined } : c));
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

  const visible = chunks.filter(c =>
    tab === 'pending' ? ['pending', 'generating'].includes(c.status) : c.status === tab);

  return (
    <main>
      <input ref={outputInput} type="file" hidden multiple
        {...({ webkitdirectory: true } as any)}
        onChange={e => chooseOutputFiles(e.target.files)} />
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
          <button className="folder" onClick={chooseDir}>
            <FolderOpen /><span>{dir ? 'Directory linked' : 'Select output'}</span>
          </button>
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
            onClick={() => { setRunning(true); setPaused(false); }}
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
        </div>
        <span>
          {cfg.resolution} × {cfg.resolution} vertices per chunk ·
          {' '}{formatMeters(cfg.sourceSpacingM)} source spacing ·
          {' '}{formatMeters(cfg.sourceDepthM)} vertical step ·
          {' '}MARS binary · preset <b>{cfg.preset.label}</b>
        </span>
      </section>

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

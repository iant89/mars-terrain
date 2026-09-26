// Terrain generation configuration model.
// Selecting a preset controls N (chunks per face edge) and derives all related constants.
//
// Mars physical constants ----------------------------------------------------
export const MARS_RADIUS_M = 3_389_500;           // mean radius (meters)
export const CHUNK_RESOLUTION = 33;              // vertices per chunk edge (33 -> 1089 verts/chunk, 32 cells)
export const VERTICAL_RANGE_M = 23_000;          // approximate vertical span of Martian topography (Olympus ~21 km)
// ---------------------------------------------------------------------------

export type ChunkPreset = {
  id: string;
  label: string;           // e.g. "16 × 16"
  description: string;     // short human-readable description
  nPerFace: number;        // chunks per face edge
  quality: 'Low' | 'Standard' | 'High';
};

export const PRESETS: ChunkPreset[] = [
  { id: 'n16',  label: '16 × 16',   nPerFace: 16,  quality: 'Low',      description: 'Low — 1,536 chunks, fast preview.' },
  { id: 'n32',  label: '32 × 32',   nPerFace: 32,  quality: 'Standard', description: 'Standard — 6,144 chunks, ~400 MB total output.' },
  { id: 'n256', label: '256 × 256', nPerFace: 256, quality: 'High',     description: 'High — 393,216 chunks, ~25 GB. Requires disk streaming.' },
];

// Approximate threshold (number of chunks) beyond which in-browser generation
// isn't practical (RAM/CPU) without special out-of-core streaming.
export const PRACTICAL_CHUNK_LIMIT = 500_000;

// Derived configuration for a given preset.
export type Config = {
  preset: ChunkPreset;
  nPerFace: number;                // chunks per cube-face edge
  totalChunks: number;             // 6 * N^2
  chunksPerFace: number;           // N^2
  resolution: number;              // vertices per chunk edge (fixed at CHUNK_RESOLUTION)
  verticesPerChunk: number;        // resolution^2
  cellsPerChunkEdge: number;       // resolution - 1
  // Approximate ground-sample distance at the chunk level.
  // On a cube-sphere face, the projected edge length at the face center is
  // roughly (2/√3) * R ≈ 1.1547 * R, while near corners it's ~R. We use the
  // face-center approximation for a single representative spacing value.
  sourceSpacingM: number;          // meters between adjacent vertices
  sourceDepthM: number;            // vertical quantization step (VERTICAL_RANGE / 2^16 ≈ 0.35 m)
  // Each .mars blob = 20 byte header + heights (Float32 * res^2) + materials (Uint8 * res^2)
  bytesPerChunk: number;
  estimatedTotalBytes: number;     // bytesPerChunk * totalChunks
  practical: boolean;              // true if this preset can reasonably run in a browser
};

export function deriveConfig(preset: ChunkPreset): Config {
  const n = preset.nPerFace;
  const totalChunks = 6 * n * n;
  const chunksPerFace = n * n;
  const resolution = CHUNK_RESOLUTION;
  const verticesPerChunk = resolution * resolution;
  const cellsPerChunkEdge = resolution - 1;
  // Vertices span the full face edge -> spacing ~ face_edge_length / (N*cellsPerChunkEdge)
  // Face edge on the cube face (tangent plane): s = (2/sqrt(3)) * R  (central spacing)
  const faceEdgeM = (2 / Math.sqrt(3)) * MARS_RADIUS_M;
  const sourceSpacingM = faceEdgeM / (n * cellsPerChunkEdge);
  const sourceDepthM = VERTICAL_RANGE_M / 65536;
  const bytesPerChunk = 20 + verticesPerChunk * 4 + verticesPerChunk * 1; // header + Float32 + Uint8
  const estimatedTotalBytes = bytesPerChunk * totalChunks;
  return {
    preset,
    nPerFace: n,
    totalChunks,
    chunksPerFace,
    resolution,
    verticesPerChunk,
    cellsPerChunkEdge,
    sourceSpacingM,
    sourceDepthM,
    bytesPerChunk,
    estimatedTotalBytes,
    practical: totalChunks <= PRACTICAL_CHUNK_LIMIT,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n < 1024 ** 5) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  return `${(n / 1024 ** 5).toFixed(2)} PB`;
}

export function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  if (m >= 0.01) return `${(m * 100).toFixed(2)} cm`;
  return `${(m * 1000).toFixed(2)} mm`;
}

// Number formatting with thousand separators.
export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

# FET — Forge Engine Terrain

**Version:** 1  
**Extension:** `.fet`  
**MIME type:** `application/vnd.forge-engine.terrain`  
**Endianness:** little-endian  
**Status:** current writer and reader format for [Ares Foundry](https://github.com/iant89/mars-terrain) and the intended bake-time tile format for Forge Engine.

A `.fet` file is one cube-sphere terrain tile: a 24-byte header, a dense elevation grid, and a material-class grid of the same resolution. Tiles are independently readable. A region or a whole planet is a set of files (usually a ZIP of STORE-compressed entries), not a container format of its own.

This document is the contract. If the writer and this page disagree, the writer is wrong.

---

## 1. Design goals

- One file per tile so a game engine can stream, cache, and evict by key.
- Trivial to parse: no compression inside the tile, no variable-length fields, no checksum in the payload (ZIP CRC-32 covers packaged sets).
- Shared-edge sampling: two neighbouring tiles that name the same cube-sphere `(u, v)` store the same elevation at that vertex.
- Stable identity: magic + version so a loader can reject `.mars` leftovers and future versions without guessing.

---

## 2. File layout

```
offset   size        type          field
0        4           uint32 LE     magic        = 0x31544546   // ASCII "FET1" in file order
4        4           uint32 LE     version      = 1
8        4           uint32 LE     face         = 0..5
12       4           uint32 LE     x            = tile column on that face
16       4           uint32 LE     y            = tile row on that face
20       4           uint32 LE     res          = vertices per edge (currently 33)
24       res*res*4   float32 LE    heights      = elevation in metres, row-major
24+4n    res*res     uint8         materials    = class id per vertex, row-major
```

`n = res * res`.

Exact length:

```
size(res) = 24 + res² × 4 + res² = 24 + 5 × res²
```

At the generator’s current resolution (`res = 33`): **5,469 bytes** per tile  
(`24 + 4,356 + 1,089`).

A reader **must** reject a file whose byte length is not `size(res)` after reading `res` from the header, or whose magic/version do not match.

There is no trailer, padding, or in-file CRC. When tiles are zipped, each entry’s CRC-32 is the IEEE 802.3 checksum of the raw `.fet` bytes (header + heights + materials).

---

## 3. Header fields

### 3.1 `magic` — `0x31544546`

The first four bytes on disk are the ASCII characters `F`, `E`, `T`, `1` (`46 45 54 31`). Read as a little-endian `uint32` that is the constant `0x31544546`.

A previous prototype used magic `0x4D415253` and the extension `.mars`. Those files are **not** FET. Do not alias them.

### 3.2 `version` — `1`

Only version 1 is defined. A reader that does not implement a given version must fail closed.

Version 2, if it appears, will be a different header width or extra fields after the current 24 bytes. It will not reuse version 1’s layout with a silent meaning change.

### 3.3 `face` — cube face `0..5`

| face | cube side | planet-frame mapping before spherify |
| ---: | --- | --- |
| 0 | +X | `(+1, v, −u)` |
| 1 | −X | `(−1, v, +u)` |
| 2 | +Y | `(+u, +1, −v)` |
| 3 | −Y | `(+u, −1, +v)` |
| 4 | +Z | `(+u, v, +1)` |
| 5 | −Z | `(−u, v, −1)` |

`u, v ∈ [−1, 1]` are face parameters. After the vector above is formed it is *spherified* (see §5) and normalized to a unit direction.

### 3.4 `x`, `y` — tile indices

A face is partitioned into an `N × N` grid of tiles (`N` is the generator preset: 16, 32, or 256). `x` and `y` are integers in `0 .. N−1`.

`N` is **not** stored in the tile. It is an attribute of the set: every tile in a ZIP or cache namespace was baked at the same `N` and `res`. Mixing `N` values in one set is undefined.

Suggested filename, which the generator writes:

```
F{face}-{x}-{y}.fet
```

Example: `F0-12-7.fet` is face `+X`, column 12, row 7.

### 3.5 `res` — vertices per edge

Must be `≥ 2`. The current writer always uses **33** (32 cells), which is the geomorph ladder Forge Engine already uses (`33 → 17 → 9 → 5 → 3`).

---

## 4. Payload

### 4.1 Heights

`res × res` IEEE-754 binary32 values, little-endian, row-major with `i` (column, `u`) fastest and `j` (row, `v`) slowest:

```
index = j * res + i
i, j ∈ 0 .. res-1
```

Units are **metres of planetary radius offset**: a vertex sits at

```
position = normalize(spherify(face, u, v)) * (R + height)
```

where `R` is the mean planetary radius used at bake time. For Mars that is **3,389,500 m**. Heights are typically in roughly `−9,000 … +22,000` for MOLA but the format does not clamp.

`NaN` and infinities are illegal. A writer that cannot sample a location must fail the tile, not emit a sentinel.

### 4.2 Materials

`res × res` unsigned bytes, same index order as heights.

| id | meaning |
| ---: | --- |
| 0 | unclassified (MOLA / elevation-only source) |
| 1–255 | reserved for a future class table (rock, dust, sand, ice, …) |

Version 1 writers fill the plane with `0`. Readers must accept any id and treat unknown ids as unclassified rather than rejecting the file.

---

## 5. Cube-sphere sampling

Vertex `(i, j)` of tile `(face, x, y)` on an `N`-tile face is sampled at

```
u = −1 + 2 * (x + i / (res − 1)) / N
v = −1 + 2 * (y + j / (res − 1)) / N
```

That puts tile corners on the shared parameter grid, so the east edge of `(x, y)` is the west edge of `(x+1, y)` with identical `(u, v)` and therefore identical height.

Spherify (Nowell / Snyder-style, applied to the pre-normalized cube vector `(X, Y, Z)`):

```
X' = X * sqrt(1 − Y²/2 − Z²/2 + Y²Z²/3)
Y' = Y * sqrt(1 − Z²/2 − X²/2 + Z²X²/3)
Z' = Z * sqrt(1 − X²/2 − Y²/2 + X²Y²/3)
dir = normalize(X', Y', Z')
```

Planet-frame geographic convention:

```
lat = asin(dir.y)          // degrees = lat * 180/π, +north
lon = atan2(dir.z, dir.x)  // degrees = lon * 180/π, +east of prime meridian
```

A renderer that is right-handed with `+Y` up and wants east-on-the-right mirrors `Z` for display only (`scene.z = −planet.z`). That mirror is **not** stored in the file.

---

## 6. What is not in the file

These belong to the *set* or the engine config, not the tile:

| datum | where it lives |
| --- | --- |
| tiles per face `N` | generator preset / ZIP sidecar / engine world config |
| planetary radius | engine constant (Mars: 3,389,500 m) |
| DEM identity (MOLA fingerprint) | generator cache key |
| CRC-32 | ZIP entry, or computed by the loader if it wants one |
| LOD level | derived from `res` by the engine |
| skirts, tangents, normals | generated at load |

A future version may add `N` and radius to the header so a lone file is self-describing. Version 1 loaders will ignore those files.

---

## 7. Sets and streaming

A playable region is the tiles whose centres lie inside an angular radius of a lat/lon, planned on the same `F#-x-y` grid, nearest-to-spawn first. Pack them as:

```
<region>.zip
  F0-3-4.fet
  F0-3-5.fet
  …
```

or split parts `<region>_PART-1.zip`, … when the set exceeds 50,000 files or 1 GiB. Classic ZIP (no ZIP64); method STORE.

An engine should:

1. Read the header, confirm magic/version/`res`.
2. Map `(face, x, y)` onto its own chunk key. `N` must match the world the tiles were baked for.
3. Upload heights as the authoritative surface used for **rendering, collision, and vehicle contact** — the three must sample the same grid.
4. Treat material `0` as a single albedo/splat until a class table exists.

---

## 8. Reference encode / decode

```ts
const FET_MAGIC = 0x31544546; // file bytes 46 45 54 31
const FET_VERSION = 1;

function encode(face: number, x: number, y: number, res: number,
                heights: Float32Array, materials: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(24 + res * res * 5);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, FET_MAGIC, true);
  view.setUint32(4, FET_VERSION, true);
  view.setUint32(8, face, true);
  view.setUint32(12, x, true);
  view.setUint32(16, y, true);
  view.setUint32(20, res, true);
  bytes.set(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength), 24);
  bytes.set(materials, 24 + res * res * 4);
  return bytes.buffer;
}
```

The generator implements this in `src/fet.ts` (`encodeFetTile` / `decodeFetTile`).

---

## 9. Change history

| version | notes |
| ---: | --- |
| 1 | Initial public format. Replaces the unpublished `.mars` prototype (`magic 0x4D415253`). Same 24-byte header shape; magic and extension changed so the two cannot be confused. |

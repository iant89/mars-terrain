# Ares Foundry — browser Mars terrain generator

A responsive, local-first terrain generation dashboard. Terrain tiles are generated in a Web Worker at 33 × 33 vertices, using 2.29 m source spacing and a 73.1 m source depth and exported as compact `.mars` binaries containing a header, Float32 elevation grid, and material map.

## Run

```bash
npm install
npm run dev
```

Generated tiles never need an output directory: when a run finishes, the completed `.mars` files are packaged into zip archives and downloaded by the browser automatically (or on demand via **Download ZIP**). When the file count or overall size is large, the set is split into multiple archives named `<name>_PART-1.zip`, `<name>_PART-2.zip`, …; a small set is delivered as a single `<name>.zip`. Individual tiles can still be downloaded from the Complete queue.

## 3D renderer

Click **3D view** after a tile completes, or use the eye icon beside an individual tile in **Complete**, to open the local terrain renderer. Completed height and material grids stream onto a real sphere while generation continues — the view is a planet, not a flat patch. The camera **orbits the planet**: drag to pan at a constant altitude, wheel to zoom from a 1 km cruise height out to a full-globe view. **Every generated chunk is drawn**; tiles on the far side of the globe stay hidden until you orbit them into view. The renderer supports:

- globe orbit / pan at constant altitude, wheel zoom (down to 1 km), and a **Fly** camera with WASD pan plus Q/E zoom;
- material, elevation, and slope shading;
- **true-scale relief by default** — every vertex is drawn at its actual elevation in metres (1 m up = 1 m across); the **Vertical scale** slider exaggerates it on demand;
- tile-grid and wireframe overlays, and configurable sun azimuth/elevation, with a **Relief shading** factor (hillshade z-factor, lighting only) so the sun direction reads on terrain that is nearly flat at kilometre vertex spacing;
- live latitude/longitude, elevation, altitude, material, tile, FPS, and triangle HUD data;
- **Follow generation** to keep the newest completed tile centred, **Show whole planet** / **Cruise at 1 km**, and **Save PNG** for a screenshot.

The renderer uses the same cube-sphere mapping and generated Float32 elevation grids as the `.mars` exporter, placed in planet-centered coordinates so the mesh is an actual globe the camera can orbit.

## Region export (game streaming)

**Settings → Starting position** restricts the job to the chunks around a starting position and discards the rest — nothing outside the region is ever generated. The queue generates nearest-to-spawn first, so the play area is ready in seconds and the outer ring finishes just as the player needs it; a game engine can build the remaining chunks on demand as the player approaches the outer edge, just before the missing ones would come into view. Planet-wide queues use the same nearest-first ordering (from the queue's first tile), so the 3D preview fills its window ring by ring instead of sweeping away from it. Region mode scales with the region rather than the planet, so even the ultra-high-density presets become runnable for a local play area. Regions are planned on the cube-sphere tile grid (`F#-x-y`) from latitude/longitude plus a radius in tiles, so the saved set matches the `.mars` headers the engine consumes.

The cube-sphere procedural model follows the supplied generator's Mars-specific architecture and NASA MOLA-informed planetary characteristics: hemispheric crustal dichotomy, Tharsis-style uplift, Valles-style incision, multi-scale impact cratering, and seamless absolute 3D sampling. It does not bundle or claim to reproduce NASA's full MOLA raster dataset.

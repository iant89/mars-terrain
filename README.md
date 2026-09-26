# Ares Foundry — browser Mars terrain generator

A responsive, local-first terrain generation dashboard. Terrain tiles are generated in a Web Worker at 33 × 33 vertices, using 2.29 m source spacing and a 73.1 m source depth and exported as compact `.mars` binaries containing a header, Float32 elevation grid, and material map.

## Run

```bash
npm install
npm run dev
```

Use **Select output** in a Chromium browser to link a directory. Existing complete `.mars` tiles are scanned on selection; output is written atomically only after a tile finishes. Without directory access, completed tiles can be downloaded individually.

The cube-sphere procedural model follows the supplied generator's Mars-specific architecture and NASA MOLA-informed planetary characteristics: hemispheric crustal dichotomy, Tharsis-style uplift, Valles-style incision, multi-scale impact cratering, and seamless absolute 3D sampling. It does not bundle or claim to reproduce NASA's full MOLA raster dataset.

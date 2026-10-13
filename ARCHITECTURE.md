# Architecture

Orbitalis is a standalone static Three.js application. Pelagia is its default scene. The initial public version preserves the v14 scene and runtime asset bytes.

## Runtime flow

`index.html` and `style.css` define the scene shell and static preview. `src/main.ts` connects controls to `src/lunar-controller.ts`, which owns gestures, scheduling, loading and fallback state. It lazily loads `src/lunar-scene.ts`; the scene reconstructs the chunked models, verifies SHA-256, checks texture compatibility and renders planet/background and station in separate camera-layer passes while sharing depth.

`src/station-motion.ts` owns radial alignment, orbital transforms and coherent rotor motion. `src/station-drag.ts` handles occlusion-aware picking and full-sphere relative dragging. `src/lunar-view.ts` bounds optical zoom and pan.

## Source and generated output

- `src/`: TypeScript runtime modules.
- `index.html`, `style.css`: authored page source.
- `public/`: favicon, scene manifest, fallback/background and locally downloaded model chunks.
- `assets-manifest.json`: pinned Release archive identity.
- `scripts/download-assets.mjs`: downloads the fixed archive, verifies it, extracts via `tar` and checks every model chunk.
- `scripts/build.mjs`: copies public assets and bundles into a fresh `dist/`; source never depends on existing output.
- `scripts/dev.mjs`, `scripts/serve.mjs`: rebuild TypeScript and serve localhost.
- `scripts/check.mjs`: inherited static/model checks, detached from private hosting metadata.
- `tests/`: focused suites with shared fixtures in `tests/helpers/` and baseline glTF data in `tests/fixtures/`.
- `.github/workflows/pages.yml`: builds and publishes the same source to GitHub Pages.

All browser asset references are relative to the document directory. They support both a root deployment and `/Orbitalis/`. Model chunks are served from the same origin, never directly fetched from Release URLs by the browser. Pages builds `main` on push or manual dispatch, matching the environment branch policy. The Pages build job reads existing Pages configuration; only the deploy job has write and OIDC permissions.

## Resource boundary

The 181 MB planet model and 22 MB station model retain original bytes, geometry, materials and chunk hashes. Large chunks are ignored by Git and distributed in Releases. The current 16K texture is embedded in the planet model. Blender/editable resources live in a separate Release archive; see `docs/assets.md` for reproduction limits.

## Limits and maintenance

The longest drawing-buffer edge is fixed at 3840 pixels. The original texture must fit the GPU without silent resizing. Rendering failures use the static fallback; the first public version has no reduced-resolution 3D tier. Runtime SHA-256 requires a secure context. Real browser GPU validation and cross-device performance are not established by mocked tests or offline Blender renders.

Keep source modules below 1000 lines. Update this file when changing runtime flow or deployment boundaries. Run package verification commands only when explicitly requested; dependency installation and building for a requested release generate required publication artifacts.

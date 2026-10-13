# Assets and provenance

The first release derives from the supplied v14 pre-optimization backup. Publication reorganizes the project without recompressing or changing its deployed model chunks. Internal hosting and Library identifiers and superseded review materials are excluded.

## Current scene

| Asset | Recorded origin and content |
| --- | --- |
| Planet geometry | Project Blender scene; one mesh and 16,128 triangles |
| Planet texture | Sixteen user-supplied 3840 × 1920 tiles assembled into one 15360 × 7680 RGB PNG without resampling; the original producer is not recorded in the supplied snapshot |
| Station | Project Blender model and independent rotor rig; 66 mesh groups, 13 materials, 429,760 triangles |
| Background and fallback | Project image assets and offline Blender renders; the fallback is a static composition |

Project code and the project scene assets distributed in v0.1.0 are released under the root MIT license. This provenance record describes the information present in the supplied backup; it is not independent verification of the original texture producer. Third-party dependencies retain their own licenses.

## Exact runtime identities

- Planet GLB: 181,207,568 bytes; SHA-256 `1522f5617420faf22cf1558d40e6a3dd8f8d525e3246bac1a9861db3919e46b9`.
- Embedded PNG: 180,706,567 bytes; SHA-256 `ac70232759343add6010a74618390d1bbd64e4e1ff7ff651c65c5578e758a10a`.
- Station GLB: 21,630,136 bytes; SHA-256 `8ebabb6f21116ed375971a446ea5d62be0d34ad6fd1a04f98360e4f375e6c820`.

The committed scene manifest records each model chunk and its SHA-256. The separate runtime archive contains only those unchanged model chunks. Background, fallback and the scene manifest are already in the source checkout.

## Editable archive

The editable Release archive contains the project planet and station Blender sources, the final independent rotor `.blend`, selected Python generation/export/verification scripts, and the exact PNG extracted from the current planet GLB. Run `node scripts/export-editable.mjs` after downloading runtime assets to assemble the exact final GLBs for Blender import.

The supplied planet Blender file is from an earlier cinematic source stage. To reproduce the current texture, use the extracted native PNG rather than that file's earlier texture. Final geometry and materials are preserved in the assembled current GLBs, which Blender can import. Importing a GLB does not restore all original authoring modifiers.

The original sixteen input ZIPs and their intermediate workspace are absent from this snapshot. Older scripts that expected those inputs are not part of the public reconstruction workflow. The final station `.blend` already contains the independent rotor rig; use it directly instead of replaying historical rig changes.

## Export workflow

Install Blender separately when editing assets. Inspect the included source README and scripts before exporting: scripts assume specific Blender object names and were authored for the scene pipeline. Export scripts run in Blender's Python environment, not ordinary browser Node.js.

A new asset revision requires updating the model chunks, their byte sizes/hashes and the scene manifest together. Keep v0.1.0 Release downloads unchanged and publish a new version for changed assets. If updating preview images, update source and built output consistently.

Offline Cycles renders approximate runtime lighting and are not evidence of browser GPU performance or identical WebGL output.

import { sceneFixture, authoredManifest, zero, decodeAssets, context, rendered, expectSourceDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('station drag scene wiring', () => {
  it('uses the rendered camera, preserves 4K and depth passes, and invalidates picking on disposal', async () => {
    const decoded = decodeAssets()
    Object.assign(sceneFixture.manifest.station, {
      position: authoredManifest.station.position,
      quaternion: authoredManifest.station.quaternion,
      scale: authoredManifest.station.scale,
      motion: authoredManifest.station.motion
    })
    for (const name of ['StationHull', 'StationAnnulus']) {
      const mesh = decoded.station.group.getObjectByName(name)!
      mesh.position.set(0, 0, 0)
      mesh.rotation.set(0, 0, 0)
      mesh.scale.set(70, 70, 70)
    }
    decoded.station.group.getObjectByName('AnnularFixturePivot')!.position.set(0, 0, 0)
    const live = await context().create()
    live.resize(1600, 1200, 2.4)
    const pose = { ...zero, stationOrbit: 0 }
    const view = { zoom: 2, panX: -.2, panY: -.1 }
    live.render(pose, view)
    const frame = rendered()
    const p = frame.station.position.clone().project(frame.camera)
    const point = { x: p.x / 2, y: -p.y / 2 }
    expect(live.stationDrag).toBeDefined()
    expect(live.stationDrag!.hitTest(point, pose, view)).toBe(true)
    expect(live.stationDrag!.begin(point, pose, view)).toBe(true)
    expect(live.stationDrag!.move(point, pose, view)!.stationOrbit).toBe(0)
    live.render({ ...pose, orbit: 2 }, view)
    expect(frame.station.position.toArray()).toEqual(authoredManifest.station.position)
    expect(frame.camera.zoom).toBe(2)
    expect(frame.renderer.context.drawingBufferWidth).toBe(3840)
    expect(frame.renderer.context.drawingBufferHeight).toBe(2880)
    expect(frame.renderer.clearDepth).not.toHaveBeenCalled()
    live.dispose()
    expect(live.stationDrag!.hitTest(point, pose, view)).toBe(false)
    expect(live.stationDrag!.begin(point, pose, view)).toBe(false)
    expect(live.stationDrag!.move(point, pose, view)).toBeNull()
    expectSourceDisposed(decoded.planet)
    expectSourceDisposed(decoded.station)
  })
})

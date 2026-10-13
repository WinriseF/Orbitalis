import { sceneFixture, zero, decodeAssets, context, rendered, expectSourceDisposed, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('independent annular rotor rendering', () => {
  it('turns the ring relative to a fixed mast, preserves zoom and restores the authored ring pose', async () => {
    const decoded = decodeAssets()
    const rotor = decoded.station.group.getObjectByName('AnnularFixturePivot')!
    rotor.position.set(0, 0, 0)
    const mast = decoded.station.group.getObjectByName('StationHull')!
    sceneFixture.manifest.station.motion.spinRadiansPerSecond = 0
    sceneFixture.manifest.station.motion.driftAmplitude = [0, 0, 0]
    sceneFixture.manifest.station.motion.driftRadiansPerSecond = 0
    sceneFixture.manifest.station.rotor = { nodeName: rotor.name, axis: [0, 1, 0], radiansPerSecond: .1 }
    const live = await context().create()
    live.resize(1600, 1200, 2.4)
    const view = { zoom: 3, panX: -.6, panY: -.4 }
    live.render(zero, view)
    const original = rotor.quaternion.clone()
    const mastInitial = mast.matrix.clone()
    const fixedRoot = rendered().station.matrixWorld.clone()
    live.render({ yaw: .8, pitch: -.2, orbit: 5 * .24 }, view)
    expect(rotor.quaternion.angleTo(original)).toBeCloseTo(.5, 10)
    const atFive = rotor.quaternion.clone()
    live.render({ yaw: .8, pitch: -.2, orbit: 12 * .24 }, view)
    const frame = rendered()
    expect(rotor.quaternion.angleTo(atFive)).toBeCloseTo(.7, 10)
    expect(frame.station.matrixWorld.elements).toEqual(fixedRoot.elements)
    expect(mast.matrix.elements).toEqual(mastInitial.elements)
    expect(frame.camera.zoom).toBe(3)
    expect(frame.renderer.context.drawingBufferWidth).toBe(3840)
    expect(frame.renderer.context.drawingBufferHeight).toBe(2880)
    live.render(zero)
    expect(rotor.quaternion.toArray()).toEqual(original.toArray())
    live.dispose()
    expectSourceDisposed(decoded.planet)
    expectSourceDisposed(decoded.station)
  })

  it('cleans up both loaded models if the declared rotor is absent', async () => {
    const decoded = decodeAssets()
    sceneFixture.manifest.station.rotor = { nodeName: 'Missing_Rotor', axis: [0, 1, 0], radiansPerSecond: .1 }
    await expect(context().create()).rejects.toThrow()
    expectSourceDisposed(decoded.planet)
    expectSourceDisposed(decoded.station)
    expectRendererDisposed()
  })
})


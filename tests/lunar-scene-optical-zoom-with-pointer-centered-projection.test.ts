import { sceneFixture, zero, decodeAssets, context, rendered } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('optical zoom with pointer-centered projection', () => {
  it.each([[1920, 1080], [390, 844]])('anchors actual projected points at %i×%i without moving the camera or changing 4K pixels', async (width, height) => {
    decodeAssets()
    const live = await context().create()
    const resolution = live.resize(width, height, lunarPixelRatio(width, height))
    live.render(zero)
    const { camera, renderer } = rendered()
    camera.updateMatrixWorld(true)
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()
    const originalProjection = camera.projectionMatrix.clone()
    const sizeCalls = renderer.setSize.mock.calls.length
    const pixelRatioCalls = renderer.setPixelRatio.mock.calls.length
    const anchor = { x: .3, y: .2 }
    const detail = new THREE.Vector3(anchor.x * 2, -anchor.y * 2, .8).unproject(camera)
    const other = new THREE.Vector3(-.2, .3, .8).unproject(camera)
    const view = zoomLunarView(defaultLunarView(), 6, anchor)
    live.render(zero, view)
    const detailScreen = detail.clone().project(camera)
    const otherScreen = other.clone().project(camera)
    expect(detailScreen.x / 2).toBeCloseTo(anchor.x, 10)
    expect(-detailScreen.y / 2).toBeCloseTo(anchor.y, 10)
    expect(otherScreen.x / 2).toBeCloseTo(6 * (-.1 - anchor.x) + anchor.x, 10)
    expect(-otherScreen.y / 2).toBeCloseTo(6 * (-.15 - anchor.y) + anchor.y, 10)
    expect(camera.zoom).toBe(6)
    expect(camera.aspect).toBe(width / height)
    expect(camera.position.toArray()).toEqual(position.toArray())
    expect(camera.quaternion.toArray()).toEqual(quaternion.toArray())
    expect(camera.view).toMatchObject({ fullWidth: width, fullHeight: height, width, height })
    expect(renderer.setSize).toHaveBeenCalledTimes(sizeCalls)
    expect(renderer.setPixelRatio).toHaveBeenCalledTimes(pixelRatioCalls)
    expect(Math.max(resolution!.width, resolution!.height)).toBe(3840)
    expect(renderer.context.drawingBufferWidth).toBe(resolution!.width)
    expect(renderer.context.drawingBufferHeight).toBe(resolution!.height)
    // Two-finger pan moves that same detail from the old midpoint to the center.
    live.render(zero, zoomLunarView(view, 6, anchor, { x: 0, y: 0 }))
    expect(detail.clone().project(camera).x).toBeCloseTo(0, 10)
    expect(detail.clone().project(camera).y).toBeCloseTo(0, 10)
    live.render(zero, defaultLunarView())
    expect(camera.projectionMatrix.elements).toEqual(originalProjection.elements)
    live.dispose()
  })

  it('retains zoom through aspect changes and preserves authored camera position and clipping planes', async () => {
    decodeAssets()
    const live = await context().create()
    live.resize(1920, 1080, 2)
    live.render(zero, zoomLunarView(defaultLunarView(), 3, { x: .2, y: .1 }))
    const { camera } = rendered()
    live.resize(390, 844, lunarPixelRatio(390, 844))
    expect(camera.zoom).toBe(3)
    expect(camera.aspect).toBeCloseTo(390 / 844)
    expect(camera.view).toMatchObject({ fullWidth: 390, fullHeight: 844, width: 390, height: 844 })
    expect(camera.position.toArray()).toEqual(sceneFixture.manifest.camera.position)
    expect(camera.near).toBe(sceneFixture.manifest.camera.near)
    expect(camera.far).toBe(sceneFixture.manifest.camera.far)
    expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true)
    live.dispose()
  })
})


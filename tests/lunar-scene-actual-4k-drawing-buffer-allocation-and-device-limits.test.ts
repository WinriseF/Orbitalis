import { sceneFixture, mocks, decodeAssets, context, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('actual 4K drawing-buffer allocation and device limits', () => {
  it.each([
    [1920, 1080, 3840, 2160],
    [480, 270, 3840, 2160],
    [3840, 2160, 3840, 2160],
    [1080, 1920, 2160, 3840],
    [390, 844, 1774, 3840],
    [280, 900, 1195, 3840],
    [1600, 1200, 3840, 2880]
  ])('allocates %ix%i CSS pixels as a real %ix%i drawing buffer', async (width, height, expectedWidth, expectedHeight) => {
    decodeAssets()
    const live = await context().create()
    const result = live.resize(width, height, lunarPixelRatio(width, height))
    const renderer = mocks.renderers[0]
    expect(renderer.setSize).toHaveBeenLastCalledWith(expectedWidth, expectedHeight, false)
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1)
    expect(renderer.domElement.width).toBe(expectedWidth)
    expect(renderer.domElement.height).toBe(expectedHeight)
    expect(result).toEqual({ width: expectedWidth, height: expectedHeight, requestedWidth: expectedWidth, requestedHeight: expectedHeight, limited: false })
    expect(renderer.domElement.style).toEqual({ display: 'block', width: '100%', height: '100%' })
    live.dispose()
  })

  it.each([
    ['texture', 2048, 16384, [16384, 16384], 1920, 1080, 2048, 1152],
    ['renderbuffer', 16384, 1024, [16384, 16384], 1920, 1080, 1024, 576],
    ['viewport height', 16384, 16384, [4096, 1600], 1920, 1080, 2844, 1600],
    ['viewport width', 16384, 16384, [1800, 4096], 1080, 1920, 1800, 3200]
  ] as const)('clamps both axes to the %s limit while preserving aspect', async (_name, texture, renderbuffer, viewport, width, height, expectedWidth, expectedHeight) => {
    // Drawing-buffer limits are separate from source-texture compatibility.
    sceneFixture.manifest.textureSource = { dimensions: [1024, 512] }
    mocks.limits = { texture, renderbuffer, viewport: [...viewport] }
    decodeAssets()
    const live = await context().create()
    const result = live.resize(width, height, lunarPixelRatio(width, height))
    expect(result).toEqual({
      width: expectedWidth, height: expectedHeight,
      requestedWidth: Math.round(width * lunarPixelRatio(width, height)),
      requestedHeight: Math.round(height * lunarPixelRatio(width, height)), limited: true
    })
    expect(Math.abs(expectedWidth - expectedHeight * width / height)).toBeLessThanOrEqual(1)
    expect(mocks.renderers[0].setSize).toHaveBeenLastCalledWith(expectedWidth, expectedHeight, false)
    live.dispose()
  })

  it('reports actual driver dimensions rather than the requested canvas size', async () => {
    mocks.driverScale = .5
    decodeAssets()
    const live = await context().create()
    const result = live.resize(1920, 1080, 2)
    expect(mocks.renderers[0].domElement.width).toBe(3840)
    expect(result).toEqual({ width: 1920, height: 1080, requestedWidth: 3840, requestedHeight: 2160, limited: true })
    live.dispose()
  })

  it('caches GL limits once and never queries them during motion or subsequent resizes', async () => {
    decodeAssets()
    const live = await context().create()
    const renderer = mocks.renderers[0]
    expect(renderer.getContext).toHaveBeenCalledTimes(1)
    expect(renderer.context.getParameter.mock.calls).toEqual([
      [renderer.context.MAX_TEXTURE_SIZE], [renderer.context.MAX_RENDERBUFFER_SIZE], [renderer.context.MAX_VIEWPORT_DIMS]
    ])
    live.resize(1920, 1080, 2)
    for (let i = 0; i < 100; i++) live.render({ yaw: i * .01, pitch: 0, orbit: i * .03 })
    live.resize(1080, 1920, 2)
    expect(renderer.context.getParameter).toHaveBeenCalledTimes(3)
    expect(renderer.context.getError).toHaveBeenCalledTimes(1)
    expect(renderer.context.isContextLost).toHaveBeenCalledTimes(1)
    live.dispose()
  })

  it('rejects unavailable capabilities and an empty drawing buffer without inventing a 4K result', async () => {
    mocks.limits.texture = 0
    await expect(context().create()).rejects.toThrow('Unable to verify WebGL drawing-buffer limits')
    expectRendererDisposed()
    expect(fetch).not.toHaveBeenCalled()
    mocks.limits.texture = 16384
    decodeAssets()
    const live = await context().create()
    mocks.driverScale = 0
    expect(() => live.resize(1920, 1080, 2)).toThrow('WebGL drawing buffer is unavailable')
    live.dispose()
  })
})


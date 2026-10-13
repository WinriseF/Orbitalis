import { sceneFixture, mocks, zero, decodeAssets, context, expectSourceDisposed, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('original texture compatibility guard', () => {
  it.each([[15360, 7680], [7680, 15360]] as const)('rejects native %i × %i before all model downloads on an 8192-limit device', async (width, height) => {
    mocks.limits.texture = 8192
    sceneFixture.manifest.textureSource = { dimensions: [width, height] }
    sceneFixture.manifest.model = { files: [{ name: 'native-model.bin', bytes: 20 * 1024 * 1024 }], bytes: 20 * 1024 * 1024 }
    const h = context()
    const error = await h.create().catch(error => error)
    expect(error).toBeInstanceOf(LunarTextureLimitError)
    expect(error).toMatchObject({ width, height, maxTextureSize: 8192 })
    expect(error.message).toBe(`Original texture ${width} × ${height} exceeds device texture limit 8192 × 8192`)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('./media/cinematic/scene.json', expect.anything())
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('preserves the complete native 15360 × 7680 image on a 16384-limit device and keeps the fixed 4K canvas', async () => {
    mocks.limits.texture = 16384
    sceneFixture.manifest.textureSource = { dimensions: [15360, 7680] }
    const { planet } = decodeAssets()
    const live = await context().create()
    const resolution = live.resize(1920, 1080, lunarPixelRatio(1920, 1080))
    live.render(zero)
    expect(planet.material.map).toBe(planet.texture)
    expect(planet.material.map!.image).toBe(planet.image)
    expect([planet.image.width, planet.image.height]).toEqual([15360, 7680])
    expect(resolution).toEqual({ width: 3840, height: 2160, requestedWidth: 3840, requestedHeight: 2160, limited: false })
    expect(createImageBitmap).toHaveBeenCalledTimes(1) // Only the separate background.
    live.dispose()
  })

  it.each(['missing map', 'missing image', 'downsized image'])('rejects a %s after GLTF parsing instead of rendering an incomplete planet', async mode => {
    sceneFixture.manifest.textureSource = { dimensions: [15360, 7680] }
    const { planet, station } = decodeAssets()
    if (mode === 'missing map') planet.material.map = null
    else if (mode === 'missing image') planet.texture.image = null
    else planet.image.width = 7680
    const h = context()
    await expect(h.create()).rejects.toThrow('Original planet texture did not decode at its native dimensions')
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    // The fixture shares map/normalMap and a second image reference, exercising cleanup too.
    expectSourceDisposed(planet)
    expect(station.spies.material).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each([[7680, 3840], [3840, 7680]] as const)('rejects original %i × %i before model downloads or parsing on a 4096-limit device', async (width, height) => {
    mocks.limits.texture = 4096
    sceneFixture.manifest.textureSource = { dimensions: [width, height] }
    sceneFixture.manifest.model = { files: [{ name: 'large_model.bin', bytes: 20 * 1024 * 1024 }], bytes: 20 * 1024 * 1024 }
    const h = context()
    await expect(h.create()).rejects.toMatchObject({ name: 'LunarTextureLimitError', width, height, maxTextureSize: 4096 })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('./media/cinematic/scene.json', expect.anything())
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('uses the current manifest dimensions without calling a 7680-wide source 8192 or 8K', async () => {
    mocks.limits.texture = 4096
    sceneFixture.manifest.textureSource = { dimensions: [7680, 3840] }
    const h = context()
    const error = await h.create().catch(error => error)
    expect(error).toBeInstanceOf(LunarTextureLimitError)
    expect(error.message).toContain('7680 × 3840')
    expect(error.message).not.toMatch(/8K|8192/)
    expectRendererDisposed()
  })

  it('accepts an exact-fit original texture without resizing its data', async () => {
    mocks.limits.texture = 7680
    sceneFixture.manifest.textureSource = { dimensions: [7680, 3840] }
    decodeAssets()
    const live = await context().create()
    expect(mocks.parseAsync).toHaveBeenCalledWith(sceneFixture.glbData, './media/cinematic/')
    expect(createImageBitmap).toHaveBeenCalledTimes(1) // Only the background is decoded here.
    live.dispose()
  })

  it('keeps legacy manifests without texture metadata working', async () => {
    delete sceneFixture.manifest.textureSource
    mocks.limits.texture = 2048
    decodeAssets()
    const live = await context().create()
    expect(mocks.parseAsync).toHaveBeenCalledWith(sceneFixture.glbData, './media/cinematic/')
    live.dispose()
  })

  it.each([[0, 3840], [7680, -1], [7680.5, 3840], [7680], [7680, 3840, 1]].map(dimensions => ({ dimensions })))('rejects invalid dimension metadata $dimensions before model downloads', async ({ dimensions }) => {
    sceneFixture.manifest.textureSource = { dimensions: dimensions as [number, number] }
    await expect(context().create()).rejects.toThrow('Invalid original texture dimensions')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })
})



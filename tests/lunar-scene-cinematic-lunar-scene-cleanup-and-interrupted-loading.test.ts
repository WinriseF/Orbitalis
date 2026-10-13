import { sceneFixture, mocks, Bitmap, zero, deferred, responseFor, asset, decodeAssets, context, rendered, expectSourceDisposed, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('cinematic lunar scene cleanup and interrupted loading', () => {
  it('deduplicates shared planet/station resources, atmosphere geometry and ImageBitmaps, then makes disposal inert', async () => {
    const a = asset(), b = asset('station')
    b.group.traverse(object => {
      if (object instanceof THREE.Mesh) { object.geometry = a.geometry; object.material = [a.material] }
    })
    sceneFixture.backgroundImage = a.image
    decodeAssets(a, b)
    const h = context()
    const live = await h.create()
    live.render(zero)
    const { scene, root, stationSource, shells, renderer } = rendered()
    const shellGeometry = vi.spyOn(shells[0].geometry, 'dispose')
    const shellMaterials = shells.map(shell => vi.spyOn(shell.material, 'dispose'))
    const backgroundDispose = vi.spyOn(scene.background as THREE.Texture, 'dispose')
    const before = stationSource.matrixWorld.clone()
    live.dispose()
    live.dispose()
    expectSourceDisposed(a)
    shellMaterials.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1))
    expect(shellGeometry).toHaveBeenCalledTimes(1)
    expect(backgroundDispose).toHaveBeenCalledTimes(1)
    expectRendererDisposed()
    expect(root.visible).toBe(false)
    live.render({ yaw: 1, pitch: 1, orbit: 1 })
    live.resize(400, 300, 1)
    expect(stationSource.matrixWorld.elements).toEqual(before.elements)
    expect(renderer.render).toHaveBeenCalledTimes(2)
    expect(renderer.setSize).not.toHaveBeenCalled()
    expect(renderer.setPixelRatio).not.toHaveBeenCalled()
    const event = new Event('webglcontextlost', { cancelable: true })
    renderer.domElement.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(h.lost).not.toHaveBeenCalled()
  })

  it('reports context loss without reconstruction and removes the listener on disposal', async () => {
    decodeAssets()
    const h = context()
    const live = await h.create()
    const renderer = mocks.renderers[0]
    const event = new Event('webglcontextlost', { cancelable: true })
    renderer.domElement.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(h.lost).toHaveBeenCalledTimes(1)
    expect(mocks.renderers).toHaveLength(1)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(2)
    expect(renderer.render).not.toHaveBeenCalled()
    live.dispose()
    renderer.domElement.dispatchEvent(new Event('webglcontextlost'))
    expect(h.lost).toHaveBeenCalledTimes(1)
    expect(sceneFixture.backgroundImage.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['manifest', './media/cinematic/scene.json', 0],
    ['planet', './media/cinematic/scene_assets.glb', 0],
    ['station', './media/cinematic/station_test.bin', 1],
    ['background', './media/cinematic/space_subtle.webp', 2]
  ] as const)('cleans up after a %s fetch/HTTP failure without mounting interactive content', async (_asset, path, decoded) => {
    for (const mode of ['network', 'http'] as const) {
      const { planet: a, station: b } = decodeAssets()
      const h = context()
      mocks.renderers.length = 0
      vi.mocked(fetch).mockReset().mockImplementation(async input => {
        if (input !== path) return responseFor(input)
        if (mode === 'network') throw new Error('network failed')
        return { ok: false, status: 503 } as Response
      })
      await expect(h.create()).rejects.toThrow(mode === 'network' ? 'network failed' : 'Cinematic asset HTTP 503')
      expect(h.host.appendChild).not.toHaveBeenCalled()
      expect(mocks.renderers[0].render).not.toHaveBeenCalled()
      expectRendererDisposed()
      expect(mocks.parseAsync).toHaveBeenCalledTimes(decoded)
      if (decoded >= 1) expectSourceDisposed(a)
      else for (const spy of Object.values(a.spies)) expect(spy).not.toHaveBeenCalled()
      if (decoded === 2) expectSourceDisposed(b)
      else for (const spy of Object.values(b.spies)) expect(spy).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(sceneFixture.manifest.fallback))).toBe(false)
    }
  })

  it.each(['manifest JSON', 'planet GLB', 'station GLB', 'background bitmap'])('cleans up after %s decoding fails', async stage => {
    const { planet: a, station: b } = decodeAssets()
    const h = context()
    if (stage === 'manifest JSON') vi.mocked(fetch).mockImplementation(async path => path === './media/cinematic/scene.json'
      ? { ok: true, json: async () => { throw new Error('invalid JSON') } } as unknown as Response : responseFor(path))
    if (stage === 'planet GLB') mocks.parseAsync.mockReset().mockRejectedValueOnce(new Error('invalid planet GLB'))
    if (stage === 'station GLB') mocks.parseAsync.mockReset().mockResolvedValueOnce({ scene: a.group }).mockRejectedValueOnce(new Error('invalid station GLB'))
    if (stage === 'background bitmap') vi.mocked(createImageBitmap).mockRejectedValue(new Error('invalid bitmap'))
    await expect(h.create()).rejects.toThrow('invalid')
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
    if (stage === 'station GLB' || stage === 'background bitmap') expectSourceDisposed(a)
    if (stage === 'background bitmap') expectSourceDisposed(b)
    else for (const spy of Object.values(b.spies)) expect(spy).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes(sceneFixture.manifest.fallback))).toBe(false)
  })

  it.each(['https://example.com/space.webp', '//example.com/space.webp', '../space.webp', 'nested/space.webp', 'space.webp?token=1'])('rejects unsafe background path %s before requesting it', async path => {
    const { planet: a, station: b } = decodeAssets()
    sceneFixture.manifest.background = path
    const h = context()
    await expect(h.create()).rejects.toThrow('Invalid cinematic asset path')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expectSourceDisposed(a)
    expectSourceDisposed(b)
    expectRendererDisposed()
    expect(h.host.appendChild).not.toHaveBeenCalled()
  })

  it('rejects a missing planet instead of presenting an incomplete interactive scene', async () => {
    const { planet: a } = decodeAssets()
    a.group.remove(a.group.getObjectByName(sceneFixture.manifest.planet.prototype)!)
    const h = context()
    await expect(h.create()).rejects.toThrow('Missing planet geometry')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectSourceDisposed(a)
    expectRendererDisposed()
  })

  it('rejects missing station model metadata and cleans up the already decoded planet', async () => {
    const { planet: a } = decodeAssets()
    delete (sceneFixture.manifest.station as { model?: LunarModelManifest }).model
    await expect(context().create()).rejects.toThrow('Missing station model')
    expect(fetch).toHaveBeenCalledTimes(2)
    expectSourceDisposed(a)
    expectRendererDisposed()
  })

  it('aborting before loading skips all fetches, decoding and mounting', async () => {
    const h = context()
    h.abort.abort()
    await expect(h.create()).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each(['planet', 'station'] as const)('aborting while %s bytes are pending skips its decode even if bytes later arrive', async stage => {
    const { planet: a } = decodeAssets()
    const h = context()
    const bytes = deferred<ArrayBuffer>()
    const reading = vi.fn(() => bytes.promise)
    const path = `./media/cinematic/${stage === 'planet' ? 'scene_assets.glb' : 'station_test.bin'}`
    vi.mocked(fetch).mockImplementation(async input => input === path
      ? { ok: true, arrayBuffer: reading } as unknown as Response : responseFor(input))
    const loading = h.create()
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1), { interval: 1 })
    h.abort.abort()
    bytes.resolve(stage === 'planet' ? sceneFixture.glbData : sceneFixture.stationData)
    await rejected
    expect(mocks.parseAsync).toHaveBeenCalledTimes(stage === 'planet' ? 0 : 1)
    if (stage === 'station') expectSourceDisposed(a)
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each(['planet', 'station'] as const)('aborting during %s parsing disposes late-returned models without mounting', async stage => {
    const a = asset(), b = asset('station')
    const h = context()
    const parseGate = deferred<{ scene: THREE.Group }>()
    if (stage === 'station') mocks.parseAsync.mockResolvedValueOnce({ scene: a.group })
    mocks.parseAsync.mockReturnValueOnce(parseGate.promise)
    const loading = h.create()
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(mocks.parseAsync).toHaveBeenCalledTimes(stage === 'planet' ? 1 : 2), { interval: 1 })
    h.abort.abort()
    parseGate.resolve({ scene: stage === 'planet' ? a.group : b.group })
    await rejected
    expectSourceDisposed(a)
    if (stage === 'station') expectSourceDisposed(b)
    expectRendererDisposed()
    expect(fetch).toHaveBeenCalledTimes(stage === 'planet' ? 2 : 3)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
  })

  it('aborting during background decoding closes the late bitmap and both decoded model resources', async () => {
    const { planet: a, station: b } = decodeAssets()
    const h = context()
    const bitmapGate = deferred<Bitmap>()
    vi.mocked(createImageBitmap).mockReturnValue(bitmapGate.promise as unknown as Promise<ImageBitmap>)
    const loading = h.create()
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1), { interval: 1 })
    h.abort.abort()
    bitmapGate.resolve(sceneFixture.backgroundImage)
    await rejected
    expectSourceDisposed(a)
    expectSourceDisposed(b)
    expect(sceneFixture.backgroundImage.close).toHaveBeenCalledTimes(1)
    expectRendererDisposed()
    expect(h.host.appendChild).not.toHaveBeenCalled()
  })
})


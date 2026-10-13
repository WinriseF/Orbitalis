import { sceneFixture, mocks, deferred, responseFor, decodeAssets, context, expectSourceDisposed, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('station model chunk integrity and interrupted loading', () => {
  function stationChunks() {
    const assets = decodeAssets()
    const entries = [
      { name: 'station-02.bin', data: new Uint8Array([83, 84, 65, 84]) },
      { name: 'station-01.bin', data: new Uint8Array([73, 79, 78]) }
    ]
    sceneFixture.manifest.station.model = { files: entries.map(({ name, data }) => ({ name, bytes: data.byteLength })), bytes: 7 }
    vi.mocked(fetch).mockImplementation(async path => {
      const chunk = entries.find(entry => path === `./media/cinematic/${entry.name}`)
      return chunk ? new Response(chunk.data) : responseFor(path)
    })
    return { ...assets, entries }
  }

  it('reassembles and hashes station chunks in manifest order after the planet has decoded', async () => {
    const { entries } = stationChunks()
    vi.stubGlobal('crypto', webcrypto)
    const bytes = new Uint8Array(entries.flatMap(entry => Array.from(entry.data)))
    const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
    sceneFixture.manifest.station.model.files.forEach((file, i) => { file.sha256 = digest(entries[i].data) })
    sceneFixture.manifest.station.model.sha256 = digest(bytes)
    const live = await context().create()
    expect(mocks.parseAsync).toHaveBeenCalledTimes(2)
    expect(new Uint8Array(mocks.parseAsync.mock.calls[1][0])).toEqual(bytes)
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      './media/cinematic/scene.json', './media/cinematic/scene_assets.glb',
      ...entries.map(entry => `./media/cinematic/${entry.name}`), `./media/cinematic/${sceneFixture.manifest.background}`
    ])
    live.dispose()
  })

  it.each(['chunk', 'whole'])('rejects station %s hash mismatch and disposes the previously loaded planet', async stage => {
    const { planet: a } = stationChunks()
    vi.stubGlobal('crypto', webcrypto)
    if (stage === 'chunk') sceneFixture.manifest.station.model.files[0].sha256 = '0'.repeat(64)
    else sceneFixture.manifest.station.model.sha256 = '0'.repeat(64)
    const h = context()
    await expect(h.create()).rejects.toThrow('SHA-256 mismatch')
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(stage === 'chunk' ? 3 : 4)
    expectSourceDisposed(a)
    expectRendererDisposed()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it.each([
    ['unsafe path', { files: [{ name: '../station.bin', bytes: 4 }], bytes: 4 }],
    ['empty file list', { files: [], bytes: 4 }],
    ['oversized chunk', { files: [{ name: 'station.bin', bytes: 20 * 1024 * 1024 + 1 }], bytes: 20 * 1024 * 1024 + 1 }],
    ['size mismatch', { files: [{ name: 'station.bin', bytes: 4 }], bytes: 5 }]
  ])('rejects station %s metadata before downloading it, then cleans up the planet', async (_label, model) => {
    const { planet: a } = stationChunks()
    sceneFixture.manifest.station.model = model as LunarModelManifest
    await expect(context().create()).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expectSourceDisposed(a)
    expectRendererDisposed()
  })

  it.each([2, 5])('rejects a %i-byte station response declared as four bytes without decoding station data', async length => {
    const { planet: a, entries } = stationChunks()
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? new Response(new Uint8Array(length)) : normalFetch(path, options))
    await expect(context().create()).rejects.toThrow('chunk byte length mismatch')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expectSourceDisposed(a)
    expectRendererDisposed()
  })

  it('cancels a pending station stream and releases the decoded planet without later fetches', async () => {
    const { planet: a, entries } = stationChunks()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([83])) }, cancel })
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? new Response(stream) : normalFetch(path, options))
    const h = context()
    const loading = h.create()
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(stream.locked).toBe(true), { interval: 1 })
    h.abort.abort()
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expectSourceDisposed(a)
    expectRendererDisposed()
    expect(h.host.appendChild).not.toHaveBeenCalled()
  })

  it('aborting a pending station hash prevents further chunks and disposes the planet', async () => {
    const { planet: a } = stationChunks()
    const gate = deferred<ArrayBuffer>()
    const digest = vi.fn(() => gate.promise)
    vi.stubGlobal('crypto', { subtle: { digest } })
    sceneFixture.manifest.station.model.files[0].sha256 = '0'.repeat(64)
    const h = context()
    const loading = h.create()
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(1), { interval: 1 })
    h.abort.abort()
    gate.resolve(new ArrayBuffer(32))
    await rejected
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(1)
    expectSourceDisposed(a)
    expectRendererDisposed()
  })
})


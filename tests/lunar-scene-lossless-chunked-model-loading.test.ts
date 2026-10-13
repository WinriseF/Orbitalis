import { sceneFixture, mocks, zero, deferred, responseFor, asset, decodeAssets, context, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('lossless chunked model loading', () => {
  function chunks() {
    const entries = [
      { name: 'scene_model_02.bin', data: new Uint8Array([103, 108, 84, 70]) },
      { name: 'scene_model_01.bin', data: new Uint8Array([2, 0, 0]) },
      { name: 'scene_model_03.bin', data: new Uint8Array([0, 12, 0, 0, 0]) }
    ]
    sceneFixture.manifest.model = { files: entries.map(({ name, data }) => ({ name, bytes: data.byteLength })), bytes: 12 }
    decodeAssets()
    vi.mocked(fetch).mockImplementation(async path => {
      const part = entries.find(entry => path === `./media/cinematic/${entry.name}`)
      return part ? new Response(part.data) : responseFor(path)
    })
    return entries
  }
  const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

  it('reassembles exact bytes once in manifest order, without sorting filenames or requesting a legacy GLB', async () => {
    const entries = chunks()
    const h = context()
    const live = await h.create()
    const expected = new Uint8Array(entries.flatMap(entry => Array.from(entry.data)))
    expect(new Uint8Array(mocks.parseAsync.mock.calls[0][0])).toEqual(expected)
    expect(mocks.parseAsync).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      './media/cinematic/scene.json', ...entries.map(entry => `./media/cinematic/${entry.name}`), './media/cinematic/station_test.bin', `./media/cinematic/${sceneFixture.manifest.background}`
    ])
    for (const [, options] of vi.mocked(fetch).mock.calls) {
      expect(options).toEqual({ signal: h.abort.signal, mode: 'same-origin', redirect: 'error' })
    }
    live.dispose()
  })

  it('does not request the next chunk until the preceding bytes are complete', async () => {
    const entries = chunks()
    const gate = deferred<ArrayBuffer>()
    const reading = vi.fn(() => gate.promise)
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? { ok: true, arrayBuffer: reading } as unknown as Response : normalFetch(path, options))
    const h = context()
    const loading = h.create()
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    gate.resolve(entries[0].data.buffer)
    const live = await loading
    expect(fetch).toHaveBeenCalledTimes(6)
    live.dispose()
  })

  it('checks optional per-chunk and whole-model SHA-256 digests before parsing', async () => {
    const entries = chunks()
    vi.stubGlobal('crypto', webcrypto)
    sceneFixture.manifest.model!.files.forEach((file, index) => { file.sha256 = sha256(entries[index].data).toUpperCase() })
    sceneFixture.manifest.model!.sha256 = sha256(new Uint8Array(entries.flatMap(entry => Array.from(entry.data))))
    const live = await context().create()
    expect(mocks.parseAsync).toHaveBeenCalledTimes(2)
    live.dispose()
  })

  it.each(['chunk', 'whole'])('rejects a %s digest mismatch without parsing or mounting', async stage => {
    chunks()
    vi.stubGlobal('crypto', webcrypto)
    if (stage === 'chunk') sceneFixture.manifest.model!.files[0].sha256 = '0'.repeat(64)
    else sceneFixture.manifest.model!.sha256 = '0'.repeat(64)
    const h = context()
    await expect(h.create()).rejects.toThrow('SHA-256 mismatch')
    expect(fetch).toHaveBeenCalledTimes(stage === 'chunk' ? 2 : 4)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('fails explicitly if an expected digest cannot be checked', async () => {
    chunks()
    vi.stubGlobal('crypto', undefined)
    sceneFixture.manifest.model!.sha256 = '0'.repeat(64)
    await expect(context().create()).rejects.toThrow('verification is unavailable')
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each([
    'https://example.com/model.bin', '//example.com/model.bin', '../model.bin', '..', '.',
    '/model.bin', 'nested/model.bin', 'nested\\model.bin', 'model.bin?token=1', 'model.bin#part',
    '%2e%2e%2fmodel.bin', 'x'.repeat(129)
  ])('rejects unsafe chunk name %s before downloading any chunk', async name => {
    chunks()
    sceneFixture.manifest.model!.files[1].name = name
    await expect(context().create()).rejects.toThrow('Invalid cinematic asset path')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each([
    ['empty files', { files: [], bytes: 1 }],
    ['too many files', { files: Array.from({ length: 129 }, (_, i) => ({ name: `part-${i}.bin`, bytes: 1 })), bytes: 129 }],
    ['zero total', { files: [{ name: 'a.bin', bytes: 1 }], bytes: 0 }],
    ['oversized total', { files: [{ name: 'a.bin', bytes: 1 }], bytes: 256 * 1024 * 1024 + 1 }],
    ['zero chunk', { files: [{ name: 'a.bin', bytes: 0 }], bytes: 1 }],
    ['negative chunk', { files: [{ name: 'a.bin', bytes: -1 }], bytes: 1 }],
    ['fractional chunk', { files: [{ name: 'a.bin', bytes: 1.5 }], bytes: 3 }],
    ['oversized chunk', { files: [{ name: 'a.bin', bytes: 20 * 1024 * 1024 + 1 }], bytes: 20 * 1024 * 1024 + 1 }],
    ['incorrect sum', { files: [{ name: 'a.bin', bytes: 1 }], bytes: 2 }],
    ['duplicate names', { files: [{ name: 'a.bin', bytes: 1 }, { name: 'a.bin', bytes: 1 }], bytes: 2 }],
    ['invalid chunk hash', { files: [{ name: 'a.bin', bytes: 1, sha256: 'oops' }], bytes: 1 }],
    ['invalid model hash', { files: [{ name: 'a.bin', bytes: 1 }], bytes: 1, sha256: 'oops' }]
  ])('rejects %s metadata before downloading any model bytes', async (_label, model) => {
    sceneFixture.manifest.model = model as LunarModelManifest
    await expect(context().create()).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('admits native-texture models up to 256 MiB while keeping each request at most 20 MiB', async () => {
    const bytes = 256 * 1024 * 1024
    const chunkBytes = 20 * 1024 * 1024
    sceneFixture.manifest.model = {
      bytes,
      files: Array.from({ length: Math.ceil(bytes / chunkBytes) }, (_, i) => ({
        name: `native-model-${i}.bin`, bytes: Math.min(chunkBytes, bytes - i * chunkBytes)
      }))
    }
    // Reaching the first fetch proves admission, without transferring 256 MiB in a unit test.
    vi.mocked(fetch).mockImplementation(async path => {
      if (path === './media/cinematic/native-model-0.bin') throw new Error('Admitted bounded native model')
      return responseFor(path)
    })
    await expect(context().create()).rejects.toThrow('Admitted bounded native model')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('rejects a correctly summed model one byte over 256 MiB before its first chunk', async () => {
    const bytes = 256 * 1024 * 1024 + 1
    const chunkBytes = 20 * 1024 * 1024
    sceneFixture.manifest.model = {
      bytes,
      files: Array.from({ length: Math.ceil(bytes / chunkBytes) }, (_, i) => ({
        name: `native-model-${i}.bin`, bytes: Math.min(chunkBytes, bytes - i * chunkBytes)
      }))
    }
    await expect(context().create()).rejects.toThrow('Invalid cinematic model size or file count')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('./media/cinematic/scene.json', expect.anything())
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each([2, 5])('rejects an actual %i-byte chunk when its declared length is four', async actualBytes => {
    const entries = chunks()
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? new Response(new Uint8Array(actualBytes)) : normalFetch(path, options))
    await expect(context().create()).rejects.toThrow('chunk byte length mismatch')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('cancels an overlong streamed response before allocating or reading the remaining body', async () => {
    const entries = chunks()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)) }, cancel })
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? new Response(stream) : normalFetch(path, options))
    await expect(context().create()).rejects.toThrow('chunk byte length mismatch')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it.each(['network', 'http', 'body'])('cleans up after a middle chunk %s failure without requesting later chunks', async failure => {
    const entries = chunks()
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => {
      if (path !== `./media/cinematic/${entries[1].name}`) return normalFetch(path, options)
      if (failure === 'network') throw new Error('chunk network failed')
      if (failure === 'http') return new Response(null, { status: 503 })
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('chunk body failed')) } }))
    })
    const h = context()
    await expect(h.create()).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('aborting a pending streamed chunk cancels its reader, disposes, and prevents subsequent downloads', async () => {
    const entries = chunks()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([103])) }, cancel })
    const normalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, options) => path === `./media/cinematic/${entries[0].name}`
      ? new Response(stream) : normalFetch(path, options))
    const h = context()
    const loading = h.create()
    const rejection = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(stream.locked).toBe(true), { interval: 1 })
    h.abort.abort()
    await rejection
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    expectRendererDisposed()
  })

  it('aborting while a chunk hash is pending prevents the next fetch and parse', async () => {
    const entries = chunks()
    const gate = deferred<ArrayBuffer>()
    const digest = vi.fn(() => gate.promise)
    vi.stubGlobal('crypto', { subtle: { digest } })
    sceneFixture.manifest.model!.files[0].sha256 = '0'.repeat(64)
    const h = context()
    const loading = h.create()
    const rejection = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(1), { interval: 1 })
    h.abort.abort()
    gate.resolve(new ArrayBuffer(32))
    await rejection
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expectRendererDisposed()
  })
})


import { sceneFixture, mocks, zero, decodeAssets, context, rendered, expectSourceDisposed, expectRendererDisposed } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('first-render GPU upload failures', () => {
  it('reports actual OUT_OF_MEMORY even after another GL error and restores both render passes', async () => {
    const decoded = decodeAssets()
    const live = await context().create()
    const renderer = mocks.renderers[0]
    live.resize(1920, 1080, 2)
    renderer.context.getError.mockReturnValueOnce(0x0502).mockReturnValueOnce(renderer.context.OUT_OF_MEMORY)
    expect(() => live.render(zero)).toThrow(LunarGpuMemoryError)
    const frame = rendered()
    expect(renderer.render).toHaveBeenCalledTimes(2)
    expect(frame.scene.background).toBeInstanceOf(THREE.Texture)
    expect(frame.camera.layers.mask).toBe(3)
    expect(renderer.autoClear).toBe(true)
    expect(renderer.context.getError).toHaveBeenCalledTimes(2)
    live.dispose()
    expectSourceDisposed(decoded.planet)
    expectSourceDisposed(decoded.station)
    expect(sceneFixture.backgroundImage.close).toHaveBeenCalledTimes(1)
    expectRendererDisposed()
  })

  it.each(['lost context', 'context error'])('rejects %s before a context-loss event can leave a blank live scene', async mode => {
    decodeAssets()
    const live = await context().create()
    const gl = mocks.renderers[0].context
    if (mode === 'lost context') gl.isContextLost.mockReturnValue(true)
    else gl.getError.mockReturnValueOnce(gl.CONTEXT_LOST_WEBGL)
    expect(() => live.render(zero)).toThrow('WebGL context lost during initial rendering')
    expect(gl.getError).toHaveBeenCalledTimes(mode === 'lost context' ? 0 : 1)
    live.dispose()
    expectRendererDisposed()
  })

  it('bounds a broken driver error queue and rejects rather than claiming a successful live render', async () => {
    decodeAssets()
    const live = await context().create()
    const gl = mocks.renderers[0].context
    gl.getError.mockReturnValue(0x0502)
    expect(() => live.render(zero)).toThrow('WebGL could not render the original scene')
    expect(gl.getError).toHaveBeenCalledTimes(8)
    live.dispose()
  })

  it('checks once only after both real passes, without polling during later frames', async () => {
    decodeAssets()
    const live = await context().create()
    const renderer = mocks.renderers[0]
    expect(renderer.context.getError).not.toHaveBeenCalled()
    renderer.context.getError.mockImplementation(() => {
      expect(renderer.render).toHaveBeenCalledTimes(2)
      return 0
    })
    live.render(zero)
    for (let i = 0; i < 30; i++) live.render({ yaw: i * .1, pitch: 0, orbit: i })
    expect(renderer.context.getError).toHaveBeenCalledTimes(1)
    expect(renderer.context.isContextLost).toHaveBeenCalledTimes(1)
    live.dispose()
  })
})


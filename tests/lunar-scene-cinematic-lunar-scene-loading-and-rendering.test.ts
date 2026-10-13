import { sceneFixture, Manifest, mocks, Bitmap, zero, deferred, responseFor, asset, localTransforms, decodeAssets, context, rendered } from './helpers/lunar-scene'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../src/station-motion'

describe('cinematic lunar scene loading and rendering', () => {
  it('mounts only after the manifest, both real model decodes and the background have completed', async () => {
    const a = asset(), b = asset('station')
    const h = context()
    const manifestGate = deferred<Manifest>()
    const planetGate = deferred<{ scene: THREE.Group }>()
    const stationGate = deferred<{ scene: THREE.Group }>()
    const bitmapGate = deferred<Bitmap>()
    vi.mocked(fetch).mockImplementation(async path => path === './media/cinematic/scene.json'
      ? { ok: true, json: () => manifestGate.promise } as Response : responseFor(path))
    mocks.parseAsync.mockReturnValueOnce(planetGate.promise).mockReturnValueOnce(stationGate.promise)
    vi.mocked(createImageBitmap).mockReturnValue(bitmapGate.promise as unknown as Promise<ImageBitmap>)
    const loading = h.create()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(mocks.parseAsync).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    manifestGate.resolve(sceneFixture.manifest)
    await vi.waitFor(() => expect(mocks.parseAsync).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createImageBitmap).not.toHaveBeenCalled()
    planetGate.resolve({ scene: a.group })
    await vi.waitFor(() => expect(mocks.parseAsync).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(h.host.appendChild).not.toHaveBeenCalled()
    stationGate.resolve({ scene: b.group })
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(h.host.appendChild).not.toHaveBeenCalled()
    bitmapGate.resolve(sceneFixture.backgroundImage)
    const live = await loading
    expect(vi.mocked(fetch).mock.calls).toEqual([
      ['./media/cinematic/scene.json', { signal: h.abort.signal, mode: 'same-origin', redirect: 'error' }],
      ['./media/cinematic/scene_assets.glb', { signal: h.abort.signal, mode: 'same-origin', redirect: 'error' }],
      ['./media/cinematic/station_test.bin', { signal: h.abort.signal, mode: 'same-origin', redirect: 'error' }],
      [`./media/cinematic/${sceneFixture.manifest.background}`, { signal: h.abort.signal, mode: 'same-origin', redirect: 'error' }]
    ])
    expect(mocks.parseAsync).toHaveBeenNthCalledWith(1, sceneFixture.glbData, './media/cinematic/')
    expect(mocks.parseAsync).toHaveBeenNthCalledWith(2, sceneFixture.stationData, './media/cinematic/')
    expect(createImageBitmap).toHaveBeenCalledWith(sceneFixture.backgroundBlob, { imageOrientation: 'flipY' })
    const renderer = mocks.renderers[0]
    expect(renderer.options).toEqual({ alpha: false, antialias: false, powerPreference: 'low-power' })
    expect(renderer.shadowMap.enabled).toBe(false)
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping)
    expect(renderer.toneMappingExposure).toBeCloseTo(2 ** sceneFixture.manifest.sourceRender.exposureEV)
    expect(renderer.setClearColor).toHaveBeenCalledWith(0x02040a, 1)
    expect(renderer.domElement.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true')
    expect(renderer.domElement.style).toEqual({ display: 'block', width: '100%', height: '100%' })
    expect(h.host.appendChild).toHaveBeenCalledExactlyOnceWith(renderer.domElement)
    expect(renderer.render).not.toHaveBeenCalled()
    live.dispose()
  })

  it('renders the authored planet and intact station with isolated light layers and no asteroid models', async () => {
    const { planet: a, station: b } = decodeAssets()
    const live = await context().create()
    live.render(zero)
    const { scene, root, planet, surface, stationSource, shells, camera } = rendered()
    expect(root.children).toHaveLength(2)
    expect(planet.position.toArray()).toEqual(sceneFixture.manifest.planet.position)
    expect(surface.name).toBe('Planet_Core')
    expect(surface.quaternion.toArray()).toEqual(sceneFixture.manifest.planet.quaternion)
    expect(surface.scale.toArray()).toEqual(sceneFixture.manifest.planet.scale)
    expect(surface.geometry).toBe(a.geometry)
    expect(surface.material).toBe(a.material)
    expect(stationSource).toBe(b.group)
    expect(localTransforms(b.group)).toEqual(b.transforms)
    expect(scene.getObjectByName('Rock_Decoy')).toBeUndefined()
    scene.traverse(object => {
      expect(object).not.toBeInstanceOf(THREE.InstancedMesh)
      if (object instanceof THREE.Mesh) {
        expect(object.castShadow).toBe(false)
        expect(object.receiveShadow).toBe(false)
      }
    })
    expect(surface.layers.mask).toBe(1)
    b.group.traverse(object => expect(object.layers.mask).toBe(2))
    expect(camera.layers.mask).toBe(3)
    expect(mocks.renderers[0].frames).toEqual([
      { layers: 1, background: scene.background, autoClear: true },
      { layers: 2, background: null, autoClear: false }
    ])
    expect(mocks.renderers[0].autoClear).toBe(true)
    expect(mocks.renderers[0].clearDepth).not.toHaveBeenCalled()
    expect((surface.material as THREE.Material).depthWrite).toBe(true)
    expect((surface.material as THREE.Material).depthTest).toBe(true)
    b.group.traverse(object => {
      if (object instanceof THREE.Mesh) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) expect(material.depthTest).toBe(true)
      }
    })
    for (const spec of sceneFixture.manifest.station.lights) {
      const light = scene.getObjectByName(spec.name) as THREE.DirectionalLight
      expect(light).toBeInstanceOf(THREE.DirectionalLight)
      expect(light.position.toArray()).toEqual(spec.position)
      expect(light.target.position.toArray()).toEqual(spec.target)
      expect(light.target.parent).toBe(scene)
      expect(light.color.toArray()).toEqual(spec.colorLinear)
      expect(light.intensity).toBe(spec.intensity)
      expect(light.layers.mask).toBe(2)
      expect(light.layers.test(surface.layers)).toBe(false)
      expect(light.layers.test(b.group.layers)).toBe(true)
    }
    const hemi = scene.getObjectByName('Station soft fill') as THREE.HemisphereLight
    expect(hemi).toBeInstanceOf(THREE.HemisphereLight)
    expect(hemi.color.toArray()).toEqual(sceneFixture.manifest.station.hemisphere!.skyColorLinear)
    expect(hemi.groundColor.toArray()).toEqual(sceneFixture.manifest.station.hemisphere!.groundColorLinear)
    expect(hemi.intensity).toBe(sceneFixture.manifest.station.hemisphere!.intensity)
    expect(hemi.layers.mask).toBe(2)
    expect(hemi.layers.test(surface.layers)).toBe(false)
    expect(shells).toHaveLength(2)
    expect(shells[0].geometry).toBe(shells[1].geometry)
    shells.forEach((shell, i) => {
      const layer = sceneFixture.manifest.atmosphere.layers[i]
      expect(shell.position.toArray()).toEqual(sceneFixture.manifest.atmosphere.center)
      expect(shell.scale.toArray()).toEqual([layer.radius, layer.radius, layer.radius])
      expect(shell.layers.mask).toBe(1)
      expect(shell.material.transparent).toBe(true)
      expect(shell.material.depthWrite).toBe(false)
      expect(shell.material.side).toBe(THREE.FrontSide)
      expect(shell.material.blending).toBe(THREE.NormalBlending)
      expect(shell.material.uniforms.power.value).toBe(layer.power)
      expect(shell.material.uniforms.opacity.value).toBe(layer.opacity)
      expect(shell.material.uniforms.ambient.value).toBe(sceneFixture.manifest.atmosphere.lightAmbient)
      expect(shell.material.uniforms.tint.value.toArray()).toEqual(layer.colorLinear.map(value => value * layer.emission))
    })
    const background = scene.background as THREE.Texture
    expect(background.image).toBe(sceneFixture.backgroundImage)
    expect(background.flipY).toBe(false)
    expect(background.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(background.version).toBe(1)
    const ambient = scene.children.find(object => object instanceof THREE.AmbientLight) as THREE.AmbientLight
    expect(ambient.intensity).toBe(sceneFixture.manifest.ambient.intensity)
    expect(ambient.color.toArray()).toEqual(sceneFixture.manifest.ambient.colorLinear)
    expect(ambient.layers.mask).toBe(1)
    for (const spec of sceneFixture.manifest.lights) {
      const light = scene.getObjectByName(spec.name) as THREE.DirectionalLight
      expect(light.position.toArray()).toEqual(spec.position)
      expect(light.target.position.toArray()).toEqual(spec.target)
      expect(light.target.parent).toBe(scene)
      expect(light.color.toArray()).toEqual(spec.colorLinear)
      expect(light.intensity).toBe(spec.realtimeDirectionalIntensity)
      expect(light.layers.mask).toBe(1)
      expect(light.layers.test(b.group.layers)).toBe(false)
    }
    expect(scene.children.some(object => object instanceof THREE.Sprite)).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes(sceneFixture.manifest.fallback))).toBe(false)
    live.dispose()
  })

  it('applies only named station material overrides and retains planet material values', async () => {
    const { planet: a, station: b } = decodeAssets()
    const originalPlanet = a.material.toJSON()
    sceneFixture.manifest.station.materialOverrides = [{ name: 'StationAlloy', metalness: .55, roughness: .43, colorLinear: [.4, .5, .6], emissiveIntensity: .7 }]
    const live = await context().create()
    expect(b.material.metalness).toBe(.55)
    expect(b.material.roughness).toBe(.43)
    expect(b.material.color.toArray()).toEqual([.4, .5, .6])
    expect(b.material.emissiveIntensity).toBe(.7)
    expect(a.material.toJSON()).toEqual(originalPlanet)
    live.dispose()
  })

  it('supports omitted station material overrides and hemisphere without changing original materials', async () => {
    const { station: b } = decodeAssets()
    delete sceneFixture.manifest.station.materialOverrides
    delete sceneFixture.manifest.station.hemisphere
    const original = b.material.toJSON()
    const live = await context().create()
    live.render(zero)
    expect(b.material.toJSON()).toEqual(original)
    expect(rendered().scene.getObjectByName('Station soft fill')).toBeUndefined()
    live.dispose()
  })

  it.each([1, 2])('restores background, camera layers and autoClear if render pass %i throws', async failingPass => {
    decodeAssets()
    const live = await context().create()
    live.render(zero)
    const { renderer, scene, camera } = rendered()
    const background = scene.background
    renderer.autoClear = false
    if (failingPass === 2) renderer.render.mockImplementationOnce(() => {})
    renderer.render.mockImplementationOnce(() => { throw new Error('GPU render failure') })
    expect(() => live.render(zero)).toThrow('GPU render failure')
    expect(scene.background).toBe(background)
    expect(camera.layers.mask).toBe(3)
    expect(renderer.autoClear).toBe(false)
    live.render(zero)
    expect(renderer.frames.slice(-2)).toEqual([
      { layers: 1, background, autoClear: true },
      { layers: 2, background: null, autoClear: false }
    ])
    live.dispose()
  })

  it('keeps rigid station motion independent of planet drag and restores the exact initial pose', async () => {
    const { station: b } = decodeAssets()
    const live = await context().create()
    live.render(zero)
    const { planet, stationSource, root } = rendered()
    const initial = stationSource.matrixWorld.clone()
    live.render({ yaw: .7, pitch: -.2, orbit: 0 })
    root.updateMatrixWorld(true)
    expect(planet.rotation.y).toBe(.7)
    expect(planet.rotation.x).toBe(-.2)
    expect(stationSource.matrixWorld.elements).toEqual(initial.elements)
    const planetRotation = planet.quaternion.clone()
    live.render({ yaw: .7, pitch: -.2, orbit: 5 * .24 })
    root.updateMatrixWorld(true)
    const moving = stationSource.matrixWorld.clone()
    expect(moving.elements).not.toEqual(initial.elements)
    live.render({ yaw: 1.2, pitch: .4, orbit: 5 * .24 })
    root.updateMatrixWorld(true)
    expect(stationSource.matrixWorld.elements).toEqual(moving.elements)
    live.render({ yaw: .7, pitch: -.2, orbit: 12 * .24 })
    root.updateMatrixWorld(true)
    expect(stationSource.matrixWorld.elements).not.toEqual(moving.elements)
    expect(planet.quaternion.toArray()).toEqual(planetRotation.toArray())
    expect(localTransforms(stationSource)).toEqual(b.transforms)
    live.render(zero)
    root.updateMatrixWorld(true)
    expect(stationSource.matrixWorld.elements).toEqual(initial.elements)
    expect(planet.quaternion.toArray()).toEqual([0, 0, 0, 1])
    live.dispose()
  })

  it('uses the authored perspective view and preserves horizontal framing on portrait screens', async () => {
    decodeAssets()
    const live = await context().create()
    live.render(zero)
    const { camera, renderer } = rendered()
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera)
    expect(camera.position.toArray()).toEqual(sceneFixture.manifest.camera.position)
    expect(camera.near).toBe(sceneFixture.manifest.camera.near)
    expect(camera.far).toBe(sceneFixture.manifest.camera.far)
    expect(camera.fov).toBe(sceneFixture.manifest.camera.fov)
    expect(camera.aspect).toBe(sceneFixture.manifest.camera.referenceAspect)
    const expectedDirection = new THREE.Vector3().fromArray(sceneFixture.manifest.camera.target).sub(camera.position).normalize()
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(expectedDirection)).toBeLessThan(1e-10)
    live.resize(1200, 800, .5)
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1)
    expect(renderer.setSize).toHaveBeenLastCalledWith(600, 400, false)
    expect(camera.aspect).toBe(1.5)
    expect(camera.fov).toBe(sceneFixture.manifest.camera.fov)
    const wideProjection = camera.projectionMatrix.clone()
    live.resize(154, 206, 1)
    expect(camera.aspect).toBeCloseTo(154 / 206)
    expect(camera.fov).toBeGreaterThan(sceneFixture.manifest.camera.fov)
    const horizontalFrustum = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect
    expect(horizontalFrustum).toBeCloseTo(Math.tan(THREE.MathUtils.degToRad(sceneFixture.manifest.camera.fov) / 2) * sceneFixture.manifest.camera.referenceAspect, 12)
    expect(camera.projectionMatrix.elements).not.toEqual(wideProjection.elements)
    live.resize(0, 0, 1)
    expect(camera.aspect).toBe(1)
    expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true)
    // Resize must not start a second rendering loop or render a stale pose.
    expect(renderer.render).toHaveBeenCalledTimes(2)
    live.dispose()
  })

  it('leaves the base field of view unchanged at and above the reference aspect', () => {
    expect(cinematicFov(32, 4 / 3, 4 / 3)).toBeCloseTo(32)
    expect(cinematicFov(32, 4 / 3, 2)).toBeCloseTo(32)
    expect(cinematicFov(32, 4 / 3, .5)).toBeGreaterThan(32)
  })
})


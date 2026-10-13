import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cinematicFov, createLunarScene, type LunarModelManifest } from '../../src/lunar-scene'
import { lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError } from '../../src/lunar-controller'
import { defaultLunarView, zoomLunarView } from '../../src/lunar-view'
import type { PlanetStationMotionManifest, PlanetStationVector3 } from '../../src/station-motion'

export type Manifest = PlanetStationMotionManifest & {
  station: PlanetStationMotionManifest['station'] & {
    model: LunarModelManifest
    lights: Array<{ name: string; position: PlanetStationVector3; target: PlanetStationVector3; colorLinear: PlanetStationVector3; intensity: number }>
    hemisphere?: { skyColorLinear: PlanetStationVector3; groundColorLinear: PlanetStationVector3; intensity: number; position: PlanetStationVector3 }
    materialOverrides?: Array<{ name: string; metalness?: number; roughness?: number; colorLinear?: PlanetStationVector3; emissiveIntensity?: number }>
  }
  camera: { position: PlanetStationVector3; target: PlanetStationVector3; fov: number; near: number; far: number; referenceAspect: number }
  lights: Array<{ name: string; position: PlanetStationVector3; target: PlanetStationVector3; colorLinear: PlanetStationVector3; realtimeDirectionalIntensity: number }>
  ambient: { colorLinear: PlanetStationVector3; intensity: number }
  atmosphere: { center: PlanetStationVector3; lightDirection: PlanetStationVector3; lightAmbient: number; layers: Array<{ radius: number; power: number; opacity: number; colorLinear: PlanetStationVector3; emission: number }> }
  sourceRender: { exposureEV: number }
  background: string
  fallback: string
  model?: LunarModelManifest
  textureSource?: { dimensions: [number, number] }
}

export class Canvas extends EventTarget {
  style = {}
  width = 300
  height = 150
  setAttribute = vi.fn()
  remove = vi.fn()
}

export type GLContext = {
  MAX_TEXTURE_SIZE: number
  MAX_RENDERBUFFER_SIZE: number
  MAX_VIEWPORT_DIMS: number
  NO_ERROR: number
  OUT_OF_MEMORY: number
  CONTEXT_LOST_WEBGL: number
  drawingBufferWidth: number
  drawingBufferHeight: number
  getParameter: ReturnType<typeof vi.fn>
  getError: ReturnType<typeof vi.fn>
  isContextLost: ReturnType<typeof vi.fn>
}

export type Renderer = {
  domElement: Canvas
  context: GLContext
  getContext: ReturnType<typeof vi.fn>
  options: Record<string, unknown>
  shadowMap: { enabled: boolean }
  outputColorSpace: string
  toneMapping: number
  toneMappingExposure: number
  autoClear: boolean
  frames: Array<{ layers: number; background: THREE.Scene['background']; autoClear: boolean }>
  setClearColor: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  clearDepth: ReturnType<typeof vi.fn>
  setPixelRatio: ReturnType<typeof vi.fn>
  setSize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  forceContextLoss: ReturnType<typeof vi.fn>
}
export const mocks = vi.hoisted(() => ({
  renderers: [] as Renderer[], parseAsync: vi.fn(),
  limits: { texture: 16384, renderbuffer: 16384, viewport: [16384, 16384] as number[] },
  driverScale: 1
}))

// Only WebGL and GLB decoding are mocked. Scene graph, camera, shaders, resource events and all motion math use the real Three.js classes.
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = new Canvas()
      context: GLContext = {
        MAX_TEXTURE_SIZE: 0x0d33, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_VIEWPORT_DIMS: 0x0d3a,
        NO_ERROR: 0, OUT_OF_MEMORY: 0x0505, CONTEXT_LOST_WEBGL: 0x9242,
        drawingBufferWidth: 300, drawingBufferHeight: 150,
        getError: vi.fn(() => 0),
        isContextLost: vi.fn(() => false),
        getParameter: vi.fn((parameter: number) => {
          if (parameter === 0x0d33) return mocks.limits.texture
          if (parameter === 0x84e8) return mocks.limits.renderbuffer
          if (parameter === 0x0d3a) return mocks.limits.viewport
          throw new Error('Unexpected GL capability query')
        })
      }
      getContext = vi.fn(() => this.context)
      shadowMap = { enabled: true }
      outputColorSpace = ''
      toneMapping = 0
      toneMappingExposure = 1
      setClearColor = vi.fn()
      clearDepth = vi.fn()
      autoClear = true
      frames: Array<{ layers: number; background: THREE.Scene['background']; autoClear: boolean }> = []
      render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {
        this.frames.push({ layers: camera.layers.mask, background: scene.background, autoClear: this.autoClear })
      })
      setPixelRatio = vi.fn()
      setSize = vi.fn((width: number, height: number) => {
        this.domElement.width = width
        this.domElement.height = height
        this.context.drawingBufferWidth = Math.floor(width * mocks.driverScale)
        this.context.drawingBufferHeight = Math.floor(height * mocks.driverScale)
      })
      dispose = vi.fn()
      forceContextLoss = vi.fn()
      constructor(public options: Record<string, unknown>) {
        mocks.renderers.push(this)
      }
    }
  }
})
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { parseAsync = mocks.parseAsync }
}))

export class Bitmap {
  width = 16
  height = 16
  close = vi.fn()
}

export const authoredManifest = JSON.parse(readFileSync('public/media/cinematic/scene.json', 'utf8')) as Manifest
export const zero = { yaw: 0, pitch: 0, orbit: 0 }

export const sceneFixture = {} as { manifest: Manifest; glbData: ArrayBuffer; stationData: ArrayBuffer; backgroundBlob: Blob; backgroundImage: Bitmap }

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

export function responseFor(path: unknown): Response {
  if (path === './media/cinematic/scene.json') return { ok: true, json: async () => sceneFixture.manifest } as Response
  if (path === './media/cinematic/scene_assets.glb') return { ok: true, arrayBuffer: async () => sceneFixture.glbData } as Response
  if (path === './media/cinematic/station_test.bin') return new Response(sceneFixture.stationData)
  if (path === `./media/cinematic/${authoredManifest.background}`) return { ok: true, blob: async () => sceneFixture.backgroundBlob } as Response
  throw new Error(`Unexpected asset request: ${String(path)}`)
}

export function asset(kind: 'planet' | 'station' = 'planet') {
  const group = new THREE.Group()
  group.name = kind === 'station' ? 'StationFixture' : 'PlanetSource'
  const image = new Bitmap()
  if (kind === 'planet' && sceneFixture.manifest.textureSource) {
    ;[image.width, image.height] = sceneFixture.manifest.textureSource.dimensions
  }
  const texture = new THREE.Texture(image)
  const secondTexture = new THREE.Texture(image)
  const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture, aoMap: secondTexture })
  material.name = kind === 'station' ? 'StationAlloy' : 'PlanetClouds'
  const geometry = new THREE.SphereGeometry(1, 8, 4)
  const names = kind === 'planet' ? ['Planet_Core', 'Rock_Decoy'] : ['StationHull', 'StationAnnulus']
  const pivot = new THREE.Group()
  pivot.name = 'AnnularFixturePivot'
  pivot.position.set(1, 2, 3)
  if (kind === 'station') group.add(pivot)
  for (const [index, name] of names.entries()) {
    // One-element material arrays exercise GLTF's alternate material shape.
    const mesh = new THREE.Mesh(geometry, index % 2 ? [material] : material)
    mesh.name = name
    mesh.position.set(100 + index, 200 + index, 300 + index)
    mesh.rotation.set(.2, .4, .6)
    mesh.scale.set(2, 3, 4)
    mesh.castShadow = mesh.receiveShadow = kind === 'station'
    ;(kind === 'station' && index === 1 ? pivot : group).add(mesh)
  }
  group.updateMatrixWorld(true)
  const transforms = localTransforms(group)
  const spies = {
    geometry: vi.spyOn(geometry, 'dispose'), material: vi.spyOn(material, 'dispose'),
    texture: vi.spyOn(texture, 'dispose'), secondTexture: vi.spyOn(secondTexture, 'dispose')
  }
  return { group, image, texture, secondTexture, material, geometry, transforms, spies }
}

export function localTransforms(root: THREE.Object3D) {
  const transforms: Record<string, number[]> = {}
  root.traverse(object => {
    object.updateMatrix()
    transforms[object.name] = [...object.matrix.elements]
  })
  return transforms
}

export function decodeAssets(planet = asset(), station = asset('station')) {
  mocks.parseAsync.mockReset()
    .mockResolvedValueOnce({ scene: planet.group })
    .mockResolvedValueOnce({ scene: station.group })
  return { planet, station }
}

export function context() {
  const host = { appendChild: vi.fn() }
  const abort = new AbortController()
  const lost = vi.fn()
  return { host, abort, lost, create: () => createLunarScene(host as unknown as HTMLElement, abort.signal, lost) }
}

export function rendered() {
  const renderer = mocks.renderers[0]
  const call = renderer.render.mock.lastCall!
  const scene = call[0] as THREE.Scene
  const camera = call[1] as THREE.PerspectiveCamera
  const surface = scene.getObjectByName('Planet_Core') as THREE.Mesh
  const planet = surface.parent as THREE.Group
  const root = planet.parent as THREE.Group
  const stationSource = scene.getObjectByName('StationFixture') as THREE.Group
  const station = stationSource.parent as THREE.Group
  const shells = scene.children.filter((object): object is THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> => object.name === 'ThinAtmosphericLimb')
  scene.updateMatrixWorld(true)
  return { renderer, scene, camera, root, planet, surface, station, stationSource, shells }
}

export function expectSourceDisposed(a: ReturnType<typeof asset>) {
  for (const spy of Object.values(a.spies)) expect(spy).toHaveBeenCalledTimes(1)
  expect(a.image.close).toHaveBeenCalledTimes(1)
}

export function expectRendererDisposed() {
  const renderer = mocks.renderers[0]
  expect(renderer.dispose).toHaveBeenCalledTimes(1)
  expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1)
  expect(renderer.domElement.remove).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  sceneFixture.manifest = structuredClone(authoredManifest)
  // Mocked GLB bytes exercise legacy loading by default; chunk tests set their own payload.
  delete sceneFixture.manifest.model
  sceneFixture.glbData = new ArrayBuffer(8)
  sceneFixture.stationData = new Uint8Array([83, 84, 65, 84]).buffer
  sceneFixture.manifest.station = {
    position: [5.1, -2.65, 3.5], quaternion: [0, 0, 0, 1], scale: [.012, .012, .012],
    motion: { spinAxis: [0, 1, 0], spinRadiansPerSecond: .018, driftAmplitude: [.08, .05, .05], driftRadiansPerSecond: .04 },
    model: { files: [{ name: 'station_test.bin', bytes: 4 }], bytes: 4 },
    lights: [{ name: 'station-key', position: [7, 8, 12], target: [5.1, -2.65, 3.5], colorLinear: [1, .94, .84], intensity: 2.6 }],
    hemisphere: { skyColorLinear: [.7, .8, 1], groundColorLinear: [.18, .21, .28], intensity: .65, position: [0, 1, 0] }
  }
  sceneFixture.backgroundBlob = new Blob(['background'])
  sceneFixture.backgroundImage = new Bitmap()
  mocks.renderers.length = 0
  mocks.limits = { texture: 16384, renderbuffer: 16384, viewport: [16384, 16384] }
  mocks.driverScale = 1
  mocks.parseAsync.mockReset()
  vi.stubGlobal('ImageBitmap', Bitmap)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => sceneFixture.backgroundImage))
  vi.stubGlobal('fetch', vi.fn(async path => responseFor(path)))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})


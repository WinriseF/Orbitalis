import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createPlanetStationMotion, type PlanetStationMotion, type PlanetStationMotionManifest, type PlanetStationQuaternion, type PlanetStationVector3 as CinematicVector3 } from './station-motion'
import { LunarGpuMemoryError, LunarTextureLimitError } from './lunar-controller'
import { clampLunarView, defaultLunarView, type LunarView } from './lunar-view'
import { createStationDrag, type LunarStationDrag } from './station-drag'

export type LunarPose = {
  yaw: number
  pitch: number
  orbit: number
  stationOrbit?: number
  /** World rotation of the circular station orbit and inward-facing frame. */
  stationFrame?: PlanetStationQuaternion
}
export type LunarResolution = {
  width: number
  height: number
  requestedWidth: number
  requestedHeight: number
  limited: boolean
}
export type LunarScene = {
  stationDrag?: LunarStationDrag
  render: (pose: LunarPose, view?: LunarView) => void
  resize: (width: number, height: number, pixelRatio: number) => LunarResolution | void
  dispose: () => void
}
export type LunarModelManifest = { files: Array<{ name: string; bytes: number; sha256?: string }>; bytes: number; sha256?: string }
interface SceneManifest extends PlanetStationMotionManifest {
  station: PlanetStationMotionManifest['station'] & {
    model: LunarModelManifest
    lights: Array<{ name: string; position: CinematicVector3; target: CinematicVector3; colorLinear: CinematicVector3; intensity: number }>
    hemisphere?: { skyColorLinear: CinematicVector3; groundColorLinear: CinematicVector3; intensity: number; position: CinematicVector3 }
    materialOverrides?: Array<{ name: string; metalness?: number; roughness?: number; colorLinear?: CinematicVector3; emissiveIntensity?: number }>
  }
  camera: { position: CinematicVector3; target: CinematicVector3; fov: number; near: number; far: number; referenceAspect: number }
  lights: Array<{ name: string; position: CinematicVector3; target: CinematicVector3; colorLinear: CinematicVector3; realtimeDirectionalIntensity: number }>
  ambient: { colorLinear: CinematicVector3; intensity: number }
  atmosphere: { center: CinematicVector3; lightDirection: CinematicVector3; lightAmbient: number; layers: Array<{ radius: number; power: number; opacity: number; colorLinear: CinematicVector3; emission: number }> }
  sourceRender: { exposureEV: number }
  background: string
  model?: LunarModelManifest
  textureSource?: { dimensions: [number, number] }
}
const BASE = './media/cinematic/'
const MAX_CHUNK_BYTES = 20 * 1024 * 1024
const MAX_MODEL_BYTES = 256 * 1024 * 1024
const MAX_MODEL_FILES = 128

function validateAssetName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || name.includes('..')) {
    throw new Error('Invalid cinematic asset path')
  }
}

function validateDigest(value: unknown) {
  if (value !== undefined && (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value))) {
    throw new Error('Invalid cinematic model SHA-256')
  }
}

async function verifyDigest(bytes: Uint8Array<ArrayBuffer>, expected: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!expected) return
  if (!globalThis.crypto?.subtle) throw new Error('Cinematic model SHA-256 verification is unavailable')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  signal.throwIfAborted()
  if (Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== expected.toLowerCase()) {
    throw new Error('Cinematic model SHA-256 mismatch')
  }
}

/** Bound each response while streaming, including servers that omit Content-Length. */
async function readChunk(response: Response, bytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer())
    signal.throwIfAborted()
    if (data.byteLength !== bytes) throw new Error('Cinematic model chunk byte length mismatch')
    return data
  }
  const output = new Uint8Array(bytes)
  const reader = response.body.getReader()
  let offset = 0
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      if (value.byteLength > bytes - offset) throw new Error('Cinematic model chunk byte length mismatch')
      output.set(value, offset)
      offset += value.byteLength
    }
    if (offset !== bytes) throw new Error('Cinematic model chunk byte length mismatch')
    return output
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

async function readModel(model: LunarModelManifest | undefined, read: (name: string) => Promise<Response>, signal: AbortSignal) {
  if (model === undefined) return (await read('scene_assets.glb')).arrayBuffer()
  if (!model || !Number.isSafeInteger(model.bytes) || model.bytes < 1 || model.bytes > MAX_MODEL_BYTES ||
      !Array.isArray(model.files) || model.files.length < 1 || model.files.length > MAX_MODEL_FILES) {
    throw new Error('Invalid cinematic model size or file count')
  }
  validateDigest(model.sha256)
  let total = 0
  const names = new Set<string>()
  for (const file of model.files) {
    if (!file) throw new Error('Invalid cinematic model file')
    validateAssetName(file.name)
    if (names.has(file.name)) throw new Error('Duplicate cinematic model chunk')
    names.add(file.name)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_CHUNK_BYTES) {
      throw new Error('Invalid cinematic model chunk size')
    }
    validateDigest(file.sha256)
    total += file.bytes
  }
  if (total !== model.bytes) throw new Error('Cinematic model total byte length mismatch')
  signal.throwIfAborted()
  // One exact-size assembly buffer, one bounded chunk in flight, manifest order.
  const output = new Uint8Array(total)
  let offset = 0
  for (const file of model.files) {
    const data = await readChunk(await read(file.name), file.bytes, signal)
    await verifyDigest(data, file.sha256, signal)
    output.set(data, offset)
    offset += data.byteLength
  }
  await verifyDigest(output, model.sha256, signal)
  return output.buffer
}

function verifyTextureLimit(source: SceneManifest['textureSource'], textureLimit: number) {
  if (source === undefined) return
  const dimensions = source?.dimensions
  if (!Array.isArray(dimensions) || dimensions.length !== 2 || dimensions.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Invalid original texture dimensions')
  }
  if (dimensions[0] > textureLimit || dimensions[1] > textureLimit) {
    throw new LunarTextureLimitError(dimensions[0], dimensions[1], textureLimit)
  }
}

function verifyDecodedPlanetTexture(planet: THREE.Mesh, source: SceneManifest['textureSource']) {
  if (source === undefined) return
  // GLTFLoader can swallow image decoding failures and leave a null material map.
  // Require the actual native image, never an untextured or downsized substitute.
  for (const material of Array.isArray(planet.material) ? planet.material : [planet.material]) {
    const image = material instanceof THREE.MeshStandardMaterial ? material.map?.image : undefined
    if (!image || typeof image !== 'object' || !('width' in image) || !('height' in image) ||
        image.width !== source.dimensions[0] || image.height !== source.dimensions[1]) {
      throw new Error('Original planet texture did not decode at its native dimensions')
    }
  }
}

function verifyInitialGpuUpload(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  if (gl.isContextLost()) throw new Error('WebGL context lost during initial rendering')
  let failed = false
  // Three.js does not throw for GL allocation errors. Check after the first real
  // upload/render only, with a hard bound even if a driver keeps returning errors.
  for (let i = 0; i < 8; i++) {
    const error = gl.getError()
    if (error === gl.NO_ERROR) break
    if (error === gl.OUT_OF_MEMORY) throw new LunarGpuMemoryError()
    if (error === gl.CONTEXT_LOST_WEBGL) throw new Error('WebGL context lost during initial rendering')
    failed = true
  }
  if (failed) throw new Error('WebGL could not render the original scene')
}

/** Retain horizontal framing on portrait displays, and vertical framing on wide displays. */
export function cinematicFov(baseFov: number, referenceAspect: number, aspect: number) {
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) * Math.max(1, referenceAspect / aspect)))
}

function addAtmosphere(scene: THREE.Scene, atmosphere: SceneManifest['atmosphere']) {
  const geometry = new THREE.SphereGeometry(1, 96, 48)
  for (const layer of atmosphere.layers) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tint: { value: new THREE.Color().fromArray(layer.colorLinear).multiplyScalar(layer.emission) },
        power: { value: layer.power }, opacity: { value: layer.opacity },
        sunDirection: { value: new THREE.Vector3().fromArray(atmosphere.lightDirection).normalize() },
        ambient: { value: atmosphere.lightAmbient }
      },
      vertexShader: `varying vec3 worldNormal; varying vec3 worldPosition;
        void main(){ vec4 world = modelMatrix * vec4(position, 1.0); worldPosition = world.xyz;
        worldNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * world; }`,
      fragmentShader: `uniform vec3 tint; uniform float power; uniform float opacity;
        uniform vec3 sunDirection; uniform float ambient; varying vec3 worldNormal; varying vec3 worldPosition;
        void main(){ vec3 n = normalize(worldNormal); vec3 v = normalize(cameraPosition - worldPosition);
          float rim = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), power);
          float light = max(dot(n, sunDirection), 0.0) + ambient;
          gl_FragColor = vec4(tint, clamp(rim * opacity * light, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
      blending: THREE.NormalBlending
    })
    const shell = new THREE.Mesh(geometry, material)
    shell.name = 'ThinAtmosphericLimb'
    shell.position.fromArray(atmosphere.center)
    shell.scale.setScalar(layer.radius)
    scene.add(shell)
  }
}

/** Lazy-loaded real 3D. The approved poster is never composited over the live planet. */
export async function createLunarScene(host: HTMLElement, signal: AbortSignal, onContextLost: () => void): Promise<LunarScene> {
  const renderer = new THREE.WebGLRenderer({ alpha: false, antialias: false, powerPreference: 'low-power' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.shadowMap.enabled = false
  renderer.setClearColor(0x02040a, 1)
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' })
  const scene = new THREE.Scene()
  let sourceRoot: THREE.Object3D | null = null
  let stationRoot: THREE.Object3D | null = null
  let background: THREE.Texture | null = null
  let motion: PlanetStationMotion | null = null
  let stationDrag: LunarStationDrag | undefined
  let disposed = false
  const contextLost = (event: Event) => {
    event.preventDefault()
    if (!disposed) onContextLost()
  }
  canvas.addEventListener('webglcontextlost', contextLost)
  const dispose = () => {
    if (disposed) return
    disposed = true
    canvas.removeEventListener('webglcontextlost', contextLost)
    stationDrag?.end()
    motion?.dispose()
    const resources = new Set<{ dispose: () => void }>()
    const images = new Set<ImageBitmap>()
    const texture = (value: THREE.Texture) => {
      resources.add(value)
      if (typeof ImageBitmap !== 'undefined' && value.image instanceof ImageBitmap) images.add(value.image)
    }
    if (background) texture(background)
    for (const root of [sourceRoot, stationRoot, scene]) root?.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      resources.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        resources.add(material)
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) texture(value)
      }
    })
    resources.forEach(resource => resource.dispose())
    images.forEach(image => image.close())
    renderer.dispose()
    renderer.forceContextLoss()
    canvas.remove()
  }
  const read = async (name: string) => {
    // Assets are same-origin, fixed manifest filenames. Do not follow arbitrary URLs.
    signal.throwIfAborted()
    validateAssetName(name)
    const response = await fetch(BASE + name, { signal, mode: 'same-origin', redirect: 'error' })
    if (!response.ok) throw new Error(`Cinematic asset HTTP ${response.status}`)
    signal.throwIfAborted()
    return response
  }
  try {
    signal.throwIfAborted()
    // Cache hardware limits once. Animation frames never query GL capabilities.
    const gl = renderer.getContext()
    const textureLimit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))
    const renderbufferLimit = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
    const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null
    const maxWidth = Math.floor(Math.min(textureLimit, renderbufferLimit, viewportLimit?.[0] ?? Infinity))
    const maxHeight = Math.floor(Math.min(textureLimit, renderbufferLimit, viewportLimit?.[1] ?? Infinity))
    if (!Number.isSafeInteger(textureLimit) || !Number.isFinite(maxWidth) || !Number.isFinite(maxHeight) || maxWidth < 1 || maxHeight < 1) {
      throw new Error('Unable to verify WebGL drawing-buffer limits')
    }
    const manifest: SceneManifest = await (await read('scene.json')).json()
    signal.throwIfAborted()
    // Prevent Three.js from silently downsizing the original texture on upload.
    verifyTextureLimit(manifest.textureSource, textureLimit)
    const data = await readModel(manifest.model, read, signal)
    signal.throwIfAborted()
    const gltf = await new GLTFLoader().parseAsync(data, BASE)
    sourceRoot = gltf.scene
    signal.throwIfAborted()
    const planet = sourceRoot.getObjectByName(manifest.planet.prototype)
    if (!(planet instanceof THREE.Mesh)) throw new Error('Missing planet geometry')
    verifyDecodedPlanetTexture(planet, manifest.textureSource)
    planet.castShadow = planet.receiveShadow = false
    if (!manifest.station?.model) throw new Error('Missing station model')
    const stationData = await readModel(manifest.station.model, read, signal)
    const stationGltf = await new GLTFLoader().parseAsync(stationData, BASE)
    stationRoot = stationGltf.scene
    signal.throwIfAborted()
    // Dedicated light layer keeps improved metal visibility from changing the planet.
    stationRoot.traverse(object => {
      object.layers.set(1)
      if (!(object instanceof THREE.Mesh)) return
      object.castShadow = object.receiveShadow = false
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue
        const override = manifest.station.materialOverrides?.find(spec => spec.name === material.name)
        if (!override) continue
        if (override.metalness !== undefined) material.metalness = override.metalness
        if (override.roughness !== undefined) material.roughness = override.roughness
        if (override.colorLinear) material.color.fromArray(override.colorLinear)
        if (override.emissiveIntensity !== undefined) material.emissiveIntensity = override.emissiveIntensity
      }
    })
    motion = createPlanetStationMotion(manifest, planet, stationRoot)
    scene.add(motion.root)
    for (const spec of manifest.station.lights) {
      const light = new THREE.DirectionalLight(new THREE.Color().fromArray(spec.colorLinear), spec.intensity)
      light.name = spec.name
      light.position.fromArray(spec.position)
      light.target.position.fromArray(spec.target)
      light.layers.set(1)
      scene.add(light, light.target)
    }
    const hemi = manifest.station.hemisphere
    if (hemi) {
      const light = new THREE.HemisphereLight(new THREE.Color().fromArray(hemi.skyColorLinear), new THREE.Color().fromArray(hemi.groundColorLinear), hemi.intensity)
      light.name = 'Station soft fill'
      light.position.fromArray(hemi.position)
      light.layers.set(1)
      scene.add(light)
    }
    addAtmosphere(scene, manifest.atmosphere)
    const bitmap = await createImageBitmap(await (await read(manifest.background)).blob(), { imageOrientation: 'flipY' })
    background = new THREE.Texture(bitmap)
    background.flipY = false
    background.colorSpace = THREE.SRGBColorSpace
    background.needsUpdate = true
    scene.background = background
    signal.throwIfAborted()
    renderer.toneMappingExposure = 2 ** manifest.sourceRender.exposureEV
    scene.add(new THREE.AmbientLight(new THREE.Color().fromArray(manifest.ambient.colorLinear), manifest.ambient.intensity))
    for (const spec of manifest.lights) {
      const light = new THREE.DirectionalLight(new THREE.Color().fromArray(spec.colorLinear), spec.realtimeDirectionalIntensity)
      light.name = spec.name
      light.position.fromArray(spec.position)
      light.target.position.fromArray(spec.target)
      scene.add(light, light.target)
    }
    const camera = new THREE.PerspectiveCamera(manifest.camera.fov, manifest.camera.referenceAspect, manifest.camera.near, manifest.camera.far)
    camera.layers.enable(1)
    camera.position.fromArray(manifest.camera.position)
    camera.lookAt(new THREE.Vector3().fromArray(manifest.camera.target))
    let viewportWidth = manifest.camera.referenceAspect
    let viewportHeight = 1
    let initialUploadChecked = false
    let view = defaultLunarView()
    const projectView = () => {
      camera.zoom = view.zoom
      // Full and sub-view dimensions share the real viewport aspect. This shifts
      // the projection only: the camera never moves into planet/station geometry.
      camera.setViewOffset(viewportWidth, viewportHeight,
        -view.panX * viewportWidth, -view.panY * viewportHeight,
        viewportWidth, viewportHeight)
    }
    const prepare = (pose: LunarPose, nextView: LunarView) => {
      if (disposed) return
      if (nextView.zoom !== view.zoom || nextView.panX !== view.panX || nextView.panY !== view.panY) {
        view = clampLunarView(nextView)
        projectView()
      }
      motion!.apply(pose)
    }
    stationDrag = createStationDrag({
      manifest, motion, camera, prepare,
      viewport: () => ({ width: viewportWidth, height: viewportHeight })
    })
    host.appendChild(canvas)
    return {
      stationDrag,
      render(pose, nextView = view) {
        if (disposed) return
        prepare(pose, nextView)
        // WebGLRenderer selects lights by camera layers, not each mesh's layer.
        // Two depth-preserving passes keep station fill from washing out the planet.
        const previousAutoClear = renderer.autoClear
        const previousBackground = scene.background
        try {
          camera.layers.set(0)
          renderer.autoClear = true
          renderer.render(scene, camera)
          camera.layers.set(1)
          renderer.autoClear = false
          scene.background = null
          renderer.render(scene, camera)
          if (!initialUploadChecked) {
            initialUploadChecked = true
            verifyInitialGpuUpload(gl)
          }
        } finally {
          camera.layers.set(0)
          camera.layers.enable(1)
          renderer.autoClear = previousAutoClear
          scene.background = previousBackground
        }
      },
      resize(width, height, pixelRatio) {
        if (disposed) return
        const aspect = Math.max(width, 1) / Math.max(height, 1)
        const requestedWidth = Math.max(1, Math.round(Math.max(width, 1) * pixelRatio))
        const requestedHeight = Math.max(1, Math.round(Math.max(height, 1) * pixelRatio))
        const scale = Math.min(1, maxWidth / requestedWidth, maxHeight / requestedHeight)
        const bufferWidth = Math.max(1, Math.floor(requestedWidth * scale))
        const bufferHeight = Math.max(1, Math.floor(requestedHeight * scale))
        viewportWidth = Math.max(width, 1)
        viewportHeight = Math.max(height, 1)
        camera.aspect = aspect
        camera.fov = cinematicFov(manifest.camera.fov, manifest.camera.referenceAspect, aspect)
        projectView()
        // Set actual pixels explicitly; CSS remains 100% of the viewport.
        renderer.setPixelRatio(1)
        renderer.setSize(bufferWidth, bufferHeight, false)
        const actualWidth = gl.drawingBufferWidth
        const actualHeight = gl.drawingBufferHeight
        if (actualWidth < 1 || actualHeight < 1) throw new Error('WebGL drawing buffer is unavailable')
        return {
          width: actualWidth, height: actualHeight, requestedWidth, requestedHeight,
          limited: actualWidth < requestedWidth || actualHeight < requestedHeight
        }
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}

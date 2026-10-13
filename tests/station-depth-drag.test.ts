import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createPlanetStationMotion, type PlanetStationMotionManifest } from '../src/station-motion'
import { createStationDrag } from '../src/station-drag'
import { defaultLunarView, type LunarView, type LunarViewPoint } from '../src/lunar-view'
import { cinematicFov, type LunarModelManifest, type LunarPose } from '../src/lunar-scene'

type Manifest = PlanetStationMotionManifest & {
  model: LunarModelManifest
  station: PlanetStationMotionManifest['station'] & { model: LunarModelManifest }
  camera: { position: number[]; target: number[]; fov: number; near: number; far: number }
}
const base = 'public/media/cinematic/'
const manifest: Manifest = JSON.parse(readFileSync(base + 'scene.json', 'utf8'))
const zero: LunarPose = { yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 }
const view = defaultLunarView()
const output: Record<string, unknown> = {
  verification: 'Actual GLB geometry and Three.js camera/raycaster; PNG decoding stubbed. Not browser/GPU validation.',
  camera: manifest.camera, viewport: [800, 600], trajectories: []
}
let planet: THREE.Mesh, stationRoot: THREE.Object3D

beforeAll(async () => {
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('createImageBitmap', async () => ({ width: 15360, height: 7680, close() {} }))
  vi.stubGlobal('ProgressEvent', class extends Event { loaded = 0; total = 0 })
  const load = async (spec: LunarModelManifest) => new GLTFLoader().parseAsync(
    Uint8Array.from(Buffer.concat(spec.files.map(file => readFileSync(base + file.name)))).buffer, '')
  planet = (await load(manifest.model)).scene.getObjectByName(manifest.planet.prototype) as THREE.Mesh
  stationRoot = (await load(manifest.station.model)).scene
})
afterAll(() => {
  vi.unstubAllGlobals()
  if (process.env.STATION_DEPTH_QA) writeFileSync(process.env.STATION_DEPTH_QA, JSON.stringify(output, null, 2))
})

function harness(width = 800, height = 600, activeView = view) {
  const motion = createPlanetStationMotion(manifest, planet.clone(), stationRoot.clone(true))
  const spec = manifest.camera
  const camera = new THREE.PerspectiveCamera(cinematicFov(spec.fov, 4 / 3, width / height), width / height, spec.near, spec.far)
  camera.position.fromArray(spec.position)
  camera.lookAt(new THREE.Vector3().fromArray(spec.target))
  const center = new THREE.Vector3().fromArray(manifest.planet.position)
  const eye = camera.position.clone().sub(center).normalize()
  const meshes: THREE.Mesh[] = []
  motion.station.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object) })
  const prepare = (pose: LunarPose, nextView: LunarView) => {
    motion.apply(pose)
    camera.zoom = nextView.zoom
    camera.setViewOffset(width, height, -nextView.panX * width, -nextView.panY * height, width, height)
    camera.updateMatrixWorld(true)
    motion.root.updateMatrixWorld(true)
  }
  const drag = createStationDrag({ manifest, motion, camera, prepare, viewport: () => ({ width, height }) })!
  const raycaster = new THREE.Raycaster()
  raycaster.layers.enableAll()
  const project = (position: THREE.Vector3) => {
    const ndc = position.clone().project(camera)
    return { x: ndc.x / 2, y: -ndc.y / 2 }
  }
  const depthAt = (point: LunarViewPoint) => {
    raycaster.setFromCamera(new THREE.Vector2(point.x * 2, -point.y * 2), camera)
    const station = raycaster.intersectObjects(meshes, false)[0]
    const planet = raycaster.intersectObject(motion.planet, true)[0]
    return { point, station: station?.distance ?? null, planet: planet?.distance ?? null, stationMesh: station?.object.name ?? null }
  }
  const candidates = () => {
    const points = [project(motion.station.position)]
    // Sample real mesh triangle vertices rather than a proxy hit sphere.
    for (const mesh of meshes) {
      const positions = mesh.geometry.getAttribute('position')
      for (const index of [0, Math.floor(positions.count / 3), Math.floor(positions.count * 2 / 3)]) {
        const p = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld)
        points.push(project(p))
      }
    }
    return points
  }
  const visiblePick = (pose: LunarPose) => candidates().find(point => {
    if (Math.abs(point.x) > .49 || Math.abs(point.y) > .49) return false
    const hit = depthAt(point)
    return hit.station !== null && (hit.planet === null || hit.station < hit.planet) && drag.hitTest(point, pose, activeView)
  })
  const overlap = (near: boolean) => {
    // Hemisphere rejects the impossible ordering without scanning 199 rays.
    const depth = motion.station.position.clone().sub(center).dot(eye)
    if ((near && depth < -3) || (!near && depth > 5)) return undefined
    for (const point of candidates()) {
      const hit = depthAt(point)
      if (hit.station !== null && hit.planet !== null && (near ? hit.station < hit.planet - 1 : hit.planet < hit.station - 1)) return hit
    }
    return undefined
  }
  const snapshot = (name: string, pose: LunarPose, pointer: LunarViewPoint) => ({
    name, pose: JSON.parse(JSON.stringify(pose)), pointer,
    position: motion.station.position.toArray(), quaternion: motion.station.quaternion.toArray(), scale: motion.station.scale.toArray(),
    eyeRadialDepth: motion.station.position.clone().sub(center).dot(eye),
    projection: project(motion.station.position), nearOverlap: overlap(true), farOverlap: overlap(false)
  })
  return { motion, camera, center, eye, prepare, drag, project, depthAt, visiblePick, overlap, snapshot, view: activeView }
}

function advance(h: ReturnType<typeof harness>, pose: LunarPose, from: LunarViewPoint, to: LunarViewPoint, steps = 40) {
  const points: unknown[] = []
  let previous = h.motion.station.position.clone()
  const heldClock = pose.stationOrbit ?? pose.orbit
  const radius = new THREE.Vector3().fromArray(manifest.station.position).sub(h.center).length()
  for (let i = 1; i <= steps; i++) {
    const point = { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }
    const change = h.drag.move(point, pose, h.view)
    expect(change).not.toBeNull()
    Object.assign(pose, change)
    h.prepare(pose, h.view)
    const radial = h.motion.station.position.clone().sub(h.center)
    expect(radial.length()).toBeCloseTo(radius, 8)
    expect(new THREE.Vector3(0, -1, 0).applyQuaternion(h.motion.station.quaternion).dot(radial.clone().normalize().negate())).toBeCloseTo(1, 8)
    expect(h.motion.station.position.distanceTo(previous)).toBeLessThan(1)
    expect(pose.stationOrbit).toBe(heldClock)
    previous.copy(h.motion.station.position)
    points.push({ pointer: point, position: previous.toArray(), eyeRadialDepth: radial.dot(h.eye) })
  }
  ;(output.trajectories as unknown[]).push(points)
}

describe('real station front/back depth and continuous drag regressions', () => {
  it('pulls the initial approved station inward over the opaque planet with real station triangles nearer than planet triangles', () => {
    const h = harness(), pose = { ...zero }
    h.prepare(pose, view)
    const start = h.visiblePick(pose)!
    expect(start).toBeDefined()
    expect(h.drag.begin(start, pose, view)).toBe(true)
    const target = h.project(h.center)
    advance(h, pose, start, target)
    const snap = h.snapshot('initial-pull-to-planet-center', pose, target)
    output.initialPull = snap
    expect(snap.eyeRadialDepth).toBeGreaterThan(5)
    expect(snap.nearOverlap).toBeDefined()
    expect(pose.stationOrbit).toBe(0)
    h.drag.end()
  })

  it('grabs real visible far-side triangles, rolls through the limb onto the front, then reverses continuously into true planet occlusion', () => {
    const h = harness(), pose: LunarPose = { ...zero, stationOrbit: 8.4 }
    h.prepare(pose, view)
    const start = h.visiblePick(pose)!
    expect(start).toBeDefined()
    const far = h.snapshot('far-visible-start', pose, start)
    output.farStart = far
    expect(far.eyeRadialDepth).toBeLessThan(-5)
    expect(far.farOverlap).toBeDefined()
    expect(h.drag.begin(start, pose, view)).toBe(true)
    const initial = h.motion.station.position.clone()
    // One continuous inward horizontal swipe. Pointer capture keeps the held
    // station active during its projected overlap with the opaque planet.
    const target = { x: start.x - .55, y: start.y }
    advance(h, pose, start, target, 60)
    const near = h.snapshot('far-to-front-continuous-pull', pose, target)
    output.near = near
    expect(near.eyeRadialDepth).toBeGreaterThan(5)
    expect(near.nearOverlap).toBeDefined()
    expect(pose.stationOrbit).toBe(8.4)
    advance(h, pose, target, start, 60)
    const back = h.snapshot('front-to-far-continuous-reverse', pose, start)
    output.far = back
    expect(back.eyeRadialDepth).toBeLessThan(-5)
    expect(back.farOverlap).toBeDefined()
    expect(h.motion.station.position.distanceTo(initial)).toBeLessThan(1e-7)
    expect(h.drag.hitTest(back.farOverlap!.point, pose, view)).toBe(false)
    h.drag.end()
    expect(h.drag.move(start, pose, view)).toBeNull()
  })

  it('crosses the real far limb in a zoomed 390×844 viewport, then supports a fresh short re-grab', () => {
    const mobileView = { zoom: 2, panX: .08, panY: 0 }
    const h = harness(390, 844, mobileView), pose: LunarPose = { ...zero, stationOrbit: 8.4 }
    h.prepare(pose, mobileView)
    const start = h.visiblePick(pose)!
    expect(start).toBeDefined()
    expect(h.drag.begin(start, pose, mobileView)).toBe(true)
    const target = { x: start.x - .7, y: start.y }
    expect(Math.abs(start.x)).toBeLessThan(.5)
    expect(Math.abs(target.x)).toBeLessThan(.5)
    advance(h, pose, start, target, 60)
    const near = h.snapshot('mobile-390×844-zoom2-far-to-near', pose, target)
    output.mobileNear = near
    expect(near.eyeRadialDepth).toBeGreaterThan(5)
    expect(near.nearOverlap).toBeDefined()
    h.drag.end()
    const regrab = h.visiblePick(pose)!
    expect(regrab).toBeDefined()
    const before = h.motion.station.position.clone()
    expect(h.drag.begin(regrab, pose, mobileView)).toBe(true)
    h.prepare({ ...pose, ...h.drag.move(regrab, pose, mobileView)! }, mobileView)
    expect(h.motion.station.position.distanceTo(before)).toBeLessThan(1e-9)
    advance(h, pose, regrab, { x: regrab.x + .05, y: regrab.y }, 10)
    expect(h.motion.station.position.distanceTo(before)).toBeGreaterThan(.5)
    expect(pose.stationOrbit).toBe(8.4)
    h.drag.end()
  })

  it('keeps real material depth and the existing two depth-preserving camera-layer passes', () => {
    const source = readFileSync('src/lunar-scene.ts', 'utf8')
    expect(source).toMatch(/camera\.layers\.set\(0\)[\s\S]*renderer\.autoClear = true[\s\S]*renderer\.render\(scene, camera\)[\s\S]*camera\.layers\.set\(1\)[\s\S]*renderer\.autoClear = false[\s\S]*scene\.background = null[\s\S]*renderer\.render\(scene, camera\)/)
    expect(source).not.toMatch(/renderer\.clearDepth\s*\(/)
    for (const root of [planet, stationRoot]) root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        expect(material.depthTest).toBe(true)
        expect(material.depthWrite).toBe(true)
      }
    })
  })
})

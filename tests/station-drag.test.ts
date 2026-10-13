import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createStationDrag } from '../src/station-drag'
import { createPlanetStationMotion, type PlanetStationMotionManifest } from '../src/station-motion'
import { defaultLunarView, type LunarView, type LunarViewPoint } from '../src/lunar-view'
import type { LunarPose } from '../src/lunar-scene'

const base = { yaw: 0, pitch: 0, orbit: 0 }
const radiansPerClock = .04 / .24
const view = defaultLunarView()

function fixture({ edgeOn = false, planetRadius = 2, normal = [0, Math.cos(.5), Math.sin(.5)] }: {
  edgeOn?: boolean; planetRadius?: number; normal?: [number, number, number]
} = {}) {
  const manifest: PlanetStationMotionManifest = {
    coordinateSystem: 'three-y-up',
    planet: { prototype: 'Planet', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    station: {
      position: [5, 0, 0],
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0)).toArray() as [number, number, number, number],
      scale: [1, 1, 1],
      rotor: { nodeName: 'Ring_Rotor', axis: [0, 1, 0], radiansPerSecond: .1 },
      motion: { spinAxis: [0, 1, 0], spinRadiansPerSecond: 0, driftAmplitude: [0, 0, 0], driftRadiansPerSecond: 0,
        facePlanetCenter: true, inwardAxis: [0, -1, 0],
        orbit: { normal: edgeOn ? [0, 1, 0] : normal, radiansPerSecond: .04 } }
    }
  }
  const planet = new THREE.Mesh(new THREE.SphereGeometry(planetRadius, 32, 24), new THREE.MeshBasicMaterial())
  const stationRoot = new THREE.Group()
  const hull = new THREE.Mesh(new THREE.SphereGeometry(.28, 16, 12), new THREE.MeshBasicMaterial())
  hull.layers.set(1)
  const mast = new THREE.Mesh(new THREE.BoxGeometry(.12, 1.2, .12), new THREE.MeshBasicMaterial())
  mast.position.y = -.6
  mast.layers.set(1)
  const rotor = new THREE.Group()
  rotor.name = 'Ring_Rotor'
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.48, .07, 8, 32), new THREE.MeshBasicMaterial())
  ring.rotation.x = Math.PI / 2
  ring.layers.set(1)
  rotor.add(ring)
  stationRoot.add(hull, mast, rotor)
  const motion = createPlanetStationMotion(manifest, planet, stationRoot)
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 100)
  camera.position.set(0, 0, 18)
  camera.lookAt(0, 0, 0)
  let size = { width: 1200, height: 800 }
  const prepare = (pose: LunarPose, nextView: LunarView) => {
    camera.zoom = nextView.zoom
    camera.aspect = size.width / size.height
    camera.setViewOffset(size.width, size.height, -nextView.panX * size.width, -nextView.panY * size.height, size.width, size.height)
    camera.updateMatrixWorld(true)
    motion.apply(pose)
    motion.root.updateMatrixWorld(true)
  }
  const drag = createStationDrag({ manifest, motion, camera, prepare, viewport: () => size })!
  const pointForPose = (pose: LunarPose, nextView = view, local = new THREE.Vector3()) => {
    prepare(pose, nextView)
    const projected = local.clone().applyMatrix4(motion.station.matrixWorld).project(camera)
    return { x: projected.x / 2, y: -projected.y / 2 }
  }
  const pointFor = (clock: number, nextView = view, local = new THREE.Vector3()) => pointForPose({ ...base, stationOrbit: clock }, nextView, local)
  return { drag, manifest, motion, camera, planet, hull, mast, ring, rotor, prepare, pointFor, pointForPose,
    resize: (width: number, height: number) => { size = { width, height } } }
}

const shifted = (point: LunarViewPoint, offset: LunarViewPoint) => ({ x: point.x + offset.x, y: point.y + offset.y })

describe('visible station picking', () => {
  it('uses actual geometry on station layer 1, rejecting the planet, empty bounds and distant background', () => {
    const { drag, pointFor, camera, motion } = fixture()
    // The render camera may be on its planet pass when picking starts.
    camera.layers.set(0)
    expect(drag.hitTest(pointFor(0), base, view)).toBe(true)
    expect(drag.begin({ x: 0, y: 0 }, base, view)).toBe(false)
    expect(drag.hitTest({ x: -.45, y: -.45 }, base, view)).toBe(false)
    expect(drag.hitTest({ x: .51, y: 0 }, base, view)).toBe(false)
    expect(drag.hitTest({ x: NaN, y: 0 }, base, view)).toBe(false)
    motion.station.visible = false
    expect(drag.begin(pointFor(0), base, view)).toBe(false)
  })

  it('makes off-station background rejection cheap before any mesh raycast', () => {
    const { drag } = fixture()
    const spy = vi.spyOn(THREE.Mesh.prototype, 'raycast')
    for (let index = 0; index < 30; index++) expect(drag.hitTest({ x: -.4, y: -.4 }, base, view)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('accepts a small CSS-pixel halo but does not use a large box-shaped target', () => {
    const { drag, pointFor, prepare, camera, mast } = fixture()
    prepare(base, view)
    // Test an isolated point alongside the thin mast, far from the ring/hub.
    const edge = new THREE.Vector3(.06, -.9, 0).applyMatrix4(mast.parent!.matrixWorld).project(camera)
    const exact = { x: edge.x / 2, y: -edge.y / 2 }
    const middle = pointFor(0, view, new THREE.Vector3(0, -.9, 0))
    const ySign = Math.sign(exact.y - middle.y)
    expect(drag.hitTest({ x: exact.x, y: exact.y + ySign * 3 / 800 }, base, view)).toBe(true)
    expect(drag.hitTest({ x: exact.x, y: exact.y + ySign * 15 / 800 }, base, view)).toBe(false)
  })

  it('rejects the far-side station through the opaque planet, but accepts the foreground station', () => {
    const { drag, pointFor } = fixture({ edgeOn: true })
    const farClock = Math.PI / 2 / radiansPerClock
    const nearClock = -farClock
    expect(drag.hitTest(pointFor(farClock), { ...base, stationOrbit: farClock }, view)).toBe(false)
    expect(drag.begin(pointFor(farClock), { ...base, stationOrbit: farClock }, view)).toBe(false)
    expect(drag.hitTest(pointFor(nearClock), { ...base, stationOrbit: nearClock }, view)).toBe(true)
  })

  it('does not make invisible station materials or hidden ancestors selectable', () => {
    const { drag, pointFor, hull, mast, ring, motion } = fixture()
    for (const mesh of [hull, mast, ring]) mesh.material.visible = false
    expect(drag.hitTest(pointFor(0), base, view)).toBe(false)
    for (const mesh of [hull, mast, ring]) mesh.material.visible = true
    motion.root.visible = false
    expect(drag.hitTest(pointFor(0), base, view)).toBe(false)
  })
})

describe('camera-aware two-axis station dragging', () => {
  const identity = [0, 0, 0, 1]
  const expectInvariants = (motion: ReturnType<typeof fixture>['motion']) => {
    expect(motion.station.position.length()).toBeCloseTo(5, 11)
    expect(motion.station.quaternion.toArray().every(Number.isFinite)).toBe(true)
    expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion)
      .dot(motion.station.position.clone().normalize().negate())).toBeCloseTo(1, 11)
  }

  it.each([0, 2, 8, -12, 34, 78])('retains the exact pose on press and release at clock %s', clock => {
    const { drag, pointForPose, motion, rotor } = fixture({ planetRadius: .1 })
    const pose = { ...base, orbit: 10, stationOrbit: clock }
    const point = pointForPose(pose)
    const position = motion.station.position.toArray(), attitude = motion.station.quaternion.toArray()
    expect(drag.begin(point, pose, view)).toBe(true)
    expect(drag.move(point, pose, view)).toEqual({ stationOrbit: clock, stationFrame: identity })
    expect(motion.station.position.toArray()).toEqual(position)
    expect(motion.station.quaternion.toArray()).toEqual(attitude)
    const rotation = rotor.quaternion.toArray()
    expect(drag.move(point, { ...pose, orbit: 11 }, view)).toEqual({ stationOrbit: clock, stationFrame: identity })
    expect(motion.station.position.toArray()).toEqual(position)
    expect(motion.station.quaternion.toArray()).toEqual(attitude)
    expect(rotor.quaternion.toArray()).not.toEqual(rotation)
    drag.end()
    expect(drag.move(shifted(point, { x: .1, y: .1 }), pose, view)).toBe(null)
  })

  it.each([
    [0, { zoom: 1, panX: 0, panY: 0 }],
    [4, { zoom: 2, panX: -.2, panY: .1 }],
    [-9, { zoom: 2, panX: 0, panY: -.2 }],
    [18, { zoom: 1.25, panX: .125, panY: -.05 }],
    [34, { zoom: 1.5, panX: -.1, panY: .05 }]
  ])('rolls in both tangent directions at clock %s with zoom/pan', (clock, nextView) => {
    const { drag, pointForPose, motion, manifest } = fixture({ planetRadius: .001 })
    let pose: LunarPose = { ...base, orbit: 12, stationOrbit: clock }
    const point = pointForPose(pose, nextView, new THREE.Vector3(0, -.4, 0))
    const oldNormal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
    expect(drag.begin(point, pose, nextView)).toBe(true)
    const raycast = vi.spyOn(THREE.Mesh.prototype, 'raycast')
    for (const delta of [{ x: 0, y: -.01 }, { x: 0, y: .01 }, { x: -.01, y: 0 }, { x: -.02, y: -.008 }]) {
      const before = motion.station.position.clone()
      pose = { ...pose, ...drag.move(shifted(point, delta), pose, nextView)! }
      pointForPose(pose, nextView)
      expect(pose.stationOrbit).toBe(clock)
      expect(motion.station.position.distanceTo(before)).toBeGreaterThan(.08)
      if (delta.x === 0) expect(Math.abs(motion.station.position.dot(oldNormal))).toBeGreaterThan(.02)
      expectInvariants(motion)
    }
    expect(raycast).not.toHaveBeenCalled()
  })

  it('moves right/up relative to a rotated and rolled camera at the foreground pole', () => {
    const { drag, camera, pointForPose, motion } = fixture({ planetRadius: .01 })
    camera.position.set(8, 6, 18)
    camera.lookAt(0, 0, 0)
    camera.rotateZ(.6)
    camera.updateMatrixWorld(true)
    const near = camera.position.clone().normalize()
    const initialFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), near)
    for (const delta of [{ x: .015, y: 0 }, { x: 0, y: -.015 }]) {
      let pose: LunarPose = { ...base, stationFrame: initialFrame.toArray() }
      const point = pointForPose(pose)
      const before = motion.station.position.clone()
      expect(drag.begin(point, pose, view)).toBe(true)
      pose = { ...pose, ...drag.move(shifted(point, delta), pose, view)! }
      const afterPoint = pointForPose(pose)
      const screenAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, delta.x ? 0 : 1)
      expect(motion.station.position.clone().sub(before).dot(screenAxis)).toBeGreaterThan(.3)
      if (delta.x) { expect(afterPoint.x).toBeGreaterThan(point.x); expect(afterPoint.y).toBeCloseTo(point.y, 10) }
      else { expect(afterPoint.y).toBeLessThan(point.y); expect(afterPoint.x).toBeCloseTo(point.x, 10) }
      expectInvariants(motion)
      drag.end()
    }
  })

  it('rolls a visible far-side station through the limb onto the front, then retraces back', () => {
    const { drag, pointForPose, motion, camera } = fixture()
    const theta = 2.2
    const initialRadial = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta))
    const initialFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), initialRadial)
    let pose: LunarPose = { ...base, stationFrame: initialFrame.toArray() }
    const point = pointForPose(pose)
    const start = motion.station.position.clone()
    expect(start.z).toBeLessThan(-2)
    expect(drag.begin(point, pose, view)).toBe(true)
    const raycast = vi.spyOn(THREE.Mesh.prototype, 'raycast')
    // This entire inward swipe fits on screen. Its first part physically rolls
    // OUT to the apparent limb before passing onto the near surface.
    const distance = .30
    let previous = start.clone(), largestX = point.x
    for (let step = 1; step <= 120; step++) {
      const target = shifted(point, { x: -distance * step / 120, y: 0 })
      expect(Math.abs(target.x)).toBeLessThan(.5)
      pose = { ...pose, ...drag.move(target, pose, view)! }
      const projected = pointForPose(pose)
      largestX = Math.max(largestX, projected.x)
      expect(motion.station.position.distanceTo(previous)).toBeGreaterThan(.05)
      expect(motion.station.position.distanceTo(previous)).toBeLessThan(.11)
      previous.copy(motion.station.position)
      expectInvariants(motion)
    }
    expect(largestX).toBeGreaterThan(point.x + .03)
    expect(motion.station.position.z).toBeGreaterThan(4.9)
    expect(Math.abs(pointForPose(pose).x)).toBeLessThan(.03)
    // The same planet-overlap ray now meets the station before the planet.
    expect(motion.station.position.clone().sub(camera.position).length()).toBeLessThan(camera.position.length() - 2)
    for (let step = 119; step >= 0; step--) {
      pose = { ...pose, ...drag.move(shifted(point, { x: -distance * step / 120, y: 0 }), pose, view)! }
      pointForPose(pose)
      expectInvariants(motion)
    }
    expect(motion.station.position.distanceTo(start)).toBeLessThan(1e-11)
    expect(new THREE.Quaternion().fromArray(pose.stationFrame!).angleTo(initialFrame)).toBeLessThan(1e-7)
    expect(raycast).not.toHaveBeenCalled()
    raycast.mockRestore()
    expect(drag.hitTest(pointForPose(pose), pose, view)).toBe(true)
  })

  it.each([-1, 1])('crosses both sides of the projected limb without a root lock, initial side %s', side => {
    const { drag, pointForPose, motion, camera } = fixture({ planetRadius: .01 })
    const tangentZ = 25 / 18
    const initialRadial = new THREE.Vector3(Math.sqrt(25 - (tangentZ + side * .01) ** 2), 0, tangentZ + side * .01)
    const initialFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), initialRadial.clone().normalize())
    let pose: LunarPose = { ...base, stationFrame: initialFrame.toArray() }
    const point = pointForPose(pose)
    expect(drag.begin(point, pose, view)).toBe(true)
    let previous = motion.station.position.clone(), closest = Infinity, farthest = -Infinity
    for (let index = 1; index <= 160; index++) {
      const target = shifted(point, { x: .035 * Math.sin(index * Math.PI / 40), y: .012 * Math.sin(index * Math.PI / 20) })
      pose = { ...pose, ...drag.move(target, pose, view)! }
      pointForPose(pose)
      expectInvariants(motion)
      expect(motion.station.position.distanceTo(previous)).toBeLessThan(.15)
      const rayDirection = motion.station.position.clone().sub(camera.position).normalize()
      const depth = motion.station.position.dot(rayDirection)
      closest = Math.min(closest, depth); farthest = Math.max(farthest, depth)
      previous.copy(motion.station.position)
    }
    expect(closest).toBeLessThan(-1)
    expect(farthest).toBeGreaterThan(1)
  })

  it.each([[5, 0, 0], [-5, 0, 0], [0, 5, 0], [0, -5, 0], [0, 0, 5], [0, 0, -5]])('keeps BOTH controls effective at pole %s,%s,%s', (x, y, z) => {
    const { drag, pointForPose, motion } = fixture({ planetRadius: .001 })
    const pole = new THREE.Vector3(x, y, z)
    const initialFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), pole.clone().normalize())
    if (z < 0) motion.planet.visible = false
    for (const delta of [{ x: .01, y: 0 }, { x: 0, y: .01 }]) {
      let pose: LunarPose = { ...base, stationFrame: initialFrame.toArray() }
      const point = pointForPose(pose)
      expect(drag.begin(point, pose, view)).toBe(true)
      pose = { ...pose, ...drag.move(shifted(point, delta), pose, view)! }
      pointForPose(pose)
      expect(motion.station.position.distanceTo(pole)).toBeGreaterThan(.25)
      expectInvariants(motion)
      pose = { ...pose, ...drag.move(point, pose, view)! }
      pointForPose(pose)
      expect(motion.station.position.distanceTo(pole)).toBeLessThan(1e-12)
      drag.end()
    }
  })

  it('keeps rolling through complete turns instead of clamping large pointer travel', () => {
    const run = (steps: number) => {
      const { drag, pointForPose, motion, camera } = fixture({ planetRadius: .001 })
      let pose: LunarPose = { ...base }
      const point = pointForPose(pose)
      const radiusPixels = camera.projectionMatrix.elements[5] * 5 * 800 / (2 * Math.sqrt(18 ** 2 - 25))
      expect(drag.begin(point, pose, view)).toBe(true)
      const positions: THREE.Vector3[] = []
      for (let step = 1; step <= steps; step++) {
        pose = { ...pose, ...drag.move(shifted(point, { x: -8 * radiusPixels / 1200 * step / steps, y: 0 }), pose, view)! }
        pointForPose(pose)
        positions.push(motion.station.position.clone())
        expectInvariants(motion)
      }
      return { pose, positions }
    }
    const fine = run(400), coarse = run(1)
    expect(Math.min(...fine.positions.map(position => position.z))).toBeLessThan(-4.99)
    expect(Math.max(...fine.positions.map(position => position.z))).toBeGreaterThan(4.99)
    expect(fine.positions.at(-1)!.distanceTo(new THREE.Vector3(5, 0, 0))).toBeLessThan(1e-10)
    expect(fine.positions.at(-1)!.distanceTo(coarse.positions[0])).toBeLessThan(1e-10)
  })

  it.each([[390, 844], [1200, 800]])('reaches the far hemisphere within the %s×%s viewport even at zoom 2', (width, height) => {
    const { drag, pointForPose, motion, resize } = fixture({ planetRadius: 2 })
    resize(width, height)
    const nextView = { zoom: 2, panX: -.35, panY: .05 }
    const initialFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1))
    let pose: LunarPose = { ...base, stationFrame: initialFrame.toArray() }
    const point = pointForPose(pose, nextView)
    expect(drag.begin(point, pose, nextView)).toBe(true)
    // A 0.75-width swipe starts at -0.35 and ends at +0.40 on both layouts.
    for (let step = 1; step <= 100; step++) {
      const target = shifted(point, { x: .75 * step / 100, y: 0 })
      expect(Math.abs(target.x)).toBeLessThan(.5)
      pose = { ...pose, ...drag.move(target, pose, nextView)! }
      pointForPose(pose, nextView)
      expectInvariants(motion)
    }
    expect(motion.station.position.z).toBeLessThan(-3.4)
    // Holding remains active through genuine planet occlusion; no repick occurs.
    expect(drag.move(point, pose, nextView)).not.toBe(null)
  })

  it('continues smoothly in the changed circular plane and re-grabs without pose jumps', () => {
    const { drag, pointForPose, motion, manifest } = fixture({ planetRadius: .001 })
    let pose: LunarPose = { ...base, orbit: 12, stationOrbit: 0 }
    const authoredNormal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
    for (let attempt = 0; attempt < 8; attempt++) {
      const point = pointForPose(pose)
      const before = motion.station.position.clone()
      const attitude = motion.station.quaternion.clone()
      expect(drag.begin(point, pose, view)).toBe(true)
      pose = { ...pose, ...drag.move(point, pose, view)! }
      pointForPose(pose)
      expect(motion.station.position.distanceTo(before)).toBeLessThan(1e-12)
      expect(motion.station.quaternion.angleTo(attitude)).toBeLessThan(1e-7)
      pose = { ...pose, ...drag.move(shifted(point, { x: -.002, y: attempt % 2 ? .01 : -.015 }), pose, view)! }
      pointForPose(pose)
      const released = motion.station.position.clone()
      const releasedAttitude = motion.station.quaternion.clone()
      drag.end()
      motion.apply(pose)
      expect(motion.station.position.distanceTo(released)).toBeLessThan(1e-12)
      expect(motion.station.quaternion.angleTo(releasedAttitude)).toBeLessThan(1e-7)
      const newNormal = authoredNormal.clone().applyQuaternion(new THREE.Quaternion().fromArray(pose.stationFrame!))
      expect(newNormal.distanceTo(authoredNormal)).toBeGreaterThan(.001)
      pose.stationOrbit! += .012
      motion.apply(pose)
      expect(motion.station.position.distanceTo(released)).toBeGreaterThan(.009)
      expect(motion.station.position.distanceTo(released)).toBeLessThan(.011)
      expect(motion.station.position.dot(newNormal)).toBeCloseTo(0, 10)
      expectInvariants(motion)
    }
  })

  it('does not change pose when viewport, zoom, pan or camera changes while held', () => {
    const { drag, pointForPose, resize, motion, camera } = fixture()
    let pose: LunarPose = { ...base, stationOrbit: 2 }
    const point = pointForPose(pose)
    expect(drag.begin(point, pose, view)).toBe(true)
    const previousPointer = shifted(point, { x: -.008, y: -.008 })
    pose = { ...pose, ...drag.move(previousPointer, pose, view)! }
    pointForPose(pose)
    const oldPosition = motion.station.position.clone()
    resize(800, 1000)
    camera.position.set(3, 2, 20); camera.lookAt(0, 0, 0)
    const changedView = { zoom: 1.5, panX: -.3, panY: .2 }
    const unchanged = drag.move(previousPointer, pose, changedView)!
    expect(unchanged.stationOrbit).toBe(pose.stationOrbit)
    expect(unchanged.stationFrame).toEqual(pose.stationFrame)
    pointForPose(pose, changedView)
    expect(motion.station.position.distanceTo(oldPosition)).toBeLessThan(1e-12)
    pose = { ...pose, ...drag.move(shifted(previousPointer, { x: -.004, y: -.005 }), pose, changedView)! }
    pointForPose(pose, changedView)
    expect(motion.station.position.distanceTo(oldPosition)).toBeGreaterThan(.05)
    expect(motion.station.position.distanceTo(oldPosition)).toBeLessThan(.2)
    expectInvariants(motion)
  })

  it('ends safely, rejects failed re-grabs, and starts exactly at the reset pose', () => {
    const { drag, pointFor, motion } = fixture()
    const start = pointFor(0)
    expect(drag.move(start, base, view)).toBe(null)
    expect(drag.begin(start, base, view)).toBe(true)
    expect(drag.move(shifted(start, { x: -.01, y: -.01 }), base, view)!.stationFrame).not.toEqual(identity)
    drag.end()
    drag.end()
    expect(drag.move(start, base, view)).toBe(null)
    expect(drag.begin(start, base, view)).toBe(true)
    expect(drag.move(start, base, view)).toEqual({ stationOrbit: 0, stationFrame: identity })
    expect(drag.begin({ x: 0, y: 0 }, base, view)).toBe(false)
    expect(drag.move(start, base, view)).toBe(null)
    expect(drag.begin(start, base, view)).toBe(true)
    expect(drag.move({ x: NaN, y: 0 }, base, view)).toBe(null)
    motion.dispose()
    expect(drag.move(start, base, view)).toBe(null)
    expect(drag.begin(start, base, view)).toBe(false)
  })
})

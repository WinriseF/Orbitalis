import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  createPlanetStationMotion,
  type PlanetStationMotionManifest,
  type PlanetStationQuaternion,
  type PlanetStationTransform
} from '../src/station-motion'

const zero = { yaw: 0, pitch: 0, orbit: 0 }
const quaternion = (x: number, y: number, z: number) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray() as unknown as PlanetStationQuaternion

function matrixFor(transform: PlanetStationTransform) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(transform.position),
    new THREE.Quaternion().fromArray(transform.quaternion),
    new THREE.Vector3().fromArray(transform.scale)
  )
}

function fixture(orbital = false, inwardSign: 1 | -1 = 1, withRotor = false) {
  const manifest: PlanetStationMotionManifest = {
    coordinateSystem: 'three-y-up',
    planet: { prototype: 'Planet_Core', position: [-.35, .9, -1.2], quaternion: quaternion(.4, -.8, .18), scale: [1.15, .85, 1.3] },
    station: {
      position: [5.1, -2.65, 3.5], quaternion: quaternion(.25, -.42, .38), scale: [.18, .18, .18],
      motion: { spinAxis: [0, 1, 0], spinRadiansPerSecond: .018, driftAmplitude: [.08, .05, .05], driftRadiansPerSecond: .04 }
    }
  }
  if (orbital) {
    const inward = new THREE.Vector3().fromArray(manifest.planet.position).sub(new THREE.Vector3().fromArray(manifest.station.position)).normalize()
    manifest.station.quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, inwardSign, 0), inward).toArray() as unknown as PlanetStationQuaternion
    manifest.station.motion.facePlanetCenter = true
    if (inwardSign === -1) manifest.station.motion.inwardAxis = [0, -1, 0]
    manifest.station.motion.orbit = { normal: new THREE.Vector3().crossVectors(inward, new THREE.Vector3(0, 0, 1)).normalize().toArray() as [number, number, number], radiansPerSecond: .04 }
    manifest.station.motion.driftAmplitude = [0, 0, 0]
    manifest.station.motion.driftRadiansPerSecond = 0
  }
  if (withRotor) {
    manifest.station.rotor = { nodeName: 'Ring_Rotor', axis: [0, 1, 0], radiansPerSecond: .10 }
    manifest.station.motion.spinRadiansPerSecond = 0
  }
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial())
  planet.name = 'Planet_Core'
  // Deliberately non-identity source placement: manifest placement replaces it once.
  planet.position.set(100, 200, 300)
  planet.rotation.set(.9, .4, 1.7)
  planet.scale.set(3, 2, 4)
  const prototypeScene = new THREE.Group()
  prototypeScene.add(planet)

  const stationRoot = new THREE.Group()
  stationRoot.name = 'AuthoredStationGLTFRoot'
  // The root itself can carry an exporter correction and must remain untouched.
  stationRoot.position.set(.2, -.1, .3)
  stationRoot.rotation.set(-.3, .16, -.2)
  stationRoot.scale.set(.9, 1.1, .95)
  const material = new THREE.MeshStandardMaterial()
  const geometry = new THREE.BoxGeometry(.4, .2, .5)
  const rotor = withRotor ? new THREE.Group() : null
  if (rotor) {
    rotor.name = 'Ring_Rotor'
    rotor.position.set(.13, .4, -.23)
    rotor.rotation.set(.1, .2, -.12)
    rotor.scale.set(.9, 1.1, .8)
    const hub = new THREE.Mesh(geometry, material)
    hub.name = 'Fixed_Hub'
    const mast = new THREE.Mesh(geometry, material)
    mast.name = 'Fixed_Mast'
    mast.position.set(0, 2, 0)
    stationRoot.add(rotor, hub, mast)
  }
  for (let index = 0; index < 3; index++) {
    const pivot = new THREE.Group()
    pivot.name = `AuthoredAnnularPivot_${index}`
    pivot.position.set(.03 * index, index * .8, -.02 * index)
    pivot.rotation.set(.08 * index, .15 * index, -.07 * index)
    const ring = new THREE.Mesh(geometry, material)
    ring.name = `AnnularRing_${index}`
    ring.position.set(.35, .12, -.2)
    ring.rotation.set(.2, -.1, .3)
    const utility = new THREE.Mesh(geometry, material)
    utility.name = `${withRotor ? 'Attached' : 'Fixed'}Utility_${index}`
    utility.position.set(-.4, index * .8, .1)
    pivot.add(ring)
    ;(rotor ?? stationRoot).add(pivot, utility)
  }
  stationRoot.updateMatrixWorld(true)
  const originalRootMatrix = stationRoot.matrix.clone()
  const motion = createPlanetStationMotion(manifest, planet, stationRoot)
  motion.root.updateMatrixWorld(true)
  return { manifest, planet, stationRoot, prototypeScene, originalRootMatrix, motion, rotor }
}

function localMatrices(root: THREE.Object3D) {
  const matrices = new Map<THREE.Object3D, number[]>()
  root.traverse(node => { matrices.set(node, node.matrix.elements.slice()) })
  return matrices
}

function worldMatrices(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const matrices = new Map<THREE.Object3D, number[]>()
  root.traverse(node => { matrices.set(node, node.matrixWorld.elements.slice()) })
  return matrices
}

function expectMatricesClose(actual: THREE.Matrix4, expected: THREE.Matrix4) {
  actual.elements.forEach((value, index) => expect(value).toBeCloseTo(expected.elements[index], 12))
}

describe('independent coherent station rotor', () => {
  it('spins rings and attached utilities relative to the fixed hub while the outer station only revolves', () => {
    const { manifest, motion, planet, stationRoot, rotor } = fixture(true, -1, true)
    expect(motion.rotor).toBe(rotor)
    const authoredRotor = rotor!.quaternion.clone()
    const authoredPosition = rotor!.position.clone()
    const authoredScale = rotor!.scale.clone()
    const authoredStation = new THREE.Quaternion().fromArray(manifest.station.quaternion)
    const normal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const radius = motion.station.position.distanceTo(center)
    const originalLocals = localMatrices(stationRoot)
    const initialWorld = worldMatrices(motion.root)
    const relativeToStation = (node: THREE.Object3D) => motion.station.matrixWorld.clone().invert().multiply(node.matrixWorld)
    const fixedParts = ['Fixed_Hub', 'Fixed_Mast'].map(name => stationRoot.getObjectByName(name)!)
    const fixedMatrices = fixedParts.map(relativeToStation)
    const movingParts: THREE.Object3D[] = []
    rotor!.traverse(node => movingParts.push(node))
    const movingMatrices = movingParts.map(relativeToStation)
    motion.apply({ yaw: .9, pitch: -.3, orbit: 0 })
    motion.root.updateMatrixWorld(true)
    const draggedPlanet = planet.matrixWorld.clone()
    for (const seconds of [5, 12, Math.PI * 2 / .1, -120, 2000]) {
      motion.apply({ yaw: .9, pitch: -.3, orbit: seconds * .24 })
      motion.root.updateMatrixWorld(true)
      const expectedStation = new THREE.Quaternion().setFromAxisAngle(normal, seconds * .04).multiply(authoredStation)
      expect(motion.station.quaternion.angleTo(expectedStation)).toBeLessThan(1e-7)
      const expectedRotor = authoredRotor.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seconds * .1))
      expect(rotor!.quaternion.angleTo(expectedRotor)).toBeLessThan(1e-7)
      expect(rotor!.position.toArray()).toEqual(authoredPosition.toArray())
      expect(rotor!.scale.toArray()).toEqual(authoredScale.toArray())
      expect(motion.station.position.distanceTo(center)).toBeCloseTo(radius, 12)
      expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(center.clone().sub(motion.station.position).normalize())).toBeCloseTo(1, 12)
      expect(planet.matrixWorld.elements).toEqual(draggedPlanet.elements)
      fixedParts.forEach((node, i) => expectMatricesClose(relativeToStation(node), fixedMatrices[i]))
      stationRoot.traverse(node => {
        if (node !== rotor) expect(node.matrix.elements).toEqual(originalLocals.get(node))
      })
      if (seconds === 5 || seconds === 12) {
        movingParts.forEach((node, i) => expect(relativeToStation(node).elements).not.toEqual(movingMatrices[i].elements))
      }
      if (seconds === Math.PI * 2 / .1) {
        movingParts.forEach((node, i) => expectMatricesClose(relativeToStation(node), movingMatrices[i]))
      }
    }
    motion.apply(zero)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(initialWorld.get(node))
  })

  it('snapshots the rotor settings and is absolute across repeated frames, jumps, planet dragging and exact reset', () => {
    const { motion, manifest, rotor } = fixture(true, -1, true)
    const initial = worldMatrices(motion.root)
    const authoredRotor = rotor!.quaternion.clone()
    manifest.station.rotor!.axis = [1, 0, 0]
    manifest.station.rotor!.radiansPerSecond = 9
    manifest.station.rotor!.nodeName = 'Fixed_Mast'
    const pose = { yaw: .5, pitch: -.3, orbit: 12 * .24 }
    motion.apply(pose)
    const atTwelve = worldMatrices(motion.root)
    for (const intermediate of [zero, { yaw: -2, pitch: 1, orbit: Number.MAX_VALUE }, pose]) {
      motion.apply(intermediate)
      motion.apply(pose)
      for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(atTwelve.get(node))
    }
    motion.apply({ ...pose, yaw: -1, pitch: .2 })
    motion.root.updateMatrixWorld(true)
    motion.station.traverse(node => expect(node.matrixWorld.elements).toEqual(atTwelve.get(node)))
    expect(rotor!.quaternion.angleTo(authoredRotor
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2)))).toBeLessThan(1e-7)
    motion.apply(zero)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(initial.get(node))
  })

  it('updates a matrix-locked rotor without changing its flag, hierarchy or shared resource ownership', () => {
    const { manifest } = fixture(true, -1, true)
    const planet = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial())
    const stationRoot = new THREE.Group()
    const rotor = new THREE.Group()
    rotor.name = 'Ring_Rotor'
    rotor.position.set(.3, -.2, .1)
    rotor.rotation.set(.2, -.1, .3)
    rotor.scale.set(.8, 1.2, .9)
    rotor.updateMatrix()
    rotor.matrixAutoUpdate = false
    const originalMatrix = rotor.matrix.clone()
    const ring = new THREE.Mesh(planet.geometry, planet.material)
    rotor.add(ring)
    stationRoot.add(rotor)
    const motion = createPlanetStationMotion(manifest, planet, stationRoot)
    const nodes = [...worldMatrices(motion.root).keys()]
    const children = nodes.map(node => node.children)
    const vectorClone = vi.spyOn(THREE.Vector3.prototype, 'clone')
    const quaternionClone = vi.spyOn(THREE.Quaternion.prototype, 'clone')
    const matrixClone = vi.spyOn(THREE.Matrix4.prototype, 'clone')
    const meshClone = vi.spyOn(THREE.Mesh.prototype, 'clone')
    const geometryClone = vi.spyOn(THREE.BufferGeometry.prototype, 'clone')
    const materialClone = vi.spyOn(THREE.Material.prototype, 'clone')
    for (let frame = 1; frame <= 120; frame++) motion.apply({ ...zero, orbit: frame * .004 })
    for (const spy of [vectorClone, quaternionClone, matrixClone, meshClone, geometryClone, materialClone]) expect(spy).not.toHaveBeenCalled()
    motion.root.updateMatrixWorld(true)
    expect(rotor.matrix.elements).not.toEqual(originalMatrix.elements)
    expect(rotor.matrixAutoUpdate).toBe(false)
    expect(rotor.parent).toBe(stationRoot)
    expect(ring.parent).toBe(rotor)
    expect(ring.geometry).toBe(planet.geometry)
    expect(ring.material).toBe(planet.material)
    motion.apply(zero)
    motion.root.updateMatrixWorld(true)
    expect(rotor.matrix.elements).toEqual(originalMatrix.elements)
    const atReset = worldMatrices(motion.root)
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose')
    motion.dispose()
    motion.dispose()
    motion.apply({ yaw: 1, pitch: 2, orbit: 20 })
    expect(motion.root.visible).toBe(false)
    expect(geometryDispose).not.toHaveBeenCalled()
    expect(materialDispose).not.toHaveBeenCalled()
    expect([...worldMatrices(motion.root).keys()]).toEqual(nodes)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(atReset.get(node))
    nodes.forEach((node, i) => expect(node.children).toBe(children[i]))
  })

  it('keeps rotor state unchanged for rejected poses and finite for extreme finite rates and clocks', () => {
    const { manifest, motion, rotor } = fixture(true, -1, true)
    const before = worldMatrices(motion.root)
    for (const key of ['yaw', 'pitch', 'orbit']) {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() => motion.apply({ ...zero, [key]: value })).toThrow('finite yaw, pitch and orbit')
        for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(before.get(node))
      }
    }
    manifest.station.rotor!.axis = [0, Number.MIN_VALUE, 0]
    manifest.station.rotor!.radiansPerSecond = Number.MAX_VALUE
    const extreme = createPlanetStationMotion(manifest, motion.planet.children[0] as THREE.Mesh, motion.station.children[0])
    for (const orbit of [Number.MIN_VALUE, 1, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      extreme.apply({ ...zero, orbit })
      expect(rotor!.quaternion.toArray().every(Number.isFinite)).toBe(true)
      expect(rotor!.quaternion.length()).toBeCloseTo(1, 12)
    }
  })

  it.each([
    ['null settings', (m: any, _root: THREE.Group, _rotor: THREE.Group) => { m.station.rotor = null }, 'rotor node name'],
    ['empty node', (m: any) => { m.station.rotor.nodeName = ' ' }, 'rotor node name'],
    ['missing node', (m: any) => { m.station.rotor.nodeName = 'Missing' }, 'exactly one descendant'],
    ['whole root', (m: any, root: THREE.Group) => { root.name = 'Root'; m.station.rotor.nodeName = 'Root' }, 'exactly one descendant'],
    ['duplicate node', (_m: any, root: THREE.Group) => { const duplicate = new THREE.Group(); duplicate.name = 'Ring_Rotor'; root.add(duplicate) }, 'exactly one descendant'],
    ['zero axis', (m: any) => { m.station.rotor.axis = [0, 0, 0] }, 'rotor axis'],
    ['infinite axis', (m: any) => { m.station.rotor.axis = [0, Infinity, 0] }, 'rotor axis'],
    ['sparse axis', (m: any) => { m.station.rotor.axis = Array(3) }, 'rotor axis'],
    ['negative speed', (m: any) => { m.station.rotor.radiansPerSecond = -.1 }, 'rotor speed'],
    ['infinite speed', (m: any) => { m.station.rotor.radiansPerSecond = Infinity }, 'rotor speed'],
    ['invalid position', (_m: any, _root: THREE.Group, rotor: THREE.Group) => { rotor.position.x = NaN }, 'rotor position'],
    ['invalid quaternion', (_m: any, _root: THREE.Group, rotor: THREE.Group) => { rotor.quaternion.set(0, 0, 0, 0) }, 'rotor quaternion'],
    ['invalid scale', (_m: any, _root: THREE.Group, rotor: THREE.Group) => { rotor.scale.y = 0 }, 'rotor scale']
  ])('rejects %s before changing source hierarchy', (_label, corrupt, error) => {
    const { manifest } = fixture(true, -1, true)
    const source = new THREE.Group()
    const planet = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial())
    const stationRoot = new THREE.Group()
    const rotor = new THREE.Group()
    rotor.name = 'Ring_Rotor'
    stationRoot.add(rotor)
    source.add(planet, stationRoot)
    corrupt(manifest, stationRoot, rotor)
    expect(() => createPlanetStationMotion(manifest, planet, stationRoot)).toThrow(error)
    expect(source.children).toEqual([planet, stationRoot])
    expect(rotor.parent).toBe(stationRoot)
  })

  it('supports zero rotor speed and leaves the rotor absent for older compositions', () => {
    expect(fixture().motion.rotor).toBeNull()
    const { manifest, motion, rotor } = fixture(true, -1, true)
    manifest.station.rotor!.radiansPerSecond = 0
    const stillRotor = createPlanetStationMotion(manifest, motion.planet.children[0] as THREE.Mesh, motion.station.children[0])
    const original = rotor!.quaternion.toArray()
    stillRotor.apply({ ...zero, orbit: Number.MAX_VALUE })
    expect(rotor!.quaternion.toArray()).toEqual(original)
  })
})

describe('independent planet and rigid station motion', () => {
  it.each([1, -1] as const)('revolves with selected local Y end %s inward through every phase and reset', inwardSign => {
    const { motion, manifest, stationRoot, planet } = fixture(true, inwardSign)
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const initialOffset = new THREE.Vector3().fromArray(manifest.station.position).sub(center)
    const radius = initialOffset.length()
    const normal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
    const authored = new THREE.Quaternion().fromArray(manifest.station.quaternion)
    const originalLocals = localMatrices(stationRoot)
    const initialStation = motion.station.matrixWorld.clone()
    const period = Math.PI * 2 / .04
    motion.apply({ yaw: .8, pitch: -.2, orbit: 5 * .24 })
    motion.root.updateMatrixWorld(true)
    const planetHeld = planet.matrixWorld.clone()
    const atFive = motion.station.matrixWorld.clone()
    expect(atFive.elements).not.toEqual(initialStation.elements)
    // Caller changes cannot alter active orbital state.
    manifest.station.motion.orbit!.normal = [1, 0, 0]
    manifest.station.motion.orbit!.radiansPerSecond = 1
    manifest.station.motion.facePlanetCenter = false
    manifest.station.position = [100, 200, 300]
    for (const seconds of [12, ...Array.from({ length: 73 }, (_, i) => i * period / 72), -200, 1e20, Number.MAX_VALUE]) {
      motion.apply({ yaw: .8, pitch: -.2, orbit: seconds * .24 })
      motion.root.updateMatrixWorld(true)
      const offset = motion.station.position.clone().sub(center)
      const inward = offset.clone().normalize().negate()
      expect(offset.length()).toBeCloseTo(radius, 11)
      expect(offset.dot(normal)).toBeCloseTo(0, 11)
      expect(new THREE.Vector3(0, inwardSign, 0).applyQuaternion(motion.station.quaternion).dot(inward)).toBeCloseTo(1, 12)
      expect(planet.matrixWorld.elements).toEqual(planetHeld.elements)
      stationRoot.traverse(node => expect(node.matrix.elements).toEqual(originalLocals.get(node)))
      if (seconds === 12) expect(motion.station.matrixWorld.elements).not.toEqual(atFive.elements)
    }
    motion.apply({ ...zero, orbit: period / 2 * .24 })
    expect(motion.station.position.clone().sub(center).distanceTo(initialOffset.clone().negate())).toBeLessThan(1e-12)
    motion.apply({ ...zero, orbit: period / 4 * .24 })
    const expected = new THREE.Quaternion().setFromAxisAngle(normal, Math.PI / 2).multiply(authored)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), period / 4 * .018))
    expect(motion.station.quaternion.angleTo(expected)).toBeLessThan(1e-7)
    motion.apply(zero)
    motion.root.updateMatrixWorld(true)
    expect(motion.station.matrixWorld.elements).toEqual(initialStation.elements)
  })

  it.each([
    ['nonaxial inward end', (m: any) => { m.station.motion.inwardAxis = [1, 0, 0] }, 'inward axis'],
    ['nonunit inward end', (m: any) => { m.station.motion.inwardAxis = [0, -2, 0] }, 'inward axis'],
    ['opposite end mismatch', (m: any) => { m.station.motion.inwardAxis = [0, -1, 0] }, 'point inward'],
    ['zero radius', (m: any) => { m.station.position = m.planet.position.slice() }, 'orbit radius'],
    ['zero normal', (m: any) => { m.station.motion.orbit.normal = [0, 0, 0] }, 'orbit normal'],
    ['nonperpendicular normal', (m: any) => { m.station.motion.orbit.normal = [1, 0, 0] }, 'perpendicular'],
    ['outward frame', (m: any) => { m.station.quaternion = [0, 0, 0, 1] }, 'point inward'],
    ['nonuniform scale', (m: any) => { m.station.scale = [1, 2, 1] }, 'uniform scale'],
    ['lateral drift', (m: any) => { m.station.motion.driftAmplitude = [.1, 0, 0] }, 'zero lateral drift'],
    ['nonaxial spin', (m: any) => { m.station.motion.spinAxis = [1, 1, 0] }, 'local Y'],
    ['disabled facing', (m: any) => { m.station.motion.facePlanetCenter = false }, 'face planet center'],
    ['zero orbit speed', (m: any) => { m.station.motion.orbit.radiansPerSecond = 0 }, 'orbit speed']
  ])('rejects invalid orbital %s before reparenting', (_label, corrupt, message) => {
    const { manifest } = fixture(true)
    const source = new THREE.Group()
    const planet = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial())
    const station = new THREE.Group()
    source.add(planet, station)
    corrupt(manifest)
    expect(() => createPlanetStationMotion(manifest, planet, station)).toThrow(message)
    expect(source.children).toEqual([planet, station])
  })

  it('adopts each source exactly once and preserves the exact authored zero pose', () => {
    const { manifest, planet, stationRoot, originalRootMatrix, prototypeScene, motion } = fixture()
    expect(motion.root.children).toEqual([motion.planet, motion.station])
    expect(motion.planet.children).toEqual([planet])
    expect(motion.station.children).toEqual([stationRoot])
    expect(prototypeScene.children).toHaveLength(0)
    expect(planet.matrixWorld.elements).toEqual(matrixFor(manifest.planet).elements)
    expect(motion.planet.position.toArray()).toEqual(manifest.planet.position)
    expect(planet.position.toArray()).toEqual([0, 0, 0])
    expect(planet.quaternion.toArray()).toEqual(manifest.planet.quaternion)
    expect(planet.scale.toArray()).toEqual(manifest.planet.scale)
    expect(motion.station.matrix.elements).toEqual(matrixFor(manifest.station).elements)
    expect(stationRoot.matrix.elements).toEqual(originalRootMatrix.elements)
    expect(stationRoot.matrixWorld.elements).toEqual(matrixFor(manifest.station).multiply(originalRootMatrix).elements)
  })

  it('does not move or rotate any part of the station when only the planet is dragged', () => {
    const { motion, planet, stationRoot, manifest } = fixture()
    motion.apply({ yaw: .2, pitch: .1, orbit: 3 })
    const before = worldMatrices(motion.root)
    motion.apply({ yaw: 1.8, pitch: -.4, orbit: 3 })
    motion.root.updateMatrixWorld(true)
    expect(planet.matrixWorld.elements).not.toEqual(before.get(planet))
    expect(new THREE.Vector3().setFromMatrixPosition(planet.matrixWorld).toArray()).toEqual(manifest.planet.position)
    stationRoot.traverse(node => expect(node.matrixWorld.elements).toEqual(before.get(node)))
    expect(motion.station.matrixWorld.elements).toEqual(before.get(motion.station))
  })

  it('preserves matrix-authored glTF locals while refreshing a matrix-locked planet prototype', () => {
    const { manifest } = fixture()
    const planet = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    planet.position.set(10, 20, 30)
    planet.updateMatrix()
    planet.matrixAutoUpdate = false
    const stationRoot = new THREE.Group()
    stationRoot.matrixAutoUpdate = false
    stationRoot.matrix.makeRotationX(.6).setPosition(1, 2, 3)
    const authored = stationRoot.matrix.clone()
    const motion = createPlanetStationMotion(manifest, planet, stationRoot)
    motion.root.updateMatrixWorld(true)
    expect(planet.matrixWorld.elements).toEqual(matrixFor(manifest.planet).elements)
    expect(stationRoot.matrix.elements).toEqual(authored.elements)
    expect(stationRoot.matrixWorld.elements).toEqual(matrixFor(manifest.station).multiply(authored).elements)
    motion.apply({ yaw: .4, pitch: .2, orbit: 12 })
    motion.root.updateMatrixWorld(true)
    expect(stationRoot.matrix.elements).toEqual(authored.elements)
    expect(stationRoot.matrixAutoUpdate).toBe(false)
    expect(planet.matrixAutoUpdate).toBe(false)
  })

  it('moves after five seconds and keeps moving while the planet is held', () => {
    const { motion, manifest, planet } = fixture()
    const initialStation = motion.station.matrixWorld.clone()
    motion.apply({ yaw: .8, pitch: -.2, orbit: 5 * .24 })
    motion.root.updateMatrixWorld(true)
    expect(motion.station.matrixWorld.elements).not.toEqual(initialStation.elements)
    expect(motion.station.quaternion.angleTo(new THREE.Quaternion().fromArray(manifest.station.quaternion))).toBeCloseTo(5 * .018, 12)
    const heldPlanet = planet.matrixWorld.clone()
    const stationAtFive = motion.station.matrixWorld.clone()
    motion.apply({ yaw: .8, pitch: -.2, orbit: 11 * .24 })
    motion.root.updateMatrixWorld(true)
    expect(planet.matrixWorld.elements).toEqual(heldPlanet.elements)
    expect(motion.station.matrixWorld.elements).not.toEqual(stationAtFive.elements)
    expect(motion.station.position.toArray()).not.toEqual(manifest.station.position)
  })

  it('rotates the whole station around its authored local mast axis at the exported speed', () => {
    const { motion, manifest } = fixture()
    manifest.station.motion.spinRadiansPerSecond = .9 // Active state is an immutable snapshot.
    const authored = new THREE.Quaternion().fromArray(manifest.station.quaternion)
    const beforeAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(authored)
    for (const seconds of [5, 11, 100, -20]) {
      motion.apply({ ...zero, orbit: seconds * .24 })
      const expected = authored.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seconds * .018))
      expect(motion.station.quaternion.angleTo(expected)).toBeLessThan(1e-7)
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(motion.station.quaternion).distanceTo(beforeAxis)).toBeLessThan(1e-12)
    }
  })

  it('never moves internal ring pivots or utility/spoke attachments relative to one another', () => {
    const { motion, stationRoot } = fixture()
    const authoredLocals = localMatrices(stationRoot)
    const inverseStation = motion.station.matrixWorld.clone().invert()
    const relative = new Map<THREE.Object3D, THREE.Matrix4>()
    stationRoot.traverse(node => relative.set(node, inverseStation.clone().multiply(node.matrixWorld)))
    for (const seconds of [5, 30, 1000, -400, 100000]) {
      motion.apply({ yaw: seconds * .01, pitch: -.3, orbit: seconds * .24 })
      motion.root.updateMatrixWorld(true)
      inverseStation.copy(motion.station.matrixWorld).invert()
      stationRoot.traverse(node => {
        expect(node.matrix.elements).toEqual(authoredLocals.get(node))
        expectMatricesClose(inverseStation.clone().multiply(node.matrixWorld), relative.get(node)!)
      })
    }
  })

  it('bounds drift on every axis across negative, long-running and extreme finite clock values', () => {
    const { motion, manifest } = fixture()
    const times = [0, -0, Number.MAX_VALUE, -Number.MAX_VALUE, 1e20, -1e20]
    for (let index = -2000; index <= 2000; index++) times.push(index * 21.713)
    for (const orbit of times) {
      motion.apply({ ...zero, orbit })
      motion.station.position.toArray().forEach((value, axis) => {
        expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(value - manifest.station.position[axis])).toBeLessThanOrEqual(manifest.station.motion.driftAmplitude[axis] + 1e-14)
      })
      expect(motion.station.quaternion.toArray().every(Number.isFinite)).toBe(true)
      expect(motion.station.scale.toArray()).toEqual(manifest.station.scale)
    }
    motion.apply(zero)
    expect(motion.station.position.toArray()).toEqual(manifest.station.position)
    expect(motion.station.quaternion.toArray()).toEqual(manifest.station.quaternion)
  })

  it('is deterministic for repeated frames, time jumps and exact reset', () => {
    const { motion } = fixture()
    const initial = worldMatrices(motion.root)
    const pose = { yaw: 2.1, pitch: -.7, orbit: 2.3 }
    motion.apply(pose)
    const first = worldMatrices(motion.root)
    for (const intermediate of [pose, { yaw: -1, pitch: .3, orbit: 1e20 }, zero]) {
      motion.apply(intermediate)
      motion.apply(pose)
      for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(first.get(node))
    }
    motion.apply(zero)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(initial.get(node))
    const fresh = fixture()
    fresh.motion.apply(pose)
    fresh.motion.root.updateMatrixWorld(true)
    expect(fresh.motion.planet.matrixWorld.elements).toEqual(first.get(motion.planet))
    expect(fresh.motion.station.matrixWorld.elements).toEqual(first.get(motion.station))
  })

  it('reuses every object and resource without cloning during animation', () => {
    const { motion, planet, stationRoot } = fixture()
    const nodes: THREE.Object3D[] = []
    motion.root.traverse(node => nodes.push(node))
    const children = nodes.map(node => node.children)
    const positions = nodes.map(node => node.position)
    const rotations = nodes.map(node => node.quaternion)
    const meshClone = vi.spyOn(THREE.Mesh.prototype, 'clone')
    const geometryClone = vi.spyOn(THREE.BufferGeometry.prototype, 'clone')
    const materialClone = vi.spyOn(THREE.Material.prototype, 'clone')
    for (let frame = 1; frame <= 120; frame++) motion.apply({ yaw: frame * .001, pitch: .2, orbit: frame * .004 })
    expect(meshClone).not.toHaveBeenCalled()
    expect(geometryClone).not.toHaveBeenCalled()
    expect(materialClone).not.toHaveBeenCalled()
    nodes.forEach((node, index) => {
      expect(node.children).toBe(children[index])
      expect(node.position).toBe(positions[index])
      expect(node.quaternion).toBe(rotations[index])
    })
    const after: THREE.Object3D[] = []
    motion.root.traverse(node => after.push(node))
    expect(after).toEqual(nodes)
    expect(motion.planet.children[0]).toBe(planet)
    expect(motion.station.children[0]).toBe(stationRoot)
  })

  it('hides idempotently without disposing shared resources or breaking scene-owner traversal', () => {
    const { motion } = fixture()
    const scene = new THREE.Scene()
    scene.add(motion.root)
    const before = worldMatrices(motion.root)
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose')
    motion.dispose()
    motion.dispose()
    motion.apply({ yaw: 1, pitch: 1, orbit: 10 })
    motion.apply({ yaw: NaN, pitch: Infinity, orbit: -Infinity })
    expect(geometryDispose).not.toHaveBeenCalled()
    expect(materialDispose).not.toHaveBeenCalled()
    expect(motion.root.visible).toBe(false)
    expect(motion.root.parent).toBe(scene)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(before.get(node))
    const sceneNodes: THREE.Object3D[] = []
    scene.traverse(node => sceneNodes.push(node))
    expect(sceneNodes).toHaveLength(before.size + 1)
  })

  it('rejects invalid poses atomically without changing either object', () => {
    const { motion } = fixture()
    const before = worldMatrices(motion.root)
    for (const key of ['yaw', 'pitch', 'orbit']) {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() => motion.apply({ ...zero, [key]: value })).toThrow('finite yaw, pitch and orbit')
        for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(before.get(node))
      }
    }
  })

  it.each([
    ['coordinate system', (m: any) => { m.coordinateSystem = 'blender-z-up' }, 'three-y-up'],
    ['missing planet', (m: any) => { delete m.planet }, 'planet transform'],
    ['missing station', (m: any) => { delete m.station }, 'station transform'],
    ['missing prototype', (m: any) => { m.planet.prototype = '' }, 'planet mesh prototype'],
    ['position NaN', (m: any) => { m.planet.position = [NaN, 0, 0] }, 'planet position'],
    ['position sparse tuple', (m: any) => { m.planet.position = Array(3) }, 'planet position'],
    ['wrong tuple size', (m: any) => { m.station.position = [1, 2] }, 'station position'],
    ['quaternion infinity', (m: any) => { m.station.quaternion = [0, 0, Infinity, 1] }, 'station quaternion'],
    ['quaternion zero', (m: any) => { m.planet.quaternion = [0, 0, 0, 0] }, 'unit length'],
    ['quaternion non-unit', (m: any) => { m.station.quaternion = [1, 2, 3, 4] }, 'unit length'],
    ['scale negative', (m: any) => { m.station.scale = [1, -1, 1] }, 'positive values'],
    ['scale zero', (m: any) => { m.planet.scale = [0, 1, 1] }, 'positive values'],
    ['missing motion', (m: any) => { delete m.station.motion }, 'motion settings'],
    ['axis zero', (m: any) => { m.station.motion.spinAxis = [0, 0, 0] }, 'spin axis'],
    ['axis infinity', (m: any) => { m.station.motion.spinAxis = [0, Infinity, 0] }, 'spin axis'],
    ['drift negative', (m: any) => { m.station.motion.driftAmplitude = [-.1, 0, 0] }, 'nonnegative values'],
    ['drift NaN', (m: any) => { m.station.motion.driftAmplitude = [NaN, 0, 0] }, 'drift amplitude'],
    ['speed infinity', (m: any) => { m.station.motion.spinRadiansPerSecond = Infinity }, 'motion speeds'],
    ['speed negative', (m: any) => { m.station.motion.driftRadiansPerSecond = -.1 }, 'motion speeds']
  ])('rejects %s before changing the source hierarchy', (_label, corrupt, error) => {
    const { manifest } = fixture()
    const source = new THREE.Group()
    const planet = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const station = new THREE.Group()
    source.add(planet, station)
    const before = localMatrices(source)
    corrupt(manifest)
    expect(() => createPlanetStationMotion(manifest, planet, station)).toThrow(error)
    expect(source.children).toEqual([planet, station])
    for (const [node, matrix] of localMatrices(source)) expect(matrix).toEqual(before.get(node))
  })

  it('rejects invalid objects and source hierarchies instead of removing pieces from the station rig', () => {
    const { manifest } = fixture()
    expect(() => createPlanetStationMotion(manifest, new THREE.Group() as unknown as THREE.Mesh, new THREE.Group())).toThrow('planet mesh prototype')
    const planet = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    expect(() => createPlanetStationMotion(manifest, planet, null as unknown as THREE.Object3D)).toThrow('station glTF root')
    const station = new THREE.Group()
    station.add(planet)
    expect(() => createPlanetStationMotion(manifest, planet, station)).toThrow('independent source objects')
    expect(station.children).toEqual([planet])
  })

  it('honors zero motion rates and a non-unit axis without changing the authored station pose', () => {
    const { manifest } = fixture()
    manifest.station.motion.spinAxis = [0, 7, 0]
    manifest.station.motion.spinRadiansPerSecond = 0
    manifest.station.motion.driftRadiansPerSecond = 0
    const motion = createPlanetStationMotion(manifest, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), new THREE.Group())
    motion.apply({ yaw: 1, pitch: .2, orbit: Number.MAX_VALUE })
    expect(motion.station.position.toArray()).toEqual(manifest.station.position)
    expect(motion.station.quaternion.toArray()).toEqual(manifest.station.quaternion)
  })

  it('normalizes a subnormal finite axis and handles extreme finite motion speeds', () => {
    const { manifest } = fixture()
    manifest.station.motion.spinAxis = [0, Number.MIN_VALUE, 0]
    manifest.station.motion.spinRadiansPerSecond = Number.MAX_VALUE
    manifest.station.motion.driftRadiansPerSecond = Number.MAX_VALUE
    const motion = createPlanetStationMotion(manifest, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), new THREE.Group())
    for (const orbit of [Number.MIN_VALUE, 1, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      motion.apply({ ...zero, orbit })
      expect(motion.station.quaternion.toArray().every(Number.isFinite)).toBe(true)
      expect(motion.station.quaternion.length()).toBeCloseTo(1, 12)
      expect(motion.station.position.toArray().every(Number.isFinite)).toBe(true)
    }
  })
})

describe('independent draggable station clock', () => {
  it('holds station placement and inward attitude exactly while the coherent rotor clock advances', () => {
    const { motion, rotor, manifest } = fixture(true, -1, true)
    const held = { yaw: .4, pitch: -.2, orbit: 3, stationOrbit: 11 }
    motion.apply(held)
    const position = motion.station.position.toArray()
    const attitude = motion.station.quaternion.toArray()
    const rotation = rotor!.quaternion.toArray()
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const radius = motion.station.position.distanceTo(center)
    for (const orbit of [3.1, 4, 9, 300]) {
      motion.apply({ ...held, orbit })
      expect(motion.station.position.toArray()).toEqual(position)
      expect(motion.station.quaternion.toArray()).toEqual(attitude)
      expect(rotor!.quaternion.toArray()).not.toEqual(rotation)
      expect(motion.station.position.distanceTo(center)).toBeCloseTo(radius, 12)
      expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(center.clone().sub(motion.station.position).normalize())).toBeCloseTo(1, 12)
    }
  })

  it('changes station clock with rotor held, retains compatibility when omitted, and resets both exactly', () => {
    const { motion, rotor } = fixture(true, -1, true)
    const initial = worldMatrices(motion.root)
    motion.apply({ ...zero, orbit: 9, stationOrbit: 4 })
    const rotorQuaternion = rotor!.quaternion.toArray()
    const before = motion.station.position.toArray()
    motion.apply({ ...zero, orbit: 9, stationOrbit: 7 })
    expect(motion.station.position.toArray()).not.toEqual(before)
    expect(rotor!.quaternion.toArray()).toEqual(rotorQuaternion)
    motion.apply({ ...zero, orbit: 9, stationOrbit: 9 })
    const explicit = worldMatrices(motion.root)
    motion.apply({ ...zero, orbit: 9 })
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(explicit.get(node))
    motion.apply({ ...zero, stationOrbit: 0 })
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(initial.get(node))
  })

  it('rejects an invalid station clock before changing any transforms', () => {
    const { motion } = fixture(true, -1, true)
    const before = worldMatrices(motion.root)
    for (const stationOrbit of [NaN, Infinity, -Infinity]) {
      expect(() => motion.apply({ yaw: 1, pitch: 2, orbit: 8, stationOrbit })).toThrow('stationOrbit')
      for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(before.get(node))
    }
  })
})

describe('world-frame station orbit manipulation', () => {
  it('updates a changed frame at an unchanged clock and preserves radius, inward mast and coherent orbit plane', () => {
    const { motion, manifest, rotor } = fixture(true, -1, true)
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const radius = motion.station.position.distanceTo(center)
    const normal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
    const pose = { yaw: .3, pitch: -.2, orbit: 12, stationOrbit: 4 }
    motion.apply(pose)
    const unrotatedPosition = motion.station.position.clone()
    const unrotatedAttitude = motion.station.quaternion.clone()
    const heldRotor = rotor!.quaternion.clone()
    for (const angles of [[.4, -.7, .2], [-1.3, .2, 2.1], [Math.PI, 0, 0]]) {
      const stationFrame = quaternion(...angles as [number, number, number])
      const frame = new THREE.Quaternion().fromArray(stationFrame)
      motion.apply({ ...pose, stationFrame })
      expect(motion.station.position.distanceTo(unrotatedPosition.clone().sub(center).applyQuaternion(frame).add(center))).toBeLessThan(1e-12)
      expect(motion.station.quaternion.angleTo(unrotatedAttitude.clone().premultiply(frame))).toBeLessThan(1e-7)
      expect(rotor!.quaternion.angleTo(heldRotor)).toBeLessThan(1e-7)
      const frameNormal = normal.clone().applyQuaternion(frame)
      const release = motion.station.position.clone()
      // First post-release step advances on the transported circular plane.
      for (const increment of [.012, 2, 10, 25]) {
        motion.apply({ ...pose, stationOrbit: pose.stationOrbit + increment, stationFrame })
        const radial = motion.station.position.clone().sub(center)
        expect(radial.length()).toBeCloseTo(radius, 11)
        expect(radial.dot(frameNormal)).toBeCloseTo(0, 11)
        expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(radial.normalize().negate())).toBeCloseTo(1, 11)
        if (increment === .012) expect(motion.station.position.distanceTo(release)).toBeCloseTo(2 * radius * Math.sin(.001), 11)
      }
    }
  })

  it('returns exactly to the unmodified orbit and authored zero pose with an absent or identity frame', () => {
    const { motion } = fixture(true, -1, true)
    const reset = worldMatrices(motion.root)
    const pose = { yaw: .2, pitch: -.1, orbit: 3, stationOrbit: 0 }
    motion.apply(pose)
    const originalZeroClock = worldMatrices(motion.root)
    for (const stationFrame of [undefined, [0, 0, 0, 1] as const]) {
      motion.apply({ ...pose, stationFrame: quaternion(.6, -.4, .9) })
      expect(motion.station.matrixWorld.elements).toEqual(originalZeroClock.get(motion.station)) // Matrix update remains scene-owned.
      motion.root.updateMatrixWorld(true)
      expect(motion.station.matrixWorld.elements).not.toEqual(originalZeroClock.get(motion.station))
      motion.apply({ ...pose, stationFrame })
      for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(originalZeroClock.get(node))
    }
    motion.apply({ ...pose, stationOrbit: 7, stationFrame: quaternion(.6, -.4, .9) })
    motion.apply(zero)
    for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(reset.get(node))
  })

  it('rejects invalid frame tuples before changing planet, station or rotor state', () => {
    const { motion } = fixture(true, -1, true)
    motion.apply({ ...zero, orbit: 5, stationFrame: quaternion(.4, -.3, .2) })
    const before = worldMatrices(motion.root)
    for (const stationFrame of [[NaN, 0, 0, 1], [0, Infinity, 0, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 1], Array(4)]) {
      expect(() => motion.apply({ yaw: 1, pitch: 1, orbit: 12, stationFrame: stationFrame as unknown as PlanetStationQuaternion })).toThrow('station frame')
      for (const [node, matrix] of worldMatrices(motion.root)) expect(matrix).toEqual(before.get(node))
    }
  })
})

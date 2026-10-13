import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createPlanetStationMotion, type PlanetStationMotionManifest, type PlanetStationTransform } from '../src/station-motion'
import type { LunarModelManifest } from '../src/lunar-scene'
import { createStationDrag } from '../src/station-drag'
import { defaultLunarView, type LunarView } from '../src/lunar-view'

afterEach(() => vi.unstubAllGlobals())

type Manifest = PlanetStationMotionManifest & {
  model: LunarModelManifest
  planet: PlanetStationMotionManifest['planet'] & { radius: number }
  station: PlanetStationMotionManifest['station'] & {
    model: LunarModelManifest
    geometry: { triangles: number; meshes: number; materials: number; boundsMin: number[]; boundsMax: number[] }
    annularPivots: Array<{ name: string; axis: number[]; origin: number[]; animated: boolean }>
  }
  textureSource: { dimensions: number[]; bytes: number; sha256: string }
  asteroids?: unknown[]
  prototypes?: unknown[]
  belt?: unknown
  background: string
  fallback: string
}

const base = 'public/media/cinematic/'
const readManifest = () => JSON.parse(readFileSync(`${base}scene.json`, 'utf8')) as Manifest
const zero = { yaw: 0, pitch: 0, orbit: 0 }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const textureHash = 'ac70232759343add6010a74618390d1bbd64e4e1ff7ff651c65c5578e758a10a'

function readModelBytes(model: LunarModelManifest) {
  expect(model.files.length).toBeGreaterThan(0)
  const bytes = Buffer.concat(model.files.map(file => {
    expect(file.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
    const part = readFileSync(base + file.name)
    expect(part.length).toBe(file.bytes)
    expect(part.length).toBeLessThanOrEqual(20 * 1024 * 1024)
    expect(sha256(part)).toBe(file.sha256)
    return part
  }))
  expect(bytes.length).toBe(model.bytes)
  expect(sha256(bytes)).toBe(model.sha256)
  return bytes
}

function parseGlb(bytes: Buffer) {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67)
  expect(bytes.readUInt32LE(4)).toBe(2)
  expect(bytes.readUInt32LE(8)).toBe(bytes.length)
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a)
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString())
  const binStart = 20 + jsonLength + 8
  expect(bytes.readUInt32LE(binStart - 4)).toBe(0x004e4942)
  return { json, binStart }
}

function matrixFor(transform: PlanetStationTransform) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(transform.position),
    new THREE.Quaternion().fromArray(transform.quaternion),
    new THREE.Vector3().fromArray(transform.scale)
  )
}

function expectMatrix(actual: THREE.Matrix4, expected: THREE.Matrix4) {
  const error = actual.elements.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - expected.elements[i])), 0)
  expect(error).toBeLessThan(5e-11)
}

function rotationOf(matrix: THREE.Matrix4) {
  const rotation = new THREE.Quaternion()
  matrix.decompose(new THREE.Vector3(), rotation, new THREE.Vector3())
  return rotation.normalize()
}

async function loadActualModels() {
  // Node has no image decoder/browser progress globals. Geometry, GLTF parsing,
  // materials, hierarchy and motion are real; only embedded PNG decoding is stubbed.
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(180706567)
    return { width: 15360, height: 7680, close() {} }
  }))
  vi.stubGlobal('ProgressEvent', class extends Event { loaded = 0; total = 0 })
  const manifest = readManifest()
  const planetGltf = await new GLTFLoader().parseAsync(Uint8Array.from(readModelBytes(manifest.model)).buffer, '')
  const stationGltf = await new GLTFLoader().parseAsync(Uint8Array.from(readModelBytes(manifest.station.model)).buffer, '')
  const planet = planetGltf.scene.getObjectByName(manifest.planet.prototype) as THREE.Mesh
  expect(planet).toBeInstanceOf(THREE.Mesh)
  stationGltf.scene.updateMatrixWorld(true)
  const stationMeshes: THREE.Mesh[] = []
  stationGltf.scene.traverse(object => { if (object instanceof THREE.Mesh) stationMeshes.push(object) })
  return { manifest, planet, stationRoot: stationGltf.scene, stationMeshes }
}

function disposeModels(...roots: THREE.Object3D[]) {
  const resources = new Set<{ dispose: () => void }>()
  roots.forEach(root => root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    resources.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      resources.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value)
    }
  }))
  resources.forEach(resource => resource.dispose())
}

describe('final planet and approved station export integration', () => {
  it('ships only the unchanged smooth planet geometry and verbatim original 15360 × 7680 PNG', () => {
    const manifest = readManifest()
    const bytes = readModelBytes(manifest.model)
    const { json, binStart } = parseGlb(bytes)
    expect(bytes.length).toBe(181207568)
    expect(sha256(bytes)).toBe('1522f5617420faf22cf1558d40e6a3dd8f8d525e3246bac1a9861db3919e46b9')
    const before = JSON.parse(readFileSync('tests/fixtures/baseline-planet-gltf.json', 'utf8'))
    for (const key of Object.keys(before).filter(key => !['buffers', 'bufferViews'].includes(key))) {
      expect(json[key], `Unchanged glTF ${key}`).toEqual(before[key])
    }
    expect(json.meshes).toHaveLength(1)
    expect(json.nodes).toHaveLength(1)
    expect(json.nodes[0].name).toBe('Planet_Core')
    expect(json.materials).toHaveLength(1)
    expect(json.images).toHaveLength(1)
    expect(json.materials.some((material: { name: string }) => /asteroid|rock/i.test(material.name))).toBe(false)
    expect(manifest.asteroids ?? []).toEqual([])
    expect(manifest.prototypes ?? []).toEqual([])
    expect(manifest.belt).toBeUndefined()
    expect(json.nodes[0].translation ?? [0, 0, 0]).toEqual([0, 0, 0])
    expect(json.nodes[0].rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1])
    expect(json.nodes[0].scale ?? [1, 1, 1]).toEqual([1, 1, 1])
    const mesh = json.meshes[json.nodes[0].mesh]
    expect(mesh.primitives).toHaveLength(1)
    expect(json.accessors[mesh.primitives[0].indices].count / 3).toBe(16128)
    const material = json.materials[mesh.primitives[0].material]
    const image = json.images[json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source]
    expect(image.mimeType).toBe('image/png')
    expect(image.uri).toBeUndefined()
    expect(material.normalTexture).toBeUndefined()
    const view = json.bufferViews[image.bufferView]
    const imageOffset = binStart + (view.byteOffset ?? 0)
    expect(bytes.subarray(imageOffset, imageOffset + 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(bytes.readUInt32BE(imageOffset + 16)).toBe(15360)
    expect(bytes.readUInt32BE(imageOffset + 20)).toBe(7680)
    expect(view.byteLength).toBe(180706567)
    expect(sha256(bytes.subarray(imageOffset, imageOffset + view.byteLength))).toBe(textureHash)
    expect(manifest.textureSource.dimensions).toEqual([15360, 7680])
    expect(manifest.textureSource.bytes).toBe(180706567)
    expect(manifest.textureSource.sha256).toBe(textureHash)

    // Original pre-integration geometry hashes independently lock positions, normals,
    // UVs, tangents and indices; the sixth hash locks the new native 16K texture.
    const originalViews = [
      '3d959bb9b58d1505d263e24f036c7dcdcaeb397619f87489a63c3047307c8f5b',
      'af5499f84eed458fc8a779cf84f17fff264b8d1678f25e770c1e6b9b2c60a8e9',
      'd354fa58beaf2b864b08177bbb6153ebeb5940f5344b684a16c1c963586e2e25',
      'f7cd738d13636c788230e6d0c0a7e6ff53b64a1d19961c3d79981a8aba4e35c4',
      '071c0176f9f23c35900ce77f36f87b9e4db44ac488cd77effa733d22075ffad7',
      textureHash
    ]
    expect(json.bufferViews).toHaveLength(originalViews.length)
    json.bufferViews.forEach((view: { byteOffset?: number; byteLength: number }, i: number) => {
      const start = binStart + (view.byteOffset ?? 0)
      expect(sha256(bytes.subarray(start, start + view.byteLength))).toBe(originalViews[i])
    })
    const accessor = json.accessors[mesh.primitives[0].attributes.POSITION]
    const positionView = json.bufferViews[accessor.bufferView]
    const offset = binStart + (positionView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    let minRadius = Infinity, maxRadius = 0
    for (let i = 0; i < accessor.count; i++) {
      const at = offset + i * (positionView.byteStride ?? 12)
      const radius = Math.hypot(bytes.readFloatLE(at), bytes.readFloatLE(at + 4), bytes.readFloatLE(at + 8))
      minRadius = Math.min(minRadius, radius)
      maxRadius = Math.max(maxRadius, radius)
    }
    expect(accessor.count).toBe(8383)
    expect(maxRadius - minRadius).toBeLessThan(.00002)
    expect(maxRadius).toBeCloseTo(5.05, 5)
    expect(sha256(readFileSync(base + manifest.background))).toBe('94cba4cd8e76dcc09754ce3953ab7ee26071d655537c3ed053c92d6991059c47')
    expect(readFileSync(base + manifest.fallback).length).toBeGreaterThan(1000)
  })

  it('ships the coherent 429,760-triangle rotor and fixed hub rig with 66 meshes and 13 materials', () => {
    const manifest = readManifest()
    const bytes = readModelBytes(manifest.station.model)
    const { json } = parseGlb(bytes)
    expect(bytes.length).toBe(21630136)
    // Final export includes the complete station and its independent bearing rig.
    expect(sha256(bytes)).toBe('8ebabb6f21116ed375971a446ea5d62be0d34ad6fd1a04f98360e4f375e6c820')
    expect(json.meshes).toHaveLength(66)
    expect(json.materials).toHaveLength(13)
    expect(json.images ?? []).toHaveLength(0)
    expect(json.textures ?? []).toHaveLength(0)
    expect(json.animations ?? []).toHaveLength(0)
    const triangles = json.meshes.reduce((total: number, mesh: { primitives: Array<{ indices: number; mode?: number }> }) => total + mesh.primitives.reduce((sum, primitive) => {
      expect(primitive.mode ?? 4).toBe(4)
      return sum + json.accessors[primitive.indices].count / 3
    }, 0), 0)
    expect(triangles).toBe(429760)
    expect(manifest.station.geometry.triangles).toBe(triangles)
    expect(manifest.station.geometry.meshes).toBe(66)
    expect(manifest.station.geometry.materials).toBe(13)
    const rotorIndex = json.nodes.findIndex((node: { name: string }) => node.name === 'Ring_Rotor')
    const fixedIndex = json.nodes.findIndex((node: { name: string }) => node.name === 'Station_Fixed')
    expect(rotorIndex).toBeGreaterThanOrEqual(0)
    expect(fixedIndex).toBeGreaterThanOrEqual(0)
    expect(json.scenes[json.scene ?? 0].nodes).toEqual([rotorIndex, fixedIndex])
    const descendants = (rootIndex: number) => {
      const result = new Set<number>()
      const visit = (index: number) => {
        expect(result.has(index)).toBe(false)
        result.add(index)
        for (const child of json.nodes[index].children ?? []) visit(child)
      }
      visit(rootIndex)
      return result
    }
    const moving = descendants(rotorIndex)
    const fixed = descendants(fixedIndex)
    expect([...moving].some(index => fixed.has(index))).toBe(false)
    expect(moving.size + fixed.size).toBe(json.nodes.length)
    for (const index of [rotorIndex, fixedIndex]) {
      const node = json.nodes[index]
      expect(node.translation ?? [0, 0, 0]).toEqual([0, 0, 0])
      expect(node.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1])
      expect(node.scale ?? [1, 1, 1]).toEqual([1, 1, 1])
    }
    for (const prefix of ['01 |', '02 |', '03 |', '04 |', '05 |', '07 |', '09 |']) {
      expect([...moving].some(index => json.nodes[index].name.startsWith(prefix)), prefix).toBe(true)
      expect([...fixed].some(index => json.nodes[index].name.startsWith(prefix)), prefix).toBe(false)
    }
    for (const prefix of ['06 |', '08 |']) {
      expect([...fixed].some(index => json.nodes[index].name.startsWith(prefix)), prefix).toBe(true)
      expect([...moving].some(index => json.nodes[index].name.startsWith(prefix)), prefix).toBe(false)
    }
    expect(manifest.station.annularPivots).toHaveLength(4)
    for (const pivot of manifest.station.annularPivots) {
      const node = json.nodes.find((node: { name: string }) => node.name === pivot.name)
      expect(node, pivot.name).toBeDefined()
      expect(node.children.length).toBeGreaterThan(0)
      expect(pivot.axis).toEqual([0, 1, 0])
      expect(pivot.origin).toEqual([0, 0, 0])
      expect(pivot.animated).toBe(false)
      expect(moving.has(json.nodes.indexOf(node))).toBe(true)
    }
  })

  it('parses both actual GLBs and spins only the coherent rotor while the fixed hub, orbit and planet drag stay independent', async () => {
    const { manifest, planet, stationRoot, stationMeshes } = await loadActualModels()
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(stationMeshes).toHaveLength(manifest.station.geometry.meshes)
    expect(planet.material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect((planet.material as THREE.MeshStandardMaterial).map).toBeInstanceOf(THREE.Texture)
    expect((planet.material as THREE.MeshStandardMaterial).map!.image.width).toBe(15360)
    const rotor = stationRoot.getObjectByName('Ring_Rotor')!
    const fixed = stationRoot.getObjectByName('Station_Fixed')!
    expect(rotor).toBeDefined()
    expect(fixed).toBeDefined()
    expect(rotor.parent).toBe(stationRoot)
    expect(fixed.parent).toBe(stationRoot)
    const rotorParts = new Set<THREE.Object3D>()
    rotor.traverse(object => rotorParts.add(object))
    const materials = new Set<THREE.Material>()
    const originalLocal = new Map<THREE.Object3D, THREE.Matrix4>()
    const originalWorld = new Map<THREE.Object3D, THREE.Matrix4>()
    const originalParents = new Map<THREE.Object3D, THREE.Object3D | null>()
    const originalResources = new Map<THREE.Mesh, [THREE.BufferGeometry, THREE.Material | THREE.Material[]]>()
    stationRoot.traverse(object => {
      originalLocal.set(object, object.matrix.clone())
      originalWorld.set(object, object.matrixWorld.clone())
      originalParents.set(object, object.parent)
      if (object instanceof THREE.Mesh) {
        originalResources.set(object, [object.geometry, object.material])
        expect(object.geometry.getAttribute('normal').count).toBeGreaterThan(0)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          expect(material).toBeInstanceOf(THREE.MeshStandardMaterial)
          expect((material as THREE.MeshStandardMaterial).map).toBeNull()
          expect((material as THREE.MeshStandardMaterial).normalMap).toBeNull()
          materials.add(material)
        }
      }
    })
    expect(materials.size).toBe(13)
    for (const pivot of manifest.station.annularPivots) {
      const node = stationRoot.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(pivot.name))!
      expect(node, pivot.name).toBeDefined()
      expect(rotorParts.has(node), pivot.name).toBe(true)
    }
    const motion = createPlanetStationMotion(manifest, planet, stationRoot)
    expect(motion.rotor).toBe(rotor)
    expect(motion.root.children).toEqual([motion.planet, motion.station])
    expect(motion.station.children).toEqual([stationRoot])
    expect(motion.planet.children).toEqual([planet])
    motion.root.updateMatrixWorld(true)
    expectMatrix(planet.matrixWorld, matrixFor(manifest.planet))
    expect(motion.station.matrixWorld.elements).toEqual(matrixFor(manifest.station).elements)
    for (const [object, authored] of originalWorld) expectMatrix(object.matrixWorld, matrixFor(manifest.station).multiply(authored))
    const stationRest = stationRoot.matrixWorld.clone()
    const initialWorld = new Map<THREE.Object3D, number[]>()
    motion.root.traverse(object => initialWorld.set(object, object.matrixWorld.elements.slice()))
    motion.apply({ yaw: .9, pitch: -.3, orbit: 0 })
    motion.root.updateMatrixWorld(true)
    expect(rotationOf(planet.matrixWorld).angleTo(rotationOf(matrixFor(manifest.planet)))).toBeGreaterThan(.8)
    expect(stationRoot.matrixWorld.elements).toEqual(stationRest.elements)
    const draggedPlanet = planet.matrixWorld.clone()
    const orbitSettings = manifest.station.motion.orbit!
    const rotorSettings = manifest.station.rotor!
    expect(manifest.station.motion.facePlanetCenter).toBe(true)
    expect(manifest.station.motion.spinRadiansPerSecond).toBe(0)
    expect(orbitSettings.radiansPerSecond).toBe(.04)
    expect(rotorSettings).toMatchObject({ nodeName: 'Ring_Rotor', axis: [0, 1, 0], radiansPerSecond: .1 })
    const normal = new THREE.Vector3().fromArray(orbitSettings.normal)
    const authoredStation = new THREE.Quaternion().fromArray(manifest.station.quaternion)
    const stationInverse = new THREE.Matrix4()
    const expectedRotorMatrix = new THREE.Matrix4()
    const checkRig = (seconds: number) => {
      const expectedStation = new THREE.Quaternion().setFromAxisAngle(normal, seconds * orbitSettings.radiansPerSecond).multiply(authoredStation)
      expect(motion.station.quaternion.angleTo(expectedStation)).toBeLessThan(1e-7)
      stationInverse.copy(motion.station.matrixWorld).invert()
      expectedRotorMatrix.makeRotationY(seconds * rotorSettings.radiansPerSecond)
      for (const [object, local] of originalLocal) {
        if (object !== rotor) expect(object.matrix.elements).toEqual(local.elements)
        if (object !== stationRoot) expect(object.parent).toBe(originalParents.get(object))
        const expected = originalWorld.get(object)!.clone()
        if (rotorParts.has(object)) expected.premultiply(expectedRotorMatrix)
        expectMatrix(stationInverse.clone().multiply(object.matrixWorld), expected)
        if (object instanceof THREE.Mesh) {
          expect(object.geometry).toBe(originalResources.get(object)![0])
          expect(object.material).toBe(originalResources.get(object)![1])
        }
      }
      expect(planet.matrixWorld.elements).toEqual(draggedPlanet.elements)
    }
    let atFive: THREE.Matrix4 | undefined
    let ringAtFive: THREE.Matrix4 | undefined
    for (const seconds of [5, 12, Math.PI * 2 / rotorSettings.radiansPerSecond]) {
      motion.apply({ yaw: .9, pitch: -.3, orbit: seconds * .24 })
      motion.root.updateMatrixWorld(true)
      checkRig(seconds)
      const rotorRelative = motion.station.matrixWorld.clone().invert().multiply(rotor.matrixWorld)
      if (seconds === 5) {
        atFive = stationRoot.matrixWorld.clone()
        ringAtFive = rotorRelative.clone()
        expect(rotorRelative.elements).not.toEqual(originalWorld.get(rotor)!.elements)
      } else if (seconds === 12) {
        expect(rotorRelative.elements).not.toEqual(ringAtFive!.elements)
        expect(new THREE.Vector3().setFromMatrixPosition(stationRoot.matrixWorld).distanceTo(new THREE.Vector3().setFromMatrixPosition(atFive!))).toBeGreaterThan(.001)
      } else {
        for (const object of rotorParts) expectMatrix(motion.station.matrixWorld.clone().invert().multiply(object.matrixWorld), originalWorld.get(object)!)
      }
    }
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const initialOffset = new THREE.Vector3().fromArray(manifest.station.position).sub(center)
    const radius = initialOffset.length()
    expect(radius).toBeCloseTo(9.9, 10)
    const frontBack: number[] = []
    for (let phaseIndex = 0; phaseIndex <= 72; phaseIndex++) {
      const phase = phaseIndex * Math.PI * 2 / 72
      const seconds = phase / orbitSettings.radiansPerSecond
      motion.apply({ yaw: .9, pitch: -.3, orbit: seconds * .24 })
      motion.root.updateMatrixWorld(true)
      const offset = motion.station.position.clone().sub(center)
      expect(offset.length()).toBeCloseTo(radius, 10)
      expect(offset.dot(normal)).toBeCloseTo(0, 10)
      expect(manifest.station.motion.inwardAxis).toEqual([0, -1, 0])
      expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(offset.clone().normalize().negate())).toBeCloseTo(1, 10)
      checkRig(seconds)
      frontBack.push(offset.z)
      if (phaseIndex === 36) expect(offset.distanceTo(initialOffset.clone().negate())).toBeLessThan(1e-10)
    }
    expect(Math.min(...frontBack)).toBeLessThan(-radius * .5)
    expect(Math.max(...frontBack)).toBeGreaterThan(radius * .5)
    motion.apply(zero)
    motion.root.updateMatrixWorld(true)
    motion.root.traverse(object => expect(object.matrixWorld.elements).toEqual(initialWorld.get(object)))
    motion.dispose()
    expect(motion.root.visible).toBe(false)
    expect([...originalResources.keys()]).toHaveLength(stationMeshes.length)
    disposeModels(motion.root)
  })

  it('verifies every fixed and rotor triangle clears the planet throughout full revolution and independent ring spin', async () => {
    const { manifest, planet, stationRoot, stationMeshes } = await loadActualModels()
    const bounds = new THREE.Box3().setFromObject(stationRoot, true)
    bounds.min.toArray().forEach((value, i) => expect(value).toBeCloseTo(manifest.station.geometry.boundsMin[i], 5))
    bounds.max.toArray().forEach((value, i) => expect(value).toBeCloseTo(manifest.station.geometry.boundsMax[i], 5))
    expect(manifest.station.motion.spinRadiansPerSecond).toBe(0)
    expect(manifest.station.rotor!.axis).toEqual([0, 1, 0])
    // Both assemblies share an identity origin and an axial rotor, so the fixed
    // body never changes and rotor rotation preserves distance to the radial center.
    for (const name of ['Ring_Rotor', 'Station_Fixed']) {
      const assembly = stationRoot.getObjectByName(name)!
      expect(assembly.parent).toBe(stationRoot)
      expect(assembly.matrix.elements).toEqual(new THREE.Matrix4().elements)
    }
    const scale = manifest.station.scale[0]
    expect(manifest.station.scale).toEqual([scale, scale, scale])
    const planetInStation = new THREE.Vector3().fromArray(manifest.planet.position)
      .sub(new THREE.Vector3().fromArray(manifest.station.position))
      .applyQuaternion(new THREE.Quaternion().fromArray(manifest.station.quaternion).invert())
      .divideScalar(scale)
    const offAxisError = Math.hypot(planetInStation.x, planetInStation.z)
    expect(offAxisError).toBeLessThan(1e-6)
    // In the transported radial frame the spherical planet center stays on local Y.
    // Axial spin therefore leaves every triangle's center distance unchanged.
    const radialCenter = new THREE.Vector3(0, planetInStation.y, 0)
    expect(manifest.station.motion.facePlanetCenter).toBe(true)
    expect(manifest.station.motion.orbit).toBeDefined()
    expect(manifest.station.motion.driftAmplitude).toEqual([0, 0, 0])
    expect(manifest.station.motion.driftRadiansPerSecond).toBe(0)
    let sweptDistance = Infinity, triangles = 0, planetRadius = 0
    const planetPoint = new THREE.Vector3()
    const planetPositions = planet.geometry.getAttribute('position')
    for (let i = 0; i < planetPositions.count; i++) {
      planetPoint.fromBufferAttribute(planetPositions, i).multiply(new THREE.Vector3().fromArray(manifest.planet.scale))
      planetRadius = Math.max(planetRadius, planetPoint.length())
    }
    const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const triangle = new THREE.Triangle(...points as [THREE.Vector3, THREE.Vector3, THREE.Vector3])
    const closest = new THREE.Vector3()
    const edgeVector = new THREE.Vector3()
    const toCenter = new THREE.Vector3()
    for (const mesh of stationMeshes) {
      const positions = mesh.geometry.getAttribute('position')
      const index = mesh.geometry.getIndex()!
      for (let i = 0; i < index.count; i += 3) {
        for (let corner = 0; corner < 3; corner++) points[corner].fromBufferAttribute(positions, index.getX(i + corner)).applyMatrix4(mesh.matrixWorld)
        triangle.closestPointToPoint(radialCenter, closest)
        let distance = closest.distanceTo(radialCenter)
        // The approved export includes degenerate triangles. Their surface is
        // the union of their edges; Three's interior formula can divide by zero.
        if (!Number.isFinite(distance)) {
          distance = Infinity
          for (let edge = 0; edge < 3; edge++) {
            const a = points[edge], b = points[(edge + 1) % 3]
            edgeVector.subVectors(b, a)
            toCenter.subVectors(radialCenter, a)
            const lengthSquared = edgeVector.lengthSq()
            const t = lengthSquared === 0 ? 0 : THREE.MathUtils.clamp(toCenter.dot(edgeVector) / lengthSquared, 0, 1)
            closest.copy(a).addScaledVector(edgeVector, t)
            distance = Math.min(distance, closest.distanceTo(radialCenter))
          }
        }
        // Subtract only floating-point radial alignment error, conservatively.
        sweptDistance = Math.min(sweptDistance, (distance - offAxisError) * scale)
        triangles++
      }
    }
    expect(triangles).toBe(429760)
    expect(planetRadius).toBeCloseTo(manifest.planet.radius, 5)
    expect(planetInStation.y).toBeLessThan(0)
    expect(sweptDistance - planetRadius).toBeGreaterThan(.7)
    disposeModels(planet, stationRoot)
  })

  it('holds a user-dragged orbital phase without freezing the actual annular rig and resumes continuously', async () => {
    const { manifest, planet, stationRoot } = await loadActualModels()
    const motion = createPlanetStationMotion(manifest, planet, stationRoot)
    const center = new THREE.Vector3().fromArray(manifest.planet.position)
    const fixed = stationRoot.getObjectByName('Station_Fixed')!
    for (const stationOrbit of [0, 4, 12, 20, 30, -9]) {
      motion.apply({ yaw: .2, pitch: -.1, orbit: 40, stationOrbit })
      motion.root.updateMatrixWorld(true)
      const placement = motion.station.matrix.clone()
      const fixedWorld = fixed.matrixWorld.clone()
      const ringRotation = motion.rotor!.quaternion.clone()
      motion.apply({ yaw: .2, pitch: -.1, orbit: 40.24, stationOrbit })
      motion.root.updateMatrixWorld(true)
      expect(motion.station.matrix.elements).toEqual(placement.elements)
      expect(fixed.matrixWorld.elements).toEqual(fixedWorld.elements)
      expect(motion.rotor!.quaternion.angleTo(ringRotation)).toBeCloseTo(.1, 8)
      const beforeRelease = motion.station.position.clone()
      motion.apply({ yaw: .2, pitch: -.1, orbit: 40.252, stationOrbit: stationOrbit + .012 })
      const offset = motion.station.position.clone().sub(center)
      expect(offset.length()).toBeCloseTo(9.9, 8)
      expect(motion.station.position.distanceTo(beforeRelease)).toBeLessThan(.021)
      expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(offset.normalize().negate())).toBeCloseTo(1, 9)
    }
    motion.apply({ ...zero, stationOrbit: 0 })
    expect(motion.station.position.toArray()).toEqual(manifest.station.position)
    expect(motion.station.quaternion.toArray()).toEqual(manifest.station.quaternion)
    disposeModels(motion.root)
  })


  // Hashing/parsing the exact 181 MB model plus real triangle picking can exceed
  // the default five seconds when the complete suite runs concurrently.
  it('picks the real detailed station and follows both drag axes while tilting its orbit under zoom and pan', { timeout: 15_000 }, async () => {
    const { manifest, planet, stationRoot } = await loadActualModels()
    const cameraSpec = (manifest as typeof manifest & { camera: { position: number[]; target: number[]; fov: number; near: number; far: number } }).camera
    const motion = createPlanetStationMotion(manifest, planet, stationRoot)
    const camera = new THREE.PerspectiveCamera(cameraSpec.fov, 4 / 3, cameraSpec.near, cameraSpec.far)
    camera.position.fromArray(cameraSpec.position)
    camera.lookAt(new THREE.Vector3().fromArray(cameraSpec.target))
    const width = 1600, height = 1200
    const prepare = (pose: Parameters<typeof motion.apply>[0], view: LunarView) => {
      motion.apply(pose)
      camera.zoom = view.zoom
      camera.setViewOffset(width, height, -view.panX * width, -view.panY * height, width, height)
      camera.updateMatrixWorld(true)
      motion.root.updateMatrixWorld(true)
    }
    const interaction = createStationDrag({ manifest, motion, camera, prepare, viewport: () => ({ width, height }) })!
    expect(interaction).toBeDefined()
    const project = (world: THREE.Vector3) => {
      const v = world.clone().project(camera)
      return { x: v.x / 2, y: -v.y / 2 }
    }
    for (const view of [defaultLunarView(), { zoom: 2, panX: -.2, panY: -.1 }]) {
      const pose: Parameters<typeof motion.apply>[0] = { ...zero, stationOrbit: 0 }
      prepare(pose, view)
      // The annular origin contains the approved central hub, so this exercises
      // actual triangle hits in the 429,760-triangle GLB rather than a proxy mesh.
      const start = project(motion.station.position)
      expect(interaction.hitTest(start, pose, view)).toBe(true)
      expect(interaction.begin(start, pose, view)).toBe(true)
      const unchanged = interaction.move(start, pose, view)!
      expect(unchanged.stationOrbit).toBe(0)
      const center = new THREE.Vector3().fromArray(manifest.planet.position)
      const originalNormal = new THREE.Vector3().fromArray(manifest.station.motion.orbit!.normal)
      for (const [dx, dy] of [[0, -.005], [.004, -.005], [-.005, .004], [0, .005]]) {
        // Each short grab starts on the authored visible near side; full-sphere
        // front/back rolling has separate actual-depth regression coverage.
        Object.assign(pose, { ...zero, stationOrbit: 0, stationFrame: undefined })
        prepare(pose, view)
        expect(interaction.begin(start, pose, view)).toBe(true)
        const target = { x: start.x + dx, y: start.y + dy }
        const dragged = interaction.move(target, pose, view)!
        Object.assign(pose, dragged)
        prepare(pose, view)
        const actual = project(motion.station.position)
        const sx = actual.x - start.x, sy = actual.y - start.y
        expect(sx * dx + sy * dy).toBeGreaterThan(0)
        expect(Math.hypot(sx, sy)).toBeGreaterThan(.0001)
        if (dx === 0) expect(sy * dy).toBeGreaterThan(0)
        const offset = motion.station.position.clone().sub(center)
        expect(offset.length()).toBeCloseTo(9.9, 8)
        expect(new THREE.Vector3(0, -1, 0).applyQuaternion(motion.station.quaternion).dot(offset.clone().normalize().negate())).toBeCloseTo(1, 9)
        if (dx === 0) expect(Math.abs(offset.dot(originalNormal))).toBeGreaterThan(.01)
        interaction.end()
      }
      const released = motion.station.position.clone()
      prepare({ ...pose, stationOrbit: (pose.stationOrbit ?? 0) + .012 }, view)
      expect(motion.station.position.distanceTo(released)).toBeLessThan(.021)
      interaction.end()
      expect(interaction.move(start, pose, view)).toBeNull()
      expect(interaction.hitTest(project(motion.planet.position), pose, view)).toBe(false)
    }
    disposeModels(motion.root)
  })

})

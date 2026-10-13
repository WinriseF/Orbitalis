import * as THREE from 'three'
import type { LunarPose } from './lunar-scene'

export type PlanetStationVector3 = readonly [number, number, number]
export type PlanetStationQuaternion = readonly [number, number, number, number]

export interface PlanetStationTransform {
  position: PlanetStationVector3
  quaternion: PlanetStationQuaternion
  scale: PlanetStationVector3
}

/** Composition transforms are applied once, outside the station's authored glTF rig. */
export interface PlanetStationMotionManifest {
  coordinateSystem: 'three-y-up'
  planet: PlanetStationTransform & { prototype: string }
  station: PlanetStationTransform & {
    /** One coherent rotor, separate from the fixed hub/mast inside the authored rig. */
    rotor?: {
      nodeName: string
      axis: PlanetStationVector3
      radiansPerSecond: number
    }
    motion: {
      /** Axis in the station placement's local coordinates; the exported mast is local Y. */
      spinAxis: PlanetStationVector3
      spinRadiansPerSecond: number
      /** Maximum displacement on each composition/world axis, not an orbit radius. */
      driftAmplitude: PlanetStationVector3
      driftRadiansPerSecond: number
      /** Circular revolution transports the authored inward-facing local Y axis. */
      facePlanetCenter?: boolean
      /** Selected end of the local mast axis that must face inward; default +Y for old scenes. */
      inwardAxis?: PlanetStationVector3
      orbit?: {
        normal: PlanetStationVector3
        radiansPerSecond: number
      }
    }
  }
}

export interface PlanetStationMotion {
  root: THREE.Group
  /** Center-positioned planet-only drag pivot. */
  planet: THREE.Group
  /** Whole-station placement/orbit pivot; the optional glTF rotor spins separately. */
  station: THREE.Group
  /** The authored moving assembly, or null for older rigid-station compositions. */
  rotor: THREE.Object3D | null
  apply: (pose: LunarPose) => void
  /** Hide only: the scene owner remains responsible for all shared resource cleanup. */
  dispose: () => void
}

function assertTuple(value: unknown, size: number, label: string): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length !== size) {
    throw new Error(`Invalid planet/station ${label}: expected ${size} finite numbers`)
  }
  // Index each entry explicitly: Array.every() would skip sparse tuple holes.
  for (let index = 0; index < size; index++) {
    if (!Number.isFinite(value[index])) throw new Error(`Invalid planet/station ${label}: expected ${size} finite numbers`)
  }
}

function validateTransform(transform: PlanetStationTransform | undefined, label: string) {
  if (!transform) throw new Error(`Invalid planet/station ${label} transform`)
  assertTuple(transform.position, 3, `${label} position`)
  assertTuple(transform.quaternion, 4, `${label} quaternion`)
  assertTuple(transform.scale, 3, `${label} scale`)
  const quaternionLength = Math.hypot(...transform.quaternion)
  // A quaternion is a rotation only when unit length. Preserve valid authored
  // values exactly rather than silently normalizing and changing the zero pose.
  if (!Number.isFinite(quaternionLength) || Math.abs(quaternionLength - 1) > 1e-5) {
    throw new Error(`Invalid planet/station ${label} quaternion: expected unit length`)
  }
  if (transform.scale.some(value => value <= 0)) {
    throw new Error(`Invalid planet/station ${label} scale: expected positive values`)
  }
}

export const CONTROLLER_ORBIT_PER_SECOND = .24
const TAU = Math.PI * 2

/** Reduce before multiplication, so even very large finite clock values stay finite. */
function phaseAt(orbit: number, radiansPerSecond: number): number {
  if (radiansPerSecond === 0) return 0
  const period = TAU * CONTROLLER_ORBIT_PER_SECOND / radiansPerSecond
  return (orbit % period) * radiansPerSecond / CONTROLLER_ORBIT_PER_SECOND
}

/**
 * Adopt the supplied mesh and glTF root once; no mesh/geometry copies are made.
 * The planet prototype's geometry is identity-local, with its placement supplied
 * by scene.json. The station has an outer composition placement while every
 * authored glTF local transform (including the glTF root) remains unchanged,
 * apart from the explicitly named rotor's local rotation.
 * apply() is absolute: jumps, repeated frames and reset never accumulate drift.
 */
export function createPlanetStationMotion(
  manifest: PlanetStationMotionManifest,
  planetPrototype: THREE.Mesh,
  stationRoot: THREE.Object3D
): PlanetStationMotion {
  if (manifest?.coordinateSystem !== 'three-y-up') throw new Error('Planet/station motion requires three-y-up coordinates')
  validateTransform(manifest.planet, 'planet')
  validateTransform(manifest.station, 'station')
  if (typeof manifest.planet.prototype !== 'string' || !manifest.planet.prototype.trim() ||
      !planetPrototype?.isMesh || !planetPrototype.geometry?.isBufferGeometry) {
    throw new Error('Missing planet mesh prototype')
  }
  if (!stationRoot?.isObject3D) throw new Error('Missing station glTF root')
  // Moving either ancestor into the other would silently alter the authored rig.
  for (let node: THREE.Object3D | null = planetPrototype; node; node = node.parent) {
    if (node === stationRoot) throw new Error('Planet and station must be independent source objects')
  }
  for (let node: THREE.Object3D | null = stationRoot; node; node = node.parent) {
    if (node === planetPrototype) throw new Error('Planet and station must be independent source objects')
  }
  const motion = manifest.station.motion
  if (!motion) throw new Error('Invalid planet/station motion settings')
  assertTuple(motion.spinAxis, 3, 'spin axis')
  assertTuple(motion.driftAmplitude, 3, 'drift amplitude')
  const axisLength = Math.hypot(...motion.spinAxis)
  if (!Number.isFinite(axisLength) || axisLength === 0) throw new Error('Invalid planet/station spin axis: expected nonzero finite length')
  if (motion.driftAmplitude.some(value => value < 0)) throw new Error('Invalid planet/station drift amplitude: expected nonnegative values')
  if (!Number.isFinite(motion.spinRadiansPerSecond) || motion.spinRadiansPerSecond < 0 ||
      !Number.isFinite(motion.driftRadiansPerSecond) || motion.driftRadiansPerSecond < 0) {
    throw new Error('Invalid planet/station motion speeds: expected nonnegative finite values')
  }

  // Snapshot the manifest before parenting. Later caller edits cannot change an
  // active animation or its reset pose. These are the only animation scratch objects.
  const stationPosition = new THREE.Vector3().fromArray(manifest.station.position)
  const stationQuaternion = new THREE.Quaternion().fromArray(manifest.station.quaternion)
  // Direct division also normalizes subnormal finite axis values without an
  // overflowing reciprocal (Vector3.divideScalar() multiplies by 1 / length).
  const spinAxis = new THREE.Vector3(motion.spinAxis[0] / axisLength, motion.spinAxis[1] / axisLength, motion.spinAxis[2] / axisLength)
  const spin = new THREE.Quaternion()
  const [driftX, driftY, driftZ] = motion.driftAmplitude
  const spinRate = motion.spinRadiansPerSecond
  const driftRate = motion.driftRadiansPerSecond
  const planetCenter = new THREE.Vector3().fromArray(manifest.planet.position)
  const initialOffset = stationPosition.clone().sub(planetCenter)
  const orbitNormal = new THREE.Vector3()
  const revolution = new THREE.Quaternion()
  const orbitRate = motion.orbit?.radiansPerSecond ?? 0
  const hasOrbit = motion.orbit !== undefined
  if (hasOrbit) {
    if (!motion.orbit || motion.facePlanetCenter !== true) throw new Error('Orbital station must face planet center')
    assertTuple(motion.orbit.normal, 3, 'orbit normal')
    const normalLength = Math.hypot(...motion.orbit.normal)
    if (!Number.isFinite(normalLength) || normalLength === 0) throw new Error('Invalid planet/station orbit normal')
    if (!Number.isFinite(orbitRate) || orbitRate <= 0) throw new Error('Invalid planet/station orbit speed: expected positive finite value')
    orbitNormal.set(...motion.orbit.normal.map(value => value / normalLength) as [number, number, number])
    const radius = initialOffset.length()
    if (!Number.isFinite(radius) || radius === 0) throw new Error('Invalid planet/station orbit radius: expected positive finite value')
    const inward = initialOffset.clone().multiplyScalar(-1 / radius)
    if (Math.abs(orbitNormal.dot(inward)) > 1e-6) throw new Error('Orbit normal must be perpendicular to the initial station offset')
    const inwardAxis = motion.inwardAxis ?? [0, 1, 0]
    assertTuple(inwardAxis, 3, 'inward axis')
    if (inwardAxis[0] !== 0 || inwardAxis[2] !== 0 || Math.abs(inwardAxis[1]) !== 1) {
      throw new Error('Orbital station inward axis must be local +Y or -Y')
    }
    if (new THREE.Vector3().fromArray(inwardAxis).applyQuaternion(stationQuaternion).distanceTo(inward) > 1e-6) {
      throw new Error('Authored station selected mast end must point inward toward planet center')
    }
    if (Math.hypot(spinAxis.x, spinAxis.z) > 1e-12) throw new Error('Orbital station spin axis must be local Y')
    if (manifest.station.scale.some(value => Math.abs(value / manifest.station.scale[0] - 1) > 1e-8)) {
      throw new Error('Orbital station requires uniform scale')
    }
    if (driftX !== 0 || driftY !== 0 || driftZ !== 0 || driftRate !== 0) {
      throw new Error('Orbital station requires zero lateral drift')
    }
  } else if (motion.facePlanetCenter) {
    throw new Error('Facing planet center requires a circular orbit')
  }

  const rotorSettings = manifest.station.rotor
  let rotor: THREE.Object3D | null = null
  let rotorRate = 0
  const rotorAxis = new THREE.Vector3()
  const rotorSpin = new THREE.Quaternion()
  if (rotorSettings !== undefined) {
    if (!rotorSettings || typeof rotorSettings.nodeName !== 'string' || !rotorSettings.nodeName.trim()) {
      throw new Error('Invalid planet/station rotor node name')
    }
    assertTuple(rotorSettings.axis, 3, 'rotor axis')
    const rotorAxisLength = Math.hypot(...rotorSettings.axis)
    if (!Number.isFinite(rotorAxisLength) || rotorAxisLength === 0) {
      throw new Error('Invalid planet/station rotor axis: expected nonzero finite length')
    }
    rotorRate = rotorSettings.radiansPerSecond
    if (!Number.isFinite(rotorRate) || rotorRate < 0) {
      throw new Error('Invalid planet/station rotor speed: expected nonnegative finite value')
    }
    rotorAxis.set(rotorSettings.axis[0] / rotorAxisLength, rotorSettings.axis[1] / rotorAxisLength, rotorSettings.axis[2] / rotorAxisLength)
    // Never fall back to spinning the entire rig if the named assembly is absent
    // or ambiguous. Validation completes before either source is reparented.
    const candidates: THREE.Object3D[] = []
    stationRoot.traverse(node => { if (node.name === rotorSettings.nodeName) candidates.push(node) })
    if (candidates.length !== 1 || candidates[0] === stationRoot) {
      throw new Error('Station rotor must name exactly one descendant inside the glTF root')
    }
    rotor = candidates[0]
    validateTransform({ position: rotor.position.toArray(), quaternion: rotor.quaternion.toArray(), scale: rotor.scale.toArray() }, 'rotor')
    if (rotor.matrixAutoUpdate) rotor.updateMatrix()
    if (!rotor.matrix.elements.every(Number.isFinite)) throw new Error('Invalid planet/station rotor matrix')
  }
  // Keep the node, hierarchy and resource identities intact. Restoring all three
  // authored components also gives exact reset after time jumps or caller edits.
  const rotorPosition = rotor?.position.clone()
  const rotorQuaternion = rotor?.quaternion.clone()
  const rotorScale = rotor?.scale.clone()
  const rotorMatrix = rotor?.matrix.clone()

  const root = new THREE.Group()
  root.name = 'PlanetStationMotion'
  const planet = new THREE.Group()
  planet.name = 'PlanetCenterPivot'
  planet.position.fromArray(manifest.planet.position)
  planetPrototype.position.set(0, 0, 0)
  planetPrototype.quaternion.fromArray(manifest.planet.quaternion)
  planetPrototype.scale.fromArray(manifest.planet.scale)
  // A prototype loaded with matrixAutoUpdate=false still needs its new placement.
  planetPrototype.updateMatrix()
  planet.add(planetPrototype)

  const station = new THREE.Group()
  station.name = 'WholeStationMotionPivot'
  station.position.copy(stationPosition)
  station.quaternion.copy(stationQuaternion)
  station.scale.fromArray(manifest.station.scale)
  // add(), unlike attach(), retains every authored local transform verbatim.
  station.add(stationRoot)
  root.add(planet, station)

  let lastOrbit = Number.NaN
  let lastStationOrbit = Number.NaN
  const frame = new THREE.Quaternion()
  const lastFrame = new THREE.Quaternion()
  let disposed = false
  const apply = ({ yaw, pitch, orbit, stationOrbit = orbit, stationFrame }: LunarPose) => {
    if (disposed) return
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(orbit) || !Number.isFinite(stationOrbit)) {
      throw new Error('Planet/station pose must contain finite yaw, pitch and orbit values (including stationOrbit)')
    }
    // Validate before any scene mutation; a bad frame cannot partially update
    // the planet, station, or independently ticking ring rotor.
    if (stationFrame !== undefined) {
      assertTuple(stationFrame, 4, 'station frame')
      if (Math.abs(Math.hypot(...stationFrame) - 1) > 1e-5) {
        throw new Error('Invalid planet/station station frame: expected unit length')
      }
      frame.fromArray(stationFrame).normalize()
    } else frame.identity()
    planet.rotation.set(pitch, yaw, 0)
    if (stationOrbit !== lastStationOrbit || !frame.equals(lastFrame)) {
      if (stationOrbit === 0) {
        // An explicit copy guarantees exact authored reset, including signed zeros.
        station.position.copy(stationPosition)
        station.quaternion.copy(stationQuaternion)
      } else {
        spin.setFromAxisAngle(spinAxis, phaseAt(stationOrbit, spinRate))
        if (hasOrbit) {
          revolution.setFromAxisAngle(orbitNormal, phaseAt(stationOrbit, orbitRate))
          station.position.copy(initialOffset).applyQuaternion(revolution).add(planetCenter)
          // Transport the entire radial frame smoothly, then spin around its mast.
          // There is no lookAt pole singularity, lateral drift, or rig reparenting.
          station.quaternion.copy(revolution).multiply(stationQuaternion).multiply(spin)
        } else {
          // Compatibility for older compositions that explicitly use bounded drift.
          station.quaternion.copy(stationQuaternion).multiply(spin)
          station.position.set(
            stationPosition.x + driftX * Math.sin(phaseAt(stationOrbit, driftRate)),
            stationPosition.y + driftY * Math.sin(phaseAt(stationOrbit, driftRate * .7)),
            stationPosition.z + driftZ * Math.sin(phaseAt(stationOrbit, driftRate * .5))
          )
        }
      }
      if (hasOrbit && (frame.x !== 0 || frame.y !== 0 || frame.z !== 0 || frame.w !== 1)) {
        // Rotate around the planet center, transporting the complete circular
        // orbit, its normal/tangent, and the authored radial attitude together.
        station.position.sub(planetCenter).applyQuaternion(frame).add(planetCenter)
        station.quaternion.premultiply(frame)
      }
      lastStationOrbit = stationOrbit
      lastFrame.copy(frame)
    }
    if (rotor && orbit !== lastOrbit) {
      rotor.position.copy(rotorPosition!)
      rotor.scale.copy(rotorScale!)
      rotor.quaternion.copy(rotorQuaternion!)
      if (orbit === 0) {
        rotor.matrix.copy(rotorMatrix!)
        rotor.matrixWorldNeedsUpdate = true
      } else {
        rotorSpin.setFromAxisAngle(rotorAxis, phaseAt(orbit, rotorRate))
        rotor.quaternion.multiply(rotorSpin)
        // A matrix-locked authored rotor still participates in the animation;
        // its original matrixAutoUpdate setting is not changed.
        rotor.updateMatrix()
      }
    }
    lastOrbit = orbit
  }

  apply({ yaw: 0, pitch: 0, orbit: 0 })
  return {
    root, planet, station, rotor, apply,
    dispose() {
      if (disposed) return
      disposed = true
      root.visible = false
    }
  }
}

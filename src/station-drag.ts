import * as THREE from 'three'
import type { LunarPose } from './lunar-scene'
import type { LunarView, LunarViewPoint } from './lunar-view'
import { type PlanetStationMotion, type PlanetStationMotionManifest } from './station-motion'

export type LunarStationDragUpdate = {
  stationOrbit: number
  stationFrame: [number, number, number, number]
}

export interface LunarStationDrag {
  hitTest(point: LunarViewPoint, pose: LunarPose, view: LunarView): boolean
  begin(point: LunarViewPoint, pose: LunarPose, view: LunarView): boolean
  /** Held station clock plus a world rotation of its circular orbit. */
  move(point: LunarViewPoint, pose: LunarPose, view: LunarView): LunarStationDragUpdate | null
  end(): void
}

export interface StationDragOptions {
  manifest: PlanetStationMotionManifest
  motion: PlanetStationMotion
  camera: THREE.PerspectiveCamera
  /** Share the scene's exact projection and pose, including zoom and view offsets. */
  prepare(pose: LunarPose, view: LunarView): void
  /** CSS pixels, independent of the WebGL drawing-buffer resolution. */
  viewport(): { width: number; height: number }
}

const PICK_TOLERANCE = 5
const PICK_OFFSETS = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
  [.707, .707], [-.707, .707], [.707, -.707], [-.707, -.707]
] as const

/**
 * Mesh picking runs only on pointer events, behind a projected bounds check.
 * Dragging rolls the station around the whole fixed-radius sphere. Pointer
 * travel becomes unbounded angular travel, including through both hemispheres.
 * Screen-oriented tangent axes are transported with the whole orbit frame, so
 * both axes keep working at the limb/poles and release continues in the new
 * plane. Movement never raycasts mesh triangles.
 */
export function createStationDrag(options: StationDragOptions): LunarStationDrag | undefined {
  const { manifest, motion, camera, prepare, viewport } = options
  const orbit = manifest.station.motion.orbit
  if (!orbit) return undefined
  const center = new THREE.Vector3().fromArray(manifest.planet.position)
  const radial = new THREE.Vector3().fromArray(manifest.station.position).sub(center)
  const radius = radial.length()
  const bounds = new THREE.Box3()
  const corner = new THREE.Vector3()
  const ndc = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  // Lights use different layers. Picking must see both depth-preserving passes.
  ray.layers.enableAll()
  const stationMeshes: THREE.Mesh[] = []
  const planetMeshes: THREE.Mesh[] = []
  for (const [root, meshes] of [[motion.station, stationMeshes], [motion.planet, planetMeshes]] as const) {
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      // Three's per-mesh raycast can cheaply reject a ray before its triangle loop.
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere()
      meshes.push(object)
    })
  }
  const stationHits: THREE.Intersection[] = []
  const planetHits: THREE.Intersection[] = []
  const visible = (object: THREE.Object3D): boolean => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      if (materials.every(material => !material.visible)) return false
    }
    return true
  }
  const finitePoint = (point: LunarViewPoint) => Number.isFinite(point.x) && Number.isFinite(point.y)
  const sync = (pose: LunarPose, view: LunarView) => {
    prepare(pose, view)
    camera.updateMatrixWorld(true)
    motion.root.updateWorldMatrix(true, true)
    ray.near = camera.near
    ray.far = camera.far
  }
  const pick = (point: LunarViewPoint, pose: LunarPose, view: LunarView) => {
    if (!finitePoint(point) || Math.abs(point.x) > .5 || Math.abs(point.y) > .5 || !visible(motion.station)) return false
    sync(pose, view)
    const { width, height } = viewport()
    if (!(width > 0) || !(height > 0)) return false
    bounds.setFromObject(motion.station)
    if (bounds.isEmpty()) return false
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let index = 0; index < 8; index++) {
      corner.set(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z).project(camera)
      const x = corner.x / 2, y = -corner.y / 2
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    if (point.x < minX - PICK_TOLERANCE / width || point.x > maxX + PICK_TOLERANCE / width ||
        point.y < minY - PICK_TOLERANCE / height || point.y > maxY + PICK_TOLERANCE / height) return false
    const candidates = stationMeshes.filter(visible)
    const occluders = planetMeshes.filter(visible)
    for (const [index, offset] of PICK_OFFSETS.entries()) {
      ndc.set(2 * (point.x + offset[0] * PICK_TOLERANCE / width), -2 * (point.y + offset[1] * PICK_TOLERANCE / height))
      ray.setFromCamera(ndc, camera)
      stationHits.length = 0
      planetHits.length = 0
      ray.intersectObjects(candidates, false, stationHits)
      // The exact pointer's planet hit also vetoes tolerance rays: clicking the
      // opaque planet can never pick an occluded station just beyond its limb.
      if (stationHits.length || index === 0) ray.intersectObjects(occluders, false, planetHits)
      const stationHit = stationHits.find(hit => {
        const mesh = hit.object as THREE.Mesh
        return !Array.isArray(mesh.material) || mesh.material[hit.face?.materialIndex ?? 0]?.visible !== false
      })
      const planetHit = planetHits[0]
      if (stationHit && (!planetHit || stationHit.distance < planetHit.distance - 1e-6)) return true
      if (index === 0 && planetHit) return false
    }
    return false
  }

  let active = false
  let clock = 0
  let previousX = 0, previousY = 0
  let cameraSignature = ''
  const frame = new THREE.Quaternion()
  const transport = new THREE.Quaternion()
  const align = new THREE.Quaternion()
  const eye = new THREE.Vector3()
  const eyeUnit = new THREE.Vector3()
  const radialUnit = new THREE.Vector3()
  const tangentRight = new THREE.Vector3()
  const tangentUp = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const axis = new THREE.Vector3()
  const signature = () => camera.matrixWorld.elements.join(',')
  const update = (): LunarStationDragUpdate => ({ stationOrbit: clock, stationFrame: frame.toArray() })
  const setEye = () => camera.getWorldPosition(eye).sub(center)
  const orientTrackball = () => {
    setEye()
    eyeUnit.copy(eye).normalize()
    radialUnit.copy(radial).normalize()
    // Orient a virtual front-facing ball to the grabbed station. Its local X/Y
    // directions are both tangent to the orbit, including at the silhouette.
    // Unlike fixed camera X/Y rotation axes, neither control dies at a side pole.
    tangentRight.setFromMatrixColumn(camera.matrixWorld, 0)
      .addScaledVector(eyeUnit, -tangentRight.dot(eyeUnit)).normalize()
    tangentUp.crossVectors(eyeUnit, tangentRight).normalize()
    align.setFromUnitVectors(eyeUnit, radialUnit)
    tangentRight.applyQuaternion(align)
    tangentUp.applyQuaternion(align)
  }

  return {
    hitTest: pick,
    begin(point, pose, view) {
      active = false
      if (!pick(point, pose, view)) return false
      clock = pose.stationOrbit ?? pose.orbit
      frame.fromArray(pose.stationFrame ?? [0, 0, 0, 1]).normalize()
      motion.station.getWorldPosition(radial).sub(center)
      orientTrackball()
      previousX = point.x
      previousY = point.y
      cameraSignature = signature()
      // No fitting on press: grabbing any visible mast/ring point preserves the
      // exact authored pose. A drag has no near/far root or screen-edge clamp.
      active = true
      return true
    },
    move(point, pose, view) {
      if (!active || !finitePoint(point) || !visible(motion.station)) return null
      sync({ ...pose, ...update() }, view)
      const currentSignature = signature()
      if (currentSignature !== cameraSignature) {
        // A moved/rotated camera changes only the control directions. Zoom,
        // pan and resize need no positional fitting or synthetic pointer move.
        orientTrackball()
        cameraSignature = currentSignature
      }
      if (point.x === previousX && point.y === previousY) return update()
      const { width, height } = viewport()
      if (!(width > 0) || !(height > 0)) return update()
      setEye()
      const distance = eye.length()
      const projectedRadius = Math.abs(camera.projectionMatrix.elements[5]) * radius * height /
        (2 * Math.sqrt(Math.max(radius * radius * 1e-6, distance * distance - radius * radius)))
      // One projected radius of travel rolls 90 degrees. Cap the virtual ball
      // at half the short viewport dimension: even zoomed/mobile views can
      // cross a hemisphere without dragging beyond the screen. Zoomed-out
      // stations retain a 24px control floor to avoid excessive sensitivity.
      const trackballRadius = Math.max(24, Math.min(projectedRadius, Math.min(width, height) / 2))
      const dx = (point.x - previousX) * width
      const dy = (point.y - previousY) * height
      const pixels = Math.hypot(dx, dy)
      if (!(pixels > 0) || !Number.isFinite(pixels)) return update()
      const angle = pixels / trackballRadius * Math.PI / 2
      tangent.copy(tangentRight).multiplyScalar(dx / pixels).addScaledVector(tangentUp, -dy / pixels)
      axis.crossVectors(radial, tangent).normalize()
      transport.setFromAxisAngle(axis, angle)
      frame.premultiply(transport).normalize()
      radial.applyQuaternion(transport).normalize().multiplyScalar(radius)
      // Parallel-transport both controls rather than re-mirroring them when
      // the station passes the limb or the rear pole. Continued straight travel
      // can make any number of full turns; reversing it retraces the same path.
      tangentRight.applyQuaternion(transport).normalize()
      tangentUp.crossVectors(radial, tangentRight).normalize()
      previousX = point.x
      previousY = point.y
      return update()
    },
    end() { active = false }
  }
}

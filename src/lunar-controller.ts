import { defaultLunarView, zoomLunarView, lunarWheelFactor, LUNAR_ZOOM, type LunarView, type LunarViewPoint } from './lunar-view'
import type { LunarPose, LunarResolution, LunarScene } from './lunar-scene'

/** Only this locally constructed error may disclose a specific fallback cause. */
export class LunarTextureLimitError extends Error {
	constructor(public readonly width: number, public readonly height: number, public readonly maxTextureSize: number) {
		super(`Original texture ${width} × ${height} exceeds device texture limit ${maxTextureSize} × ${maxTextureSize}`)
		this.name = 'LunarTextureLimitError'
	}
}
/** WebGL reports allocation failure through getError rather than a thrown exception. */
export class LunarGpuMemoryError extends Error {
	constructor() {
		super('Insufficient GPU memory for the original texture and drawing buffer')
		this.name = 'LunarGpuMemoryError'
	}
}
export type LunarFallbackReason =
	| { kind: 'texture-limit'; width: number; height: number; maxTextureSize: number }
	| { kind: 'gpu-memory' }

export type LunarState = {
	phase: 'poster' | 'loading' | 'ready' | 'fallback'
	rotating: boolean
	dragging: boolean
	stationDragging?: boolean
	stationHovered?: boolean
	zoom: number
	resolution: LunarResolution | null
	fallbackReason: LunarFallbackReason | null
}
type Connection = EventTarget & { saveData?: boolean }
type SceneFactory = (host: HTMLElement, signal: AbortSignal, onContextLost: () => void) => Promise<LunarScene>
export const LUNAR_BUDGET = { renderLongEdge: 3840 } as const
/** Fixed drawing-buffer resolution, independent of CSS size, display DPR and browser zoom. */
export function lunarPixelRatio(width: number, height: number) {
	return LUNAR_BUDGET.renderLongEdge / Math.max(width, height, 1)
}

/** Visible motion is continuous; paused, offscreen, hidden and unmounted scenes stop work. */
export function attachLunarController(
	surface: HTMLElement,
	host: HTMLElement,
	onChange: (state: LunarState) => void,
	factory: SceneFactory = async (...args) => (await import('./lunar-scene')).createLunarScene(...args)
) {
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
	const connection = (navigator as Navigator & { connection?: Connection }).connection
	const abort = new AbortController()
	let scene: LunarScene | null = null
	let phase: LunarState['phase'] = 'poster'
	let resolution: LunarResolution | null = null
	let fallbackReason: LunarFallbackReason | null = null
	let inView = typeof IntersectionObserver === 'undefined'
	let pageActive = true
	let disposed = false
	let failed = false
	let explicitLoad = false
	let rotation: 'default' | 'on' | 'off' = 'default'
	let frame = 0
	let lastTime: number | null = null
	let dirty = true
	let width = Math.max(host.clientWidth, 1)
	let height = Math.max(host.clientHeight, 1)
	type Pointer = { id: number; x: number; y: number; startX: number; startY: number; touch: boolean; moved: boolean; pan: boolean }
	let pointer: Pointer | null = null
	const pointers = new Map<number, Pointer>()
	let pinch: { distance: number; center: LunarViewPoint; view: LunarView } | null = null
	let view = defaultLunarView()
	let suppressClick = false
	let stationDragging = false
	let stationHovered = false
	let stationResumeAt: number | null = null
	let lastHoverTest = -Infinity
	const pose: LunarPose = { yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 }
	const target = { yaw: 0, pitch: 0 }
	const staticPreference = () => motion.matches || !!connection?.saveData
	const visible = () => !disposed && inView && pageActive && !document.hidden
	const rotating = () => rotation === 'on' || (rotation === 'default' && !staticPreference())
	const moving = () => Math.abs(target.yaw - pose.yaw) + Math.abs(target.pitch - pose.pitch) > 0.0005
	const report = () => {
		if (!disposed) onChange({ phase, rotating: phase === 'ready' && rotating(), dragging: stationDragging || !!pointer?.moved || !!pinch, stationDragging, stationHovered, zoom: view.zoom, resolution, fallbackReason })
	}
	const setStationHovered = (hovered: boolean) => {
		if (stationHovered === hovered) return
		stationHovered = hovered
		report()
	}
	const endStationDrag = () => {
		if (!stationDragging) return
		stationDragging = false
		stationHovered = false
		stationResumeAt = performance.now()
		scene?.stationDrag?.end()
	}
	const stop = () => {
		if (frame) window.cancelAnimationFrame(frame)
		frame = 0
		lastTime = null
	}
	const releasePointer = () => {
		const ids = [...pointers.keys()]
		if (ids.length) suppressClick = true
		endStationDrag()
		stationHovered = false
		lastHoverTest = -Infinity
		pointers.clear()
		pointer = null
		pinch = null
		for (const id of ids) if (surface.hasPointerCapture?.(id)) surface.releasePointerCapture(id)
	}
	const fail = (error?: unknown) => {
		if (disposed) return
		stop()
		failed = true
		abort.abort()
		phase = 'fallback'
		resolution = null
		fallbackReason = error instanceof LunarTextureLimitError
			? { kind: 'texture-limit', width: error.width, height: error.height, maxTextureSize: error.maxTextureSize }
			: error instanceof LunarGpuMemoryError ? { kind: 'gpu-memory' } : null
		releasePointer()
		scene?.dispose()
		scene = null
		report()
	}
	const active = () => visible() && scene !== null && (dirty || moving() || rotating())
	const schedule = () => {
		if (!active()) {
			lastTime = null
			return
		}
		// Follow the browser's refresh cadence, with one callback even during input bursts.
		if (!frame) frame = window.requestAnimationFrame(draw)
	}
	const draw = (now: number) => {
		frame = 0
		if (!active() || !scene) {
			lastTime = null
			return
		}
		// The first/resumed frame establishes time; the clamp only guards long stalls.
		const dt = lastTime === null ? 0 : Math.min(Math.max(0, (now - lastTime) / 1000), 0.1)
		lastTime = now
		if (rotating()) {
			// A station grab holds only its orbit clock; planet and ring keep moving.
			if (!pointers.size || stationDragging) target.yaw += dt * 0.075
			pose.orbit += dt * 0.24
			if (!stationDragging) {
				const stationDt = stationResumeAt === null ? dt : Math.min(dt, Math.max(0, (now - stationResumeAt) / 1000))
				pose.stationOrbit = (pose.stationOrbit ?? 0) + stationDt * 0.24
			}
		}
		stationResumeAt = null
		const ease = motion.matches || (pointers.size && !stationDragging) ? 1 : 1 - Math.exp(-dt * 18)
		pose.yaw += (target.yaw - pose.yaw) * ease
		pose.pitch += (target.pitch - pose.pitch) * ease
		// Only snap a settled, paused target; tiny per-frame automatic steps are not idle.
		if (!rotating() && !moving()) {
			pose.yaw = target.yaw
			pose.pitch = target.pitch
		}
		try {
			scene.render(pose, view)
			dirty = false
		} catch (error) {
			fail(error)
			return
		}
		schedule()
	}
	const resize = () => {
		if (stationDragging) releasePointer()
		stationHovered = false
		lastHoverTest = -Infinity
		width = Math.max(host.clientWidth, 1)
		height = Math.max(host.clientHeight, 1)
		try {
			resolution = scene?.resize(width, height, lunarPixelRatio(width, height)) || null
		} catch (error) {
			fail(error)
			return
		}
		dirty = true
		report()
		schedule()
	}
	const load = async () => {
		if (phase !== 'poster' || !visible() || (staticPreference() && !explicitLoad)) return
		phase = 'loading'
		report()
		try {
			const next = await factory(host, abort.signal, fail)
			if (disposed || failed) {
				next.dispose()
				return
			}
			scene = next
			phase = 'ready'
			resize()
			report()
			schedule()
		} catch (error) {
			if (!disposed && !failed) fail(error)
		}
	}
	const sync = () => {
		if (!visible()) {
			stop()
			releasePointer()
			report()
			return
		}
		void load()
		dirty = true
		schedule()
	}
	const activate = () => {
		explicitLoad = true
		void load()
	}
	const point = (x: number, y: number): LunarViewPoint => {
		const rect = host.getBoundingClientRect()
		return { x: (x - rect.left) / Math.max(rect.width, 1) - 0.5, y: (y - rect.top) / Math.max(rect.height, 1) - 0.5 }
	}
	const changeView = (next: LunarView) => {
		if (next.zoom === view.zoom && next.panX === view.panX && next.panY === view.panY) return
		view = next
		stationHovered = false
		lastHoverTest = -Infinity
		dirty = true
		report()
		schedule()
	}
	const zoom = (factor: number, anchor: LunarViewPoint = { x: 0, y: 0 }) => {
		if (disposed || phase === 'fallback' || !Number.isFinite(factor) || factor <= 0) return
		// The drag projection is anchored to its initial camera; release before changing it.
		if (stationDragging) {
			releasePointer()
			report()
		}
		activate()
		changeView(zoomLunarView(view, view.zoom * factor, anchor))
	}
	const onWheel = (event: WheelEvent) => {
		// Leave the page/browser alone for the static poster, fallback and hidden view.
		if (phase !== 'ready' || !visible() || pinch || !Number.isFinite(event.deltaY) || !event.deltaY) return
		event.preventDefault()
		zoom(lunarWheelFactor(event.deltaY, event.deltaMode, height), point(event.clientX, event.clientY))
	}
	const pinchMetrics = () => {
		const [a, b] = [...pointers.values()]
		return { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), center: point((a.x + b.x) / 2, (a.y + b.y) / 2) }
	}
	const onPointerDown = (event: PointerEvent) => {
		if (disposed || phase === 'fallback' || pointers.has(event.pointerId) || (event.pointerType === 'mouse' && event.button !== 0)) return
		const touch = event.pointerType === 'touch'
		if (pointers.size) {
			if (!touch || !pointer?.touch || pointers.size !== 1) return
		} else if (!event.isPrimary) return
		activate()
		const next: Pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, touch, moved: false, pan: !!event.shiftKey }
		pointers.set(next.id, next)
		if (pointers.size === 2) {
			endStationDrag()
			stationHovered = false
			// Freeze any unfinished drag easing before a pinch; neither finger rotates.
			target.yaw = pose.yaw
			target.pitch = pose.pitch
			pinch = { ...pinchMetrics(), view: { ...view } }
			pointer = null
			suppressClick = true
			for (const id of pointers.keys()) surface.setPointerCapture?.(id)
			event.preventDefault()
			report()
			return
		}
		suppressClick = false
		pointer = next
		stationHovered = false
		if (!next.pan && phase === 'ready' && visible() && scene?.stationDrag) {
			const position = point(next.x, next.y)
			// begin validates the visible station hit itself; avoid raycasting the model twice.
			if (scene.stationDrag.begin(position, pose, view)) {
				stationDragging = true
				stationHovered = true
				suppressClick = true
				// Capture touch immediately: a station press is already a grab, not page scrolling.
				surface.setPointerCapture?.(next.id)
				event.preventDefault()
				report()
				return
			}
		}
		if (next.pan) { target.yaw = pose.yaw; target.pitch = pose.pitch }
		if (!touch) surface.setPointerCapture?.(next.id)
		report()
	}
	const onPointerMove = (event: PointerEvent) => {
		const tracked = pointers.get(event.pointerId)
		if (!tracked) {
			if (pointers.size || event.pointerType === 'touch') return
			if (phase !== 'ready' || !visible() || event.shiftKey || !scene?.stationDrag) {
				setStationHovered(false)
				return
			}
			// Model raycasts are bounded to 10Hz; hovering alone never starts rendering.
			const now = performance.now()
			if (now - lastHoverTest < 100) return
			lastHoverTest = now
			setStationHovered(scene.stationDrag.hitTest(point(event.clientX, event.clientY), pose, view))
			return
		}
		if (pinch) {
			tracked.x = event.clientX
			tracked.y = event.clientY
			const next = pinchMetrics()
			event.preventDefault()
			changeView(zoomLunarView(pinch.view, pinch.view.zoom * next.distance / pinch.distance, pinch.center, next.center))
			return
		}
		// Once a pinch ends, wait for both fingers to lift before accepting a drag.
		if (!pointer || event.pointerId !== pointer.id) return
		if (stationDragging) {
			event.preventDefault()
			const update: unknown = scene?.stationDrag?.move(point(event.clientX, event.clientY), pose, view)
			pointer.x = event.clientX
			pointer.y = event.clientY
			// Treat malformed projection results as a missed move, without disturbing the last valid pose.
			if (!update || typeof update !== 'object') return
			const { stationOrbit: nextOrbit, stationFrame: incomingFrame } = update as { stationOrbit?: unknown; stationFrame?: unknown }
			if (typeof nextOrbit !== 'number' || !Number.isFinite(nextOrbit) || !Array.isArray(incomingFrame) || incomingFrame.length !== 4) return
			const nextFrame: NonNullable<LunarPose['stationFrame']> = [incomingFrame[0], incomingFrame[1], incomingFrame[2], incomingFrame[3]]
			if (!nextFrame.every(value => typeof value === 'number' && Number.isFinite(value))) return
			const frameLength = Math.hypot(...nextFrame)
			if (!Number.isFinite(frameLength) || Math.abs(frameLength - 1) > 1e-6) return
			const previousFrame = pose.stationFrame ?? [0, 0, 0, 1]
			const changed = nextOrbit !== pose.stationOrbit || nextFrame.some((value, index) => value !== previousFrame[index])
			pose.stationOrbit = nextOrbit
			pose.stationFrame = nextFrame
			if (changed) {
				dirty = true
				schedule()
			}
			return
		}
		const dx = event.clientX - pointer.x
		const dy = event.clientY - pointer.y
		const totalX = event.clientX - pointer.startX
		const totalY = event.clientY - pointer.startY
		if (!pointer.moved && Math.hypot(totalX, totalY) < 5) return
		if (pointer.touch && phase !== 'ready' && !pointer.moved && Math.abs(totalY) > Math.abs(totalX)) {
			suppressClick = true
			releasePointer()
			report()
			schedule()
			return
		}
		if (pointer.touch && phase === 'ready') event.preventDefault()
		if (!pointer.moved) {
			pointer.moved = true
			surface.setPointerCapture?.(event.pointerId)
			report()
		}
		if (pointer.pan) {
			const rect = host.getBoundingClientRect()
			changeView(zoomLunarView(view, view.zoom, { x: 0, y: 0 }, { x: dx / Math.max(rect.width, 1), y: dy / Math.max(rect.height, 1) }))
		} else {
			target.yaw += (dx / width) * Math.PI * 1.6
			if (!pointer.touch || phase === 'ready') target.pitch = Math.max(-0.65, Math.min(0.65, target.pitch + (dy / height) * Math.PI))
		}
		pointer.x = event.clientX
		pointer.y = event.clientY
		dirty = true
		schedule()
	}
	const onPointerUp = (event: PointerEvent) => {
		if (!pointers.has(event.pointerId)) return
		const wasPinching = !!pinch || !pointer
		suppressClick = stationDragging || wasPinching || !!pointer?.moved || event.type !== 'pointerup'
		endStationDrag()
		pointers.delete(event.pointerId)
		pointer = null
		pinch = null
		if (surface.hasPointerCapture?.(event.pointerId)) surface.releasePointerCapture(event.pointerId)
		report()
		schedule()
	}
	const onPointerLeave = (event: PointerEvent) => {
		setStationHovered(false)
		lastHoverTest = -Infinity
		if (pointers.has(event.pointerId) && !surface.hasPointerCapture?.(event.pointerId)) onPointerUp(event)
	}
	const step = (yaw: number, pitch = 0) => {
		if (phase === 'fallback') return
		activate()
		target.yaw += yaw
		target.pitch = Math.max(-0.65, Math.min(0.65, target.pitch + pitch))
		dirty = true
		schedule()
	}
	const onClick = () => {
		if (suppressClick || pointers.size) {
			suppressClick = false
			return
		}
		step(Math.PI / 8)
	}
	const reset = () => {
		if (phase === 'fallback') return
		activate()
		releasePointer()
		view = defaultLunarView()
		target.yaw = target.pitch = pose.orbit = pose.stationOrbit = 0
		delete pose.stationFrame
		stationResumeAt = null
		rotation = 'off'
		dirty = true
		report()
		schedule()
	}
	const onKeyDown = (event: KeyboardEvent) => {
		const keys: Record<string, [number, number]> = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }
		if (keys[event.key]) {
			event.preventDefault()
			step(...keys[event.key])
		} else if (event.key === '+' || event.key === '=' || event.key === '-') {
			event.preventDefault()
			zoom(event.key === '-' ? 1 / LUNAR_ZOOM.buttonFactor : LUNAR_ZOOM.buttonFactor)
		} else if (event.key === 'Home') {
			event.preventDefault()
			reset()
		}
	}
	const onPageHide = () => {
		pageActive = false
		sync()
	}
	const onPageShow = () => {
		pageActive = true
		sync()
	}
	const onPreferences = () => {
		// New accessibility/data-saving settings immediately override a previous play choice.
		if (staticPreference()) {
			rotation = 'off'
			stop()
		}
		report()
		sync()
	}
	const intersection =
		typeof IntersectionObserver === 'undefined'
			? null
			: new IntersectionObserver(
					entries => {
						inView = entries[0]?.isIntersecting ?? false
						sync()
					},
					{ threshold: 0.01 }
				)
	const resizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
	intersection?.observe(surface)
	resizer?.observe(host)
	if (!resizer) window.addEventListener('resize', resize)
	surface.addEventListener('pointerdown', onPointerDown)
	surface.addEventListener('pointermove', onPointerMove)
	surface.addEventListener('pointerup', onPointerUp)
	surface.addEventListener('pointercancel', onPointerUp)
	surface.addEventListener('lostpointercapture', onPointerUp)
	surface.addEventListener('pointerleave', onPointerLeave)
	surface.addEventListener('wheel', onWheel, { passive: false })
	surface.addEventListener('click', onClick)
	surface.addEventListener('keydown', onKeyDown)
	document.addEventListener('visibilitychange', sync)
	window.addEventListener('pagehide', onPageHide)
	window.addEventListener('pageshow', onPageShow)
	motion.addEventListener('change', onPreferences)
	connection?.addEventListener('change', onPreferences)
	sync()
	return {
		toggleRotation() {
			if (phase === 'fallback') return
			const wasRotating = rotating() && (phase === 'ready' || phase === 'loading')
			rotation = wasRotating ? 'off' : 'on'
			activate()
			report()
			schedule()
		},
		reset,
		zoomIn: () => zoom(LUNAR_ZOOM.buttonFactor),
		zoomOut: () => zoom(1 / LUNAR_ZOOM.buttonFactor),
		destroy() {
			if (disposed) return
			disposed = true
			abort.abort()
			stop()
			releasePointer()
			intersection?.disconnect()
			resizer?.disconnect()
			window.removeEventListener('resize', resize)
			surface.removeEventListener('pointerdown', onPointerDown)
			surface.removeEventListener('pointermove', onPointerMove)
			surface.removeEventListener('pointerup', onPointerUp)
			surface.removeEventListener('pointercancel', onPointerUp)
			surface.removeEventListener('lostpointercapture', onPointerUp)
			surface.removeEventListener('pointerleave', onPointerLeave)
			surface.removeEventListener('wheel', onWheel)
			surface.removeEventListener('click', onClick)
			surface.removeEventListener('keydown', onKeyDown)
			document.removeEventListener('visibilitychange', sync)
			window.removeEventListener('pagehide', onPageHide)
			window.removeEventListener('pageshow', onPageShow)
			motion.removeEventListener('change', onPreferences)
			connection?.removeEventListener('change', onPreferences)
			scene?.dispose()
			scene = null
		}
	}
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../../src/lunar-view'

export class TrackedTarget extends EventTarget {
	listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
	addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
		if (listener) {
			if (!this.listeners.has(type)) this.listeners.set(type, new Set())
			this.listeners.get(type)!.add(listener)
		}
		super.addEventListener(type, listener, options)
	}
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
		if (listener) this.listeners.get(type)?.delete(listener)
		super.removeEventListener(type, listener, options)
	}
	get listenerCount() {
		return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
	}
}

export class Surface extends TrackedTarget {
	clientWidth = 206
	clientHeight = 154
	getBoundingClientRect = () => ({ left: 0, top: 0, width: this.clientWidth, height: this.clientHeight })
	captured = new Set<number>()
	setPointerCapture = vi.fn((id: number) => this.captured.add(id))
	hasPointerCapture = (id: number) => this.captured.has(id)
	releasePointerCapture = vi.fn((id: number) => this.captured.delete(id))
}

/** Deterministic browser clock with configurable display refresh cadence. */
export class BrowserClock {
	constructor(readonly refreshRate = 60) {}
	get frameDuration() { return 1000 / this.refreshRate }
	rafExecutions = 0
	now = 0
	nextId = 1
	tasks = new Map<number, { at: number; run: () => void; type: 'raf' | 'timer' }>()
	setTimeout = (run: () => void, delay = 0) => this.add('timer', this.now + delay, run)
	clearTimeout = (id: number) => this.tasks.delete(id)
	requestAnimationFrame = (run: FrameRequestCallback) => {
		const at = (Math.floor((this.now + 0.000001) / this.frameDuration) + 1) * this.frameDuration
		return this.add('raf', at, () => {
			this.rafExecutions++
			run(this.now)
		})
	}
	cancelAnimationFrame = (id: number) => this.tasks.delete(id)
	private add(type: 'raf' | 'timer', at: number, run: () => void) {
		const id = this.nextId++
		this.tasks.set(id, { at, run, type })
		return id
	}
	advance(milliseconds: number) {
		const end = this.now + milliseconds
		let executions = 0
		while (true) {
			const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
			if (!next || next[1].at > end + 0.000001) break
			if (++executions > 100_000) throw new Error('Runaway animation scheduler')
			this.tasks.delete(next[0])
			this.now = next[1].at
			next[1].run()
		}
		this.now = end
	}
}

export function emit(target: EventTarget, type: string, properties: Record<string, unknown> = {}) {
	const event = new Event(type, { cancelable: true })
	Object.assign(event, properties)
	target.dispatchEvent(event)
	return event
}

export async function flush() {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

export type Options = { refreshRate?: number; reducedMotion?: boolean; saveData?: boolean; deferred?: boolean; observers?: boolean; reject?: Error; stationDrag?: LunarScene['stationDrag'] }
export const cleanup: Array<() => void> = []

export function setup(options: Options = {}) {
	const clock = new BrowserClock(options.refreshRate)
	const surface = new Surface()
	const host = new Surface()
	const doc = Object.assign(new TrackedTarget(), { hidden: false })
	const motion = Object.assign(new TrackedTarget(), { matches: !!options.reducedMotion })
	const connection = Object.assign(new TrackedTarget(), { saveData: !!options.saveData })
	const win = Object.assign(new TrackedTarget(), {
		matchMedia: vi.fn(() => motion),
		devicePixelRatio: 3,
		requestAnimationFrame: clock.requestAnimationFrame,
		cancelAnimationFrame: clock.cancelAnimationFrame,
		setTimeout: vi.fn(clock.setTimeout),
		clearTimeout: vi.fn(clock.clearTimeout)
	})
	const intersections: Array<{ callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
	const resizers: Array<{ callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
	class Intersection {
		observe = vi.fn()
		disconnect = vi.fn()
		constructor(public callback: IntersectionObserverCallback) {
			intersections.push(this)
		}
	}
	class Resize {
		observe = vi.fn()
		disconnect = vi.fn()
		constructor(public callback: ResizeObserverCallback) {
			resizers.push(this)
		}
	}
	vi.stubGlobal('window', win)
	vi.stubGlobal('document', doc)
	vi.stubGlobal('navigator', { connection })
	vi.stubGlobal('performance', { now: () => clock.now })
	vi.stubGlobal('IntersectionObserver', options.observers === false ? undefined : Intersection)
	vi.stubGlobal('ResizeObserver', options.observers === false ? undefined : Resize)
	const rendered: Array<{ time: number; pose: LunarPose; view: LunarView }> = []
	const scene = {
		stationDrag: options.stationDrag,
		render: vi.fn((pose: LunarPose, view = defaultLunarView()) => rendered.push({ time: clock.now, pose: { ...pose }, view: { ...view } })),
		resize: vi.fn((width: number, height: number, ratio: number): LunarResolution => ({
			width: Math.round(width * ratio), height: Math.round(height * ratio),
			requestedWidth: Math.round(width * ratio), requestedHeight: Math.round(height * ratio), limited: false
		})),
		dispose: vi.fn()
	}
	let resolve!: (scene: LunarScene) => void
	let reject!: (error: unknown) => void
	const pending = new Promise<LunarScene>((res, rej) => {
		resolve = res
		reject = rej
	})
	const factory = vi.fn((_host: HTMLElement, _signal: AbortSignal, _onLost: () => void): Promise<LunarScene> => {
		if (options.reject) return Promise.reject(options.reject)
		return options.deferred ? pending : Promise.resolve(scene)
	})
	const states: LunarState[] = []
	const controller = attachLunarController(surface as unknown as HTMLElement, host as unknown as HTMLElement, state => states.push(state), factory)
	cleanup.push(controller.destroy)
	const visible = (value = true) => {
		const observer = intersections[0]
		observer.callback([{ isIntersecting: value } as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
	}
	return {
		clock,
		surface,
		host,
		doc,
		win,
		motion,
		connection,
		intersections,
		resizers,
		rendered,
		scene,
		factory,
		controller,
		states,
		resolve: () => resolve(scene),
		reject,
		visible,
		get state() {
			return states.at(-1)
		},
		async ready() {
			if (options.observers !== false) visible()
			await flush()
		},
		pointer(type: string, properties: Record<string, unknown> = {}) {
			return emit(surface, type, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, ...properties })
		},
		wheel(properties: Record<string, unknown> = {}) {
			return emit(surface, 'wheel', { deltaY: -100, deltaMode: 0, clientX: 150, clientY: 80, ...properties })
		},
		key(key: string) {
			return emit(surface, 'keydown', { key })
		},
		click() {
			return emit(surface, 'click')
		},
		hide(hidden: boolean) {
			doc.hidden = hidden
			emit(doc, 'visibilitychange')
		},
		preference(kind: 'motion' | 'data', value: boolean) {
			if (kind === 'motion') {
				motion.matches = value
				emit(motion, 'change')
			} else {
				connection.saveData = value
				emit(connection, 'change')
			}
		}
	}
}

afterEach(() => {
	cleanup.splice(0).forEach(destroy => destroy())
	vi.unstubAllGlobals()
})


import { emit, flush, cleanup, setup } from './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('lunar lifecycle, preferences and failures', () => {
	it.each(['offscreen', 'hidden', 'pagehide'])('%s cancels every callback, releases capture, and resumes only after visible', async reason => {
		const h = setup()
		await h.ready()
		h.clock.advance(100)
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 30 })
		if (reason === 'offscreen') h.visible(false)
		if (reason === 'hidden') h.hide(true)
		if (reason === 'pagehide') emit(h.win, 'pagehide')
		expect(h.clock.tasks.size).toBe(0)
		expect(h.surface.captured.size).toBe(0)
		const frames = h.rendered.length
		h.clock.advance(20_000)
		expect(h.rendered).toHaveLength(frames)
		if (reason === 'offscreen') h.visible(true)
		if (reason === 'hidden') h.hide(false)
		if (reason === 'pagehide') emit(h.win, 'pageshow')
		h.clock.advance(100)
		expect(h.rendered.length).toBeGreaterThan(frames)
	})

	it.each([60, 120, 144].flatMap(refreshRate => ['offscreen', 'hidden', 'pagehide'].map(reason => ({ refreshRate, reason }))))(
		'$reason resume at $refreshRate Hz establishes a fresh clock without background catch-up', async ({ refreshRate, reason }) => {
			const h = setup({ refreshRate })
			await h.ready()
			h.clock.advance(1000)
			const before = h.rendered.at(-1)!.pose
			const frames = h.rendered.length
			if (reason === 'offscreen') h.visible(false)
			else if (reason === 'hidden') h.hide(true)
			else emit(h.win, 'pagehide')
			expect(h.clock.tasks.size).toBe(0)
			h.clock.advance(3_600_000)
			expect(h.rendered).toHaveLength(frames)
			if (reason === 'offscreen') h.visible(true)
			else if (reason === 'hidden') h.hide(false)
			else emit(h.win, 'pageshow')
			expect(h.clock.tasks.size).toBe(1)
			h.clock.advance(h.clock.frameDuration)
			expect(h.rendered).toHaveLength(frames + 1)
			expect(h.rendered.at(-1)!.pose).toEqual(before)
			h.clock.advance(1000)
			const after = h.rendered.at(-1)!.pose
			expect(h.rendered).toHaveLength(frames + 1 + refreshRate)
			expect(after.orbit - before.orbit).toBeCloseTo(.24, 9)
			expect(after.stationOrbit! - before.stationOrbit!).toBeCloseTo(.24, 9)
			expect(after.yaw - before.yaw).toBeCloseTo(.075, 3)
			expect(h.win.setTimeout).not.toHaveBeenCalled()
			expect(h.win.clearTimeout).not.toHaveBeenCalled()
		}
	)

	it.each(['offscreen', 'hidden', 'pagehide'])('resolving an asynchronous scene while %s cannot render or schedule work', async reason => {
		const h = setup({ deferred: true })
		await h.ready()
		expect(h.state?.phase).toBe('loading')
		if (reason === 'offscreen') h.visible(false)
		if (reason === 'hidden') h.hide(true)
		if (reason === 'pagehide') emit(h.win, 'pagehide')
		h.resolve()
		await flush()
		h.clock.advance(10_000)
		expect(h.scene.render).not.toHaveBeenCalled()
		expect(h.clock.tasks.size).toBe(0)
		if (reason === 'offscreen') h.visible(true)
		if (reason === 'hidden') h.hide(false)
		if (reason === 'pagehide') emit(h.win, 'pageshow')
		h.clock.advance(100)
		expect(h.scene.render).toHaveBeenCalled()
	})

	it.each(['motion', 'data'] as const)('new %s preference overrides explicit rotation and does not silently resume when cleared', async kind => {
		const h = setup()
		await h.ready()
		h.clock.advance(6000)
		h.controller.toggleRotation()
		h.controller.toggleRotation()
		h.clock.advance(1000)
		expect(h.state?.rotating).toBe(true)
		h.preference(kind, true)
		h.clock.advance(1000)
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
		h.preference(kind, false)
		h.clock.advance(1000)
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('changing preference during loading prevents the default motion from starting', async () => {
		const h = setup({ deferred: true })
		await h.ready()
		h.preference('motion', true)
		h.resolve()
		await flush()
		h.clock.advance(1000)
		expect(h.state).toMatchObject({ phase: 'ready', rotating: false })
		expect(h.rendered).toHaveLength(1)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('fetch/creation failure returns to a stable poster without retries or timers', async () => {
		const h = setup({ reject: new Error('HTTP 404') })
		await h.ready()
		expect(h.state?.phase).toBe('fallback')
		h.click()
		h.key('ArrowRight')
		h.controller.toggleRotation()
		h.visible(false)
		h.visible(true)
		h.clock.advance(10_000)
		expect(h.factory).toHaveBeenCalledTimes(1)
		expect(h.clock.tasks.size).toBe(0)
	})

	it.each([[7680, 3840, 4096], [15360, 7680, 8192]])('preserves the trusted %i × %i texture limit reason on a %i-limit device while disabling all interactive work', async (width, height, maxTextureSize) => {
		const h = setup({ reject: new LunarTextureLimitError(width, height, maxTextureSize) })
		await h.ready()
		expect(h.state).toMatchObject({
			phase: 'fallback', rotating: false, resolution: null,
			fallbackReason: { kind: 'texture-limit', width, height, maxTextureSize }
		})
		h.click()
		h.controller.toggleRotation()
		h.clock.advance(10_000)
		expect(h.factory).toHaveBeenCalledTimes(1)
		expect(h.factory.mock.calls[0][1].aborted).toBe(true)
		expect(h.clock.tasks.size).toBe(0)
	})

	it.each([
		new Error('private fetch details or markup'),
		Object.assign(new Error('untrusted texture limit details'), { name: 'LunarTextureLimitError', width: 7680, height: 3840, maxTextureSize: 4096 }),
		Object.assign(new Error('untrusted GPU memory details'), { name: 'LunarGpuMemoryError' })
	])('keeps arbitrary error messages and lookalike error names out of the fallback notice', async error => {
		const h = setup({ reject: error })
		await h.ready()
		expect(h.state).toMatchObject({ phase: 'fallback', fallbackReason: null })
		expect(JSON.stringify(h.state)).not.toContain(error.message)
	})

	it.each(['creation', 'render', 'resize'])('preserves a trusted GPU-memory %s failure and returns to a stable static fallback', async stage => {
		const h = setup(stage === 'creation' ? { reject: new LunarGpuMemoryError() } : {})
		await h.ready()
		if (stage === 'render') {
			h.scene.render.mockImplementation(() => { throw new LunarGpuMemoryError() })
			h.clock.advance(100)
		}
		if (stage === 'resize') {
			h.scene.resize.mockImplementation(() => { throw new LunarGpuMemoryError() })
			h.resizers[0].callback([], h.resizers[0] as unknown as ResizeObserver)
		}
		expect(h.state).toMatchObject({ phase: 'fallback', rotating: false, resolution: null, fallbackReason: { kind: 'gpu-memory' } })
		expect(h.factory.mock.calls[0][1].aborted).toBe(true)
		expect(h.scene.dispose).toHaveBeenCalledTimes(stage === 'creation' ? 0 : 1)
		h.click()
		h.controller.toggleRotation()
		h.clock.advance(10_000)
		expect(h.factory).toHaveBeenCalledTimes(1)
		expect(h.clock.tasks.size).toBe(0)
	})

	it.each(['context', 'render', 'resize'])('%s failure disposes once and stops all scheduled rendering', async kind => {
		const h = setup()
		await h.ready()
		if (kind === 'context') h.factory.mock.calls[0][2]()
		if (kind === 'render') {
			h.scene.render.mockImplementation(() => {
				throw new Error('lost GPU')
			})
			h.clock.advance(100)
		}
		if (kind === 'resize') {
			h.scene.resize.mockImplementation(() => {
				throw new Error('allocation failed')
			})
			h.resizers[0].callback([], h.resizers[0] as unknown as ResizeObserver)
		}
		expect(h.state?.phase).toBe('fallback')
		expect(h.scene.dispose).toHaveBeenCalledTimes(1)
		expect(h.clock.tasks.size).toBe(0)
		h.controller.destroy()
		expect(h.scene.dispose).toHaveBeenCalledTimes(1)
	})

	it('context failure while loading rejects and disposes the later resolved scene', async () => {
		const h = setup({ deferred: true })
		await h.ready()
		h.factory.mock.calls[0][2]()
		h.resolve()
		await flush()
		expect(h.state?.phase).toBe('fallback')
		expect(h.scene.dispose).toHaveBeenCalledTimes(1)
		expect(h.scene.render).not.toHaveBeenCalled()
		expect(h.clock.tasks.size).toBe(0)
	})

	it('destroy while loading aborts and disposes a late result without publishing ready', async () => {
		const h = setup({ deferred: true })
		await h.ready()
		const stateCount = h.states.length
		h.controller.destroy()
		expect(h.factory.mock.calls[0][1].aborted).toBe(true)
		h.resolve()
		await flush()
		expect(h.scene.dispose).toHaveBeenCalledTimes(1)
		expect(h.scene.render).not.toHaveBeenCalled()
		expect(h.states).toHaveLength(stateCount)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('late rejection after destroy does not publish fallback or create unhandled work', async () => {
		const h = setup({ deferred: true })
		await h.ready()
		const stateCount = h.states.length
		h.controller.destroy()
		h.reject(new Error('AbortError'))
		await flush()
		expect(h.states).toHaveLength(stateCount)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('StrictMode-style destroy/remount cleans every listener, observer, capture and callback', async () => {
		const h = setup()
		await h.ready()
		h.pointer('pointerdown')
		h.controller.destroy()
		h.controller.destroy()
		expect(h.scene.dispose).toHaveBeenCalledTimes(1)
		for (const target of [h.surface, h.doc, h.win, h.motion, h.connection]) expect(target.listenerCount).toBe(0)
		expect(h.surface.captured.size).toBe(0)
		expect(h.intersections[0].disconnect).toHaveBeenCalledTimes(1)
		expect(h.resizers[0].disconnect).toHaveBeenCalledTimes(1)
		expect(h.clock.tasks.size).toBe(0)
		const nextScene = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() }
		const nextFactory = vi.fn(async () => nextScene)
		const second = attachLunarController(h.surface as unknown as HTMLElement, h.host as unknown as HTMLElement, vi.fn(), nextFactory)
		cleanup.push(second.destroy)
		h.intersections[1].callback([{ isIntersecting: true } as IntersectionObserverEntry], h.intersections[1] as unknown as IntersectionObserver)
		await flush()
		h.clock.advance(100)
		expect(nextFactory).toHaveBeenCalledTimes(1)
		expect(nextScene.render).toHaveBeenCalled()
		expect(h.scene.render).not.toHaveBeenCalled()
		second.destroy()
		expect(h.surface.listenerCount).toBe(0)
	})

	it('supports missing optional observers and removes its fallback resize listener', async () => {
		const h = setup({ observers: false })
		await flush()
		expect(h.factory).toHaveBeenCalledTimes(1)
		h.host.clientWidth = 1200
		h.host.clientHeight = 800
		emit(h.win, 'resize')
		expect(h.scene.resize).toHaveBeenLastCalledWith(1200, 800, 3.2)
		h.controller.destroy()
		expect(h.win.listenerCount).toBe(0)
	})
})


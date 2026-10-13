import { emit, flush, Options, setup } from './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('independent station drag gestures', () => {
	const identityFrame: NonNullable<LunarPose['stationFrame']> = [0, 0, 0, 1]
	const tiltedFrame: NonNullable<LunarPose['stationFrame']> = [Math.sin(.4), 0, 0, Math.cos(.4)]
	const stationUpdate = (stationOrbit: number, stationFrame = identityFrame): NonNullable<ReturnType<NonNullable<LunarScene['stationDrag']>['move']>> => ({ stationOrbit, stationFrame: [...stationFrame] })
	function stationApi() {
		return {
			hitTest: vi.fn<NonNullable<LunarScene['stationDrag']>['hitTest']>(() => true),
			begin: vi.fn<NonNullable<LunarScene['stationDrag']>['begin']>(() => true),
			move: vi.fn<NonNullable<LunarScene['stationDrag']>['move']>(() => stationUpdate(3)),
			end: vi.fn()
		}
	}
	async function stationReady(options: Options = {}) {
		const api = stationApi()
		const h = setup({ ...options, stationDrag: api })
		await h.ready()
		if (options.reducedMotion || options.saveData) {
			h.controller.reset()
			await flush()
		}
		h.clock.advance(100)
		return { ...h, api }
	}

	it('redraws a frame-only move while paused, clones the frame, and leaves both clocks fixed', async () => {
		const h = await stationReady({ reducedMotion: true })
		const update = stationUpdate(0, tiltedFrame)
		h.api.move.mockReturnValue(update)
		const count = h.rendered.length
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 0, clientY: 2 })
		h.clock.advance(100)
		expect(h.rendered).toHaveLength(count + 1)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0, stationFrame: tiltedFrame })
		expect(h.rendered.at(-1)!.pose.stationFrame).not.toBe(update.stationFrame)
		expect(h.clock.tasks.size).toBe(0)
		h.pointer('pointermove', { clientX: 0, clientY: 2 })
		h.clock.advance(100)
		expect(h.rendered).toHaveLength(count + 1)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('retains each accepted frame across release, hide, resume and repeated grabs', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.api.move.mockReturnValue(stationUpdate(2, tiltedFrame))
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 40, clientY: 25 })
		h.clock.advance(100)
		h.pointer('pointerup')
		h.hide(true)
		h.clock.advance(5000)
		h.hide(false)
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose).toMatchObject({ stationOrbit: 2, stationFrame: tiltedFrame })
		h.pointer('pointerdown')
		expect(h.api.begin).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ stationOrbit: 2, stationFrame: tiltedFrame }), defaultLunarView())
		const nextFrame: NonNullable<LunarPose['stationFrame']> = [0, Math.sin(.6), 0, Math.cos(.6)]
		h.api.move.mockReturnValue(stationUpdate(2, nextFrame))
		h.pointer('pointermove', { clientX: 20, clientY: 35 })
		h.clock.advance(100)
		h.pointer('pointerup')
		h.controller.toggleRotation()
		h.clock.advance(1000)
		expect(h.rendered.at(-1)!.pose.stationOrbit).toBeGreaterThan(2)
		expect(h.rendered.at(-1)!.pose.stationFrame).toEqual(nextFrame)
		h.pointer('pointerdown')
		expect(h.api.begin).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ stationFrame: nextFrame }), defaultLunarView())
	})

	it.each(['pointercancel', 'lostpointercapture', 'offscreen', 'hidden', 'pagehide'] as const)('keeps the moved frame and station position when a grab ends through %s', async reason => {
		const h = await stationReady({ reducedMotion: true })
		h.api.move.mockReturnValue(stationUpdate(-4, tiltedFrame))
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 30, clientY: -25 })
		// Cancel before the queued draw: the accepted position must still survive.
		if (reason === 'offscreen') h.visible(false)
		else if (reason === 'hidden') h.hide(true)
		else if (reason === 'pagehide') emit(h.win, 'pagehide')
		else h.pointer(reason)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		if (reason === 'offscreen') h.visible(true)
		else if (reason === 'hidden') h.hide(false)
		else if (reason === 'pagehide') emit(h.win, 'pageshow')
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: -4, stationFrame: tiltedFrame })
		h.pointer('pointerdown')
		expect(h.api.begin).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ stationOrbit: -4, stationFrame: tiltedFrame }), defaultLunarView())
	})

	it('reset restores the original plane and phase for the next grab', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.api.move.mockReturnValue(stationUpdate(3, tiltedFrame))
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 20, clientY: 30 })
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.stationFrame).toEqual(tiltedFrame)
		h.controller.reset()
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		expect(h.rendered.at(-1)!.pose.stationFrame).toBeUndefined()
		h.pointer('pointerdown')
		expect(h.api.begin.mock.calls.at(-1)![1].stationFrame).toBeUndefined()
		expect(h.api.begin.mock.calls.at(-1)![1].stationOrbit).toBe(0)
	})

	it('ignores malformed projection results without changing or redrawing the last valid pose', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.api.move.mockReturnValue(stationUpdate(3, tiltedFrame))
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 20, clientY: 30 })
		h.clock.advance(100)
		const count = h.rendered.length
		const invalidResults: unknown[] = [
			null, undefined, 3, NaN, Infinity, 'invalid', {},
			{ stationOrbit: 3 }, { stationOrbit: 3, stationFrame: null },
			{ stationOrbit: NaN, stationFrame: identityFrame }, { stationOrbit: Infinity, stationFrame: identityFrame },
			{ stationOrbit: 4, stationFrame: [0, 0, 1] }, { stationOrbit: 4, stationFrame: [0, 0, 0, 1, 0] },
			{ stationOrbit: 4, stationFrame: [0, 0, 0, 0] }, { stationOrbit: 4, stationFrame: [0, 0, 0, 2] },
			{ stationOrbit: 4, stationFrame: [NaN, 0, 0, 1] }, { stationOrbit: 4, stationFrame: [0, Infinity, 0, 1] },
			{ stationOrbit: 4, stationFrame: [0, 0, 0, '1'] }, { stationOrbit: 4, stationFrame: new Array(4) }
		]
		for (const result of invalidResults) {
			// Deliberately violate the scene boundary to exercise runtime validation.
			h.api.move.mockReturnValue(result as ReturnType<NonNullable<LunarScene['stationDrag']>['move']>)
			expect(() => h.pointer('pointermove', { clientX: 40, clientY: 10 })).not.toThrow()
			h.clock.advance(100)
			expect(h.rendered).toHaveLength(count)
			expect(h.rendered.at(-1)!.pose).toMatchObject({ stationOrbit: 3, stationFrame: tiltedFrame })
			expect(h.clock.tasks.size).toBe(0)
		}
	})

	it('starts only on an actual ready-scene hit, normalizes host coordinates, and does not snap on press', async () => {
		const h = await stationReady()
		h.host.getBoundingClientRect = () => ({ left: 20, top: 30, width: 400, height: 200 })
		const before = { ...h.rendered.at(-1)!.pose }
		const down = h.pointer('pointerdown', { clientX: 320, clientY: 80 })
		expect(h.api.hitTest).not.toHaveBeenCalled()
		expect(h.api.begin).toHaveBeenCalledWith({ x: .25, y: -.25 }, expect.objectContaining(before), defaultLunarView())
		expect(h.api.move).not.toHaveBeenCalled()
		expect(h.states.at(-1)).toMatchObject({ stationDragging: true, stationHovered: true, dragging: true })
		expect(down.defaultPrevented).toBe(true)
		expect(h.surface.hasPointerCapture(1)).toBe(true)
		h.clock.advance(200)
		expect(h.rendered.at(-1)!.pose.stationOrbit).toBe(before.stationOrbit)
	})

	it('a missed station selection falls through to ordinary planet rotation', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.api.begin.mockReturnValue(false)
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 30, clientY: 10 })
		h.clock.advance(100)
		expect(h.api.begin).toHaveBeenCalledTimes(1)
		expect(h.api.move).not.toHaveBeenCalled()
		expect(h.rendered.at(-1)!.pose).toMatchObject({ stationOrbit: 0, orbit: 0 })
		expect(h.rendered.at(-1)!.pose.yaw).toBeGreaterThan(0)
		expect(h.states.at(-1)?.stationDragging).toBe(false)
	})

	it('never selects the station on a poster/loading/hidden surface or for nonprimary/right clicks', async () => {
		const api = stationApi()
		const h = setup({ reducedMotion: true, deferred: true, stationDrag: api })
		await h.ready()
		h.pointer('pointermove')
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 1 })
		h.pointer('pointerup')
		expect(api.hitTest).not.toHaveBeenCalled()
		h.resolve()
		await flush()
		h.pointer('pointerdown', { button: 2 })
		h.pointer('pointerdown', { isPrimary: false })
		h.hide(true)
		h.pointer('pointerdown')
		expect(api.hitTest).not.toHaveBeenCalled()
		expect(api.begin).not.toHaveBeenCalled()
	})

	it('propagates an absolute station phase without changing planet orientation, even below the planet drag threshold', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.pointer('pointerdown')
		const move = h.pointer('pointermove', { clientX: 1, clientY: 2 })
		h.clock.advance(100)
		expect(move.defaultPrevented).toBe(true)
		expect(h.api.move).toHaveBeenCalledWith({ x: 1 / 206 - .5, y: 2 / 154 - .5 }, expect.any(Object), defaultLunarView())
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 3, stationFrame: identityFrame })
		expect(h.clock.tasks.size).toBe(0)
		h.pointer('pointerup')
		h.click()
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.yaw).toBe(0)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('freezes only the station clock while held, keeps ring and planet moving, and resumes from the released phase', async () => {
		const h = await stationReady()
		h.clock.advance(1000)
		const before = h.rendered.at(-1)!.pose
		expect(before.stationOrbit).toBe(before.orbit)
		h.pointer('pointerdown')
		h.clock.advance(2000)
		let current = h.rendered.at(-1)!.pose
		expect(current.stationOrbit).toBe(before.stationOrbit)
		expect(current.orbit).toBeGreaterThan(before.orbit + .4)
		expect(current.yaw).toBeGreaterThan(before.yaw)
		h.api.move.mockReturnValue(stationUpdate(-5, tiltedFrame))
		h.pointer('pointermove', { clientX: 60 })
		h.clock.advance(10_000)
		current = h.rendered.at(-1)!.pose
		expect(current.stationOrbit).toBe(-5)
		expect(current.stationFrame).toEqual(tiltedFrame)
		h.pointer('pointerup')
		h.click()
		h.clock.advance(100)
		const after = h.rendered.at(-1)!.pose
		expect(after.stationOrbit).toBeGreaterThan(-5)
		expect(after.stationOrbit).toBeLessThan(-4.97)
		expect(after.stationFrame).toEqual(tiltedFrame)
		expect(after.orbit).toBeGreaterThan(current.orbit)
		expect(after.yaw - current.yaw).toBeLessThan(.03)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.states.at(-1)).toMatchObject({ stationDragging: false, dragging: false })
	})

	it('does not count time before pointer release in the next station tick', async () => {
		const h = await stationReady()
		h.pointer('pointerdown')
		h.clock.advance(100)
		const frozen = h.rendered.at(-1)!.pose.stationOrbit!
		h.clock.advance(20)
		const releasedAt = h.clock.now
		h.pointer('pointerup')
		h.clock.advance(30)
		const after = h.rendered.at(-1)!
		expect(after.pose.stationOrbit! - frozen).toBeCloseTo((after.time - releasedAt) / 1000 * .24)
	})

	it('suppresses a station press click even with no movement and leaves paused clocks paused', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.pointer('pointerdown')
		h.pointer('pointerup')
		h.click()
		h.clock.advance(1000)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		expect(h.states.at(-1)?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
		h.click()
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.yaw).toBeCloseTo(Math.PI / 8)
	})

	it('Shift-drag always pans, even when the station would be hit', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.controller.zoomIn()
		h.pointer('pointerdown', { shiftKey: true })
		h.pointer('pointermove', { shiftKey: true, clientX: 15, clientY: 10 })
		h.clock.advance(100)
		expect(h.api.hitTest).not.toHaveBeenCalled()
		expect(h.api.begin).not.toHaveBeenCalled()
		expect(h.rendered.at(-1)!.view.panX).toBeGreaterThan(0)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
	})

	it('captures a station touch immediately and switches the second touch to pinch without a release jump', async () => {
		const h = await stationReady({ reducedMotion: true })
		const down = h.pointer('pointerdown', { pointerType: 'touch', clientX: 60, clientY: 70 })
		expect(down.defaultPrevented).toBe(true)
		expect(h.surface.hasPointerCapture(1)).toBe(true)
		h.api.move.mockReturnValue(stationUpdate(2, tiltedFrame))
		h.pointer('pointermove', { pointerType: 'touch', clientX: 80, clientY: 70 })
		h.pointer('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 120, clientY: 70 })
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.surface.captured.size).toBe(2)
		expect(h.states.at(-1)).toMatchObject({ stationDragging: false, dragging: true })
		h.pointer('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 160, clientY: 70 })
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.view.zoom).toBe(2)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 2, stationFrame: tiltedFrame })
		h.pointer('pointerup', { pointerType: 'touch', pointerId: 2 })
		h.pointer('pointermove', { pointerType: 'touch', clientX: 100, clientY: 100 })
		h.pointer('pointerup', { pointerType: 'touch' })
		h.click()
		h.clock.advance(100)
		expect(h.api.move).toHaveBeenCalledTimes(1)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.surface.captured.size).toBe(0)
		expect(h.rendered.at(-1)!.pose.yaw).toBe(0)
	})

	it.each(['pointercancel', 'lostpointercapture', 'offscreen', 'hidden', 'pagehide', 'destroy', 'failure', 'reset'] as const)('ends a held station exactly once on %s', async reason => {
		const h = await stationReady({ reducedMotion: true })
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 30 })
		h.clock.advance(100)
		if (reason === 'offscreen') h.visible(false)
		else if (reason === 'hidden') h.hide(true)
		else if (reason === 'pagehide') emit(h.win, 'pagehide')
		else if (reason === 'destroy') h.controller.destroy()
		else if (reason === 'failure') h.factory.mock.calls[0][2]()
		else if (reason === 'reset') h.controller.reset()
		else h.pointer(reason)
		h.clock.advance(100)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.surface.captured.size).toBe(0)
		expect(h.clock.tasks.size).toBe(0)
		if (reason !== 'destroy') expect(h.states.at(-1)).toMatchObject({ stationDragging: false, stationHovered: false, dragging: false })
		if (reason === 'reset') expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		h.controller.destroy()
		expect(h.api.end).toHaveBeenCalledTimes(1)
	})

	it('continues a captured station outside the surface and ends an uncaptured leave', async () => {
		const h = await stationReady({ reducedMotion: true })
		h.pointer('pointerdown')
		h.pointer('pointerleave')
		expect(h.api.end).not.toHaveBeenCalled()
		expect(h.states.at(-1)?.stationDragging).toBe(true)
		h.surface.captured.delete(1)
		h.pointer('pointerleave')
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.states.at(-1)).toMatchObject({ stationDragging: false, stationHovered: false })
		h.click()
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.yaw).toBe(0)
	})

	it.each(['wheel', 'zoom-in', 'zoom-out', 'key', 'resize'] as const)('releases the station before %s changes its projection', async source => {
		const h = await stationReady({ reducedMotion: true })
		h.pointer('pointerdown')
		if (source === 'wheel') h.wheel()
		else if (source === 'zoom-in') h.controller.zoomIn()
		else if (source === 'zoom-out') h.controller.zoomOut()
		else if (source === 'key') h.key('+')
		else h.resizers[0].callback([], h.resizers[0] as unknown as ResizeObserver)
		h.pointer('pointermove', { clientX: 40 })
		h.clock.advance(100)
		expect(h.api.end).toHaveBeenCalledTimes(1)
		expect(h.api.move).not.toHaveBeenCalled()
		expect(h.surface.captured.size).toBe(0)
		expect(h.states.at(-1)?.stationDragging).toBe(false)
		expect(h.rendered.at(-1)!.pose.stationOrbit).toBe(0)
	})

	it('reports hover changes at bounded raycast cost without waking paused renders', async () => {
		const h = await stationReady({ reducedMotion: true })
		const renders = h.rendered.length
		const states = h.states.length
		h.pointer('pointermove')
		expect(h.states.at(-1)?.stationHovered).toBe(true)
		for (let i = 0; i < 90; i++) h.pointer('pointermove', { clientX: i })
		expect(h.api.hitTest).toHaveBeenCalledTimes(1)
		expect(h.states).toHaveLength(states + 1)
		h.clock.advance(100)
		h.pointer('pointermove')
		expect(h.api.hitTest).toHaveBeenCalledTimes(2)
		expect(h.states).toHaveLength(states + 1)
		h.pointer('pointermove', { shiftKey: true })
		expect(h.states.at(-1)?.stationHovered).toBe(false)
		h.pointer('pointerleave')
		h.pointer('pointermove')
		expect(h.states.at(-1)?.stationHovered).toBe(true)
		h.hide(true)
		expect(h.states.at(-1)?.stationHovered).toBe(false)
		expect(h.rendered).toHaveLength(renders)
		expect(h.clock.tasks.size).toBe(0)
	})
})

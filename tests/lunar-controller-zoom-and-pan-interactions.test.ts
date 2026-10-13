import { emit, flush, setup } from './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('zoom and pan interactions', () => {
	async function pausedReady() {
		const h = setup({ reducedMotion: true })
		await h.ready()
		h.controller.reset()
		await flush()
		h.clock.advance(100)
		return h
	}

	it('zooms around the cursor once while paused, without changing the 4K buffer or scheduling idle frames', async () => {
		const h = await pausedReady()
		const count = h.rendered.length
		const resizes = h.scene.resize.mock.calls.length
		const before = h.state!.resolution
		expect(h.wheel().defaultPrevented).toBe(true)
		h.clock.advance(1000)
		const { view, pose } = h.rendered.at(-1)!
		const anchor = { x: 150 / h.host.clientWidth - .5, y: 80 / h.host.clientHeight - .5 }
		expect(view.zoom).toBeCloseTo(Math.exp(.2))
		expect(view.zoom * anchor.x + view.panX).toBeCloseTo(anchor.x)
		expect(view.zoom * anchor.y + view.panY).toBeCloseTo(anchor.y)
		expect(pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		expect(h.rendered).toHaveLength(count + 1)
		expect(h.scene.resize).toHaveBeenCalledTimes(resizes)
		expect(h.state!.resolution).toEqual(before)
		expect(h.state!.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('clamps wheel and button zoom to 1×–6×, normalizes deltaMode, and Home resets zoom and pan', async () => {
		const h = await pausedReady()
		h.wheel({ deltaY: -3, deltaMode: 1 })
		expect(h.state!.zoom).toBeCloseTo(Math.exp(.096))
		for (let i = 0; i < 60; i++) h.wheel({ deltaY: -10000 })
		expect(h.state!.zoom).toBe(LUNAR_ZOOM.max)
		h.controller.zoomIn()
		expect(h.state!.zoom).toBe(LUNAR_ZOOM.max)
		h.key('Home')
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.view).toEqual(defaultLunarView())
		for (let i = 0; i < 60; i++) h.controller.zoomOut()
		expect(h.state!.zoom).toBe(LUNAR_ZOOM.min)
		h.key('+')
		expect(h.state!.zoom).toBe(1.25)
		h.key('-')
		expect(h.state!.zoom).toBe(1)
	})

	it('leaves wheels on poster, loading, fallback, hidden view and other elements untouched', async () => {
		const h = setup({ reducedMotion: true, deferred: true })
		await h.ready()
		expect(h.wheel().defaultPrevented).toBe(false)
		expect(h.factory).not.toHaveBeenCalled()
		h.controller.zoomIn()
		expect(h.wheel().defaultPrevented).toBe(false)
		h.resolve()
		await flush()
		h.visible(false)
		expect(h.wheel().defaultPrevented).toBe(false)
		h.visible(true)
		expect(emit(h.win, 'wheel', { deltaY: -100 }).defaultPrevented).toBe(false)
		h.factory.mock.calls[0][2]()
		expect(h.wheel().defaultPrevented).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('pinches with a nonprimary second touch and pans around its midpoint without rotating or a release jump', async () => {
		const h = await pausedReady()
		h.pointer('pointerdown', { pointerType: 'touch', clientX: 80, clientY: 80 })
		h.pointer('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 120, clientY: 80 })
		expect(h.surface.captured.size).toBe(2)
		expect(h.state!.dragging).toBe(true)
		expect(h.pointer('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 160, clientY: 80 }).defaultPrevented).toBe(true)
		h.clock.advance(100)
		const view = h.rendered.at(-1)!.view
		expect(view.zoom).toBe(2)
		expect((100 / 206 - .5) * view.zoom + view.panX).toBeCloseTo(120 / 206 - .5)
		expect(h.rendered.at(-1)!.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		h.pointer('pointerup', { pointerType: 'touch', pointerId: 2 })
		h.pointer('pointermove', { pointerType: 'touch', clientX: 180, clientY: 100 })
		h.click()
		h.pointer('pointerup', { pointerType: 'touch' })
		h.click()
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.view).toEqual(view)
		expect(h.rendered.at(-1)!.pose.yaw).toBe(0)
		expect(h.surface.captured.size).toBe(0)
		expect(h.clock.tasks.size).toBe(0)
		// A fresh single finger still rotates the planet normally.
		h.pointer('pointerdown', { pointerType: 'touch' })
		h.pointer('pointermove', { pointerType: 'touch', clientX: 30 })
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.yaw).toBeGreaterThan(0)
	})

	it('Shift-drag pans the magnified scene with bounds, while ordinary drag still rotates', async () => {
		const h = await pausedReady()
		for (let i = 0; i < 4; i++) h.controller.zoomIn()
		h.pointer('pointerdown', { shiftKey: true })
		h.pointer('pointermove', { clientX: -50, clientY: -20 })
		h.clock.advance(100)
		let last = h.rendered.at(-1)!
		expect(last.view.panX).toBeCloseTo(-50 / 206)
		expect(last.view.panY).toBeCloseTo(-20 / 154)
		expect(last.pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		h.pointer('pointermove', { clientX: -10000, clientY: 10000 })
		h.clock.advance(100)
		last = h.rendered.at(-1)!
		expect(last.view.panX).toBe(-(last.view.zoom - 1) / 2)
		expect(last.view.panY).toBe((last.view.zoom - 1) / 2)
		h.pointer('pointerup')
		h.click()
		h.pointer('pointerdown')
		h.pointer('pointermove', { clientX: 30 })
		h.clock.advance(100)
		expect(h.rendered.at(-1)!.pose.yaw).toBeGreaterThan(0)
	})

	it.each(['offscreen', 'hidden', 'destroy', 'failure', 'pointercancel', 'lostpointercapture'])('cleans up a two-finger gesture on %s', async reason => {
		const h = await pausedReady()
		h.pointer('pointerdown', { pointerType: 'touch', clientX: 50 })
		h.pointer('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 100 })
		h.pointer('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 150 })
		if (reason === 'offscreen') h.visible(false)
		else if (reason === 'hidden') h.hide(true)
		else if (reason === 'destroy') h.controller.destroy()
		else if (reason === 'failure') h.factory.mock.calls[0][2]()
		else {
			h.pointer(reason, { pointerType: 'touch', pointerId: 2 })
			h.pointer('pointerup', { pointerType: 'touch' })
			h.clock.advance(100)
		}
		expect(h.surface.captured.size).toBe(0)
		expect(h.clock.tasks.size).toBe(0)
		if (reason === 'destroy') expect(h.surface.listenerCount).toBe(0)
	})
})


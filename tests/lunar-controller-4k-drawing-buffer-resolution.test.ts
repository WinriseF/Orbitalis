import { setup } from './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('fixed 4K drawing-buffer resolution', () => {
	it.each([
		[1920, 1080, 3840, 2160],
		[1280, 720, 3840, 2160],
		[480, 270, 3840, 2160],
		[3840, 2160, 3840, 2160],
		[1080, 1920, 2160, 3840],
		[390, 844, 1774, 3840],
		[280, 900, 1195, 3840],
		[1600, 1200, 3840, 2880]
	])('targets %ix%i CSS pixels as %ix%i real pixels', (width, height, actualWidth, actualHeight) => {
		const ratio = lunarPixelRatio(width, height)
		expect(Math.round(width * ratio)).toBe(actualWidth)
		expect(Math.round(height * ratio)).toBe(actualHeight)
		expect(Math.max(actualWidth, actualHeight)).toBe(LUNAR_BUDGET.renderLongEdge)
	})

	it.each([0.5, 1, 2, 3, 5])('never lowers resolution for device DPR or zoom ratio %s', async deviceRatio => {
		const h = setup()
		h.win.devicePixelRatio = deviceRatio
		h.host.clientWidth = 1920
		h.host.clientHeight = 1080
		await h.ready()
		expect(h.scene.resize).toHaveBeenLastCalledWith(1920, 1080, 2)
		expect(h.state?.resolution).toEqual({ width: 3840, height: 2160, requestedWidth: 3840, requestedHeight: 2160, limited: false })
	})

	it('uses fixed 4K on first load and redraws once after a settled resize without restarting motion', async () => {
		const h = setup()
		h.host.clientWidth = 1600
		h.host.clientHeight = 1200
		await h.ready()
		expect(h.scene.resize).toHaveBeenLastCalledWith(1600, 1200, 2.4)
		h.clock.advance(6000)
		h.controller.toggleRotation()
		h.clock.advance(1000)
		const count = h.rendered.length
		h.host.clientWidth = 400
		h.host.clientHeight = 300
		h.resizers[0].callback([], h.resizers[0] as unknown as ResizeObserver)
		h.clock.advance(1000)
		expect(h.scene.resize).toHaveBeenLastCalledWith(400, 300, 9.6)
		expect(h.rendered).toHaveLength(count + 1)
		expect(h.state?.resolution).toEqual({ width: 3840, height: 2880, requestedWidth: 3840, requestedHeight: 2880, limited: false })
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('passes actual hardware-limited dimensions to the UI and clears them on fallback', async () => {
		const h = setup()
		const result = { width: 2048, height: 1152, requestedWidth: 3840, requestedHeight: 2160, limited: true }
		h.scene.resize.mockReturnValue(result)
		await h.ready()
		expect(h.state?.resolution).toEqual(result)
		h.clock.advance(6000)
		expect(h.state?.rotating).toBe(true)
		h.factory.mock.calls[0][2]()
		expect(h.state).toMatchObject({ phase: 'fallback', resolution: null, rotating: false })
	})
})


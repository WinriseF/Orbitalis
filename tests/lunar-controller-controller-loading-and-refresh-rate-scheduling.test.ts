import { flush, setup } from './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('lunar controller loading and refresh-rate scheduling', () => {
	it('does not import or create a scene before visible, including an offscreen gesture', async () => {
		const h = setup()
		h.click()
		h.clock.advance(60_000)
		expect(h.factory).not.toHaveBeenCalled()
		expect(h.clock.tasks.size).toBe(0)
		await h.ready()
		expect(h.factory).toHaveBeenCalledTimes(1)
		expect(h.state?.phase).toBe('ready')
	})

	it.each(['motion', 'data'] as const)('%s preference keeps the poster and avoids Three until a gesture', async preference => {
		const h = setup(preference === 'motion' ? { reducedMotion: true } : { saveData: true })
		await h.ready()
		h.clock.advance(30_000)
		expect(h.factory).not.toHaveBeenCalled()
		expect(h.clock.tasks.size).toBe(0)
		h.click()
		await flush()
		h.clock.advance(1000)
		expect(h.factory).toHaveBeenCalledTimes(1)
		expect(h.state).toMatchObject({ phase: 'ready', rotating: false })
		expect(h.rendered.at(-1)?.pose.yaw).toBeCloseTo(Math.PI / 8)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('keeps independent motion active well beyond five seconds until explicitly paused', async () => {
		const h = setup()
		await h.ready()
		h.clock.advance(6000)
		const first = h.rendered.at(-1)!.pose
		expect(h.state?.rotating).toBe(true)
		expect(h.clock.tasks.size).toBeGreaterThan(0)
		h.clock.advance(54_000)
		const later = h.rendered.at(-1)!
		expect(later.time).toBeGreaterThan(59_900)
		expect(later.pose.yaw).toBeGreaterThan(first.yaw)
		expect(later.pose.orbit).toBeGreaterThan(first.orbit + 10)
		expect(h.state?.rotating).toBe(true)
		h.controller.toggleRotation()
		h.clock.advance(1000)
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
		const count = h.rendered.length
		h.clock.advance(60_000)
		expect(h.rendered).toHaveLength(count)
	})

	it('keeps asteroid time advancing while the planet is held for dragging', async () => {
		const h = setup()
		await h.ready()
		h.clock.advance(1000)
		h.pointer('pointerdown')
		h.clock.advance(100)
		const held = h.rendered.at(-1)!.pose
		h.clock.advance(1000)
		const later = h.rendered.at(-1)!.pose
		expect(later.yaw).toBeCloseTo(held.yaw, 10)
		expect(later.orbit).toBeGreaterThan(held.orbit + 0.2)
	})

	it('explicit play respects accessibility override and stays on and pause settles to no pending callbacks', async () => {
		const h = setup({ reducedMotion: true })
		await h.ready()
		h.controller.toggleRotation()
		await flush()
		h.clock.advance(10_000)
		expect(h.state?.rotating).toBe(true)
		expect(h.rendered.at(-1)!.time).toBeGreaterThan(9500)
		h.controller.toggleRotation()
		h.clock.advance(1000)
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it('deduplicates repeated play/click gestures while the scene is loading', async () => {
		const h = setup({ reducedMotion: true, deferred: true })
		await h.ready()
		h.controller.toggleRotation()
		h.controller.toggleRotation()
		h.click()
		h.key('ArrowRight')
		expect(h.factory).toHaveBeenCalledTimes(1)
		h.resolve()
		await flush()
		h.clock.advance(2000)
		expect(h.state?.rotating).toBe(false)
		expect(h.clock.tasks.size).toBe(0)
	})

	it.each([60, 120, 144])('renders every available automatic frame at %i Hz without timer scheduling', async refreshRate => {
		const h = setup({ refreshRate })
		await h.ready()
		expect(h.clock.tasks.size).toBe(1)
		h.clock.advance(h.clock.frameDuration)
		expect(h.rendered).toHaveLength(1)
		expect(h.rendered[0].pose).toEqual({ yaw: 0, pitch: 0, orbit: 0, stationOrbit: 0 })
		h.clock.advance(2000)
		expect(h.rendered).toHaveLength(1 + 2 * refreshRate)
		expect(h.rendered).toHaveLength(h.clock.rafExecutions)
		for (let i = 1; i < h.rendered.length; i++) {
			expect(h.rendered[i].time - h.rendered[i - 1].time).toBeCloseTo(h.clock.frameDuration, 8)
		}
		expect(h.rendered.at(-1)!.pose.orbit).toBeCloseTo(.48, 10)
		expect(h.rendered.at(-1)!.pose.stationOrbit).toBeCloseTo(.48, 10)
		expect(h.win.setTimeout).not.toHaveBeenCalled()
		expect(h.win.clearTimeout).not.toHaveBeenCalled()
		expect(h.clock.tasks.size).toBe(1)
	})

	it('keeps equal elapsed-time ring/station progression and nearly equal planet motion across refresh rates', async () => {
		const poses: LunarPose[] = []
		for (const refreshRate of [60, 120, 144]) {
			const h = setup({ refreshRate })
			await h.ready()
			h.clock.advance(h.clock.frameDuration)
			h.clock.advance(5000)
			const pose = h.rendered.at(-1)!.pose
			poses.push(pose)
			expect(pose.orbit).toBeCloseTo(1.2, 10)
			expect(pose.stationOrbit).toBeCloseTo(1.2, 10)
			// Exponential smoothing has a small discrete-step lag; rotation speed stays time-based.
			expect(pose.yaw).toBeCloseTo(.375 - (.075 / refreshRate) / Math.expm1(18 / refreshRate), 10)
			h.controller.destroy()
		}
		for (const pose of poses.slice(1)) {
			expect(pose.orbit).toBeCloseTo(poses[0].orbit, 10)
			expect(pose.stationOrbit).toBeCloseTo(poses[0].stationOrbit!, 10)
			expect(pose.yaw).toBeCloseTo(poses[0].yaw, 3)
			expect(pose.pitch).toBe(poses[0].pitch)
		}
	})

	it.each([60, 120, 144].flatMap(refreshRate => [false, true].map(paused => ({ refreshRate, paused }))))(
		'renders once per $refreshRate Hz frame under high-frequency input (paused: $paused)', async ({ refreshRate, paused }) => {
			const h = setup({ refreshRate, reducedMotion: paused })
			await h.ready()
			if (paused) {
				h.controller.reset()
				await flush()
			}
			h.clock.advance(h.clock.frameDuration)
			h.rendered.length = 0
			const callbacks = h.clock.rafExecutions
			h.pointer('pointerdown')
			for (let i = 1; i <= refreshRate * 4; i++) {
				// Four input bursts per display tick cannot create concurrent animation loops.
				h.pointer('pointermove', { clientX: i * 6, clientY: i % 20 })
				h.wheel({ deltaY: i % 2 ? -1 : 1 })
				h.key(i % 2 ? 'ArrowRight' : 'ArrowLeft')
				expect(h.clock.tasks.size).toBe(1)
				expect([...h.clock.tasks.values()][0].type).toBe('raf')
				h.clock.advance(h.clock.frameDuration / 4)
			}
			expect(h.rendered).toHaveLength(refreshRate)
			expect(h.clock.rafExecutions - callbacks).toBe(refreshRate)
			expect(new Set(h.rendered.map(frame => frame.time)).size).toBe(refreshRate)
			for (let i = 1; i < h.rendered.length; i++) {
				expect(h.rendered[i].time - h.rendered[i - 1].time).toBeCloseTo(h.clock.frameDuration, 8)
			}
			expect(h.win.setTimeout).not.toHaveBeenCalled()
			expect(h.win.clearTimeout).not.toHaveBeenCalled()
			h.pointer('pointerup')
			if (paused) expect(h.clock.tasks.size).toBe(0)
			else expect(h.clock.tasks.size).toBe(1)
		}
	)

	it.each([60, 120, 144])('resumes a settled explicit pause at %i Hz without inventing an elapsed first frame', async refreshRate => {
		const h = setup({ refreshRate })
		await h.ready()
		h.clock.advance(1000)
		h.controller.toggleRotation()
		h.clock.advance(1000)
		expect(h.clock.tasks.size).toBe(0)
		const before = h.rendered.at(-1)!.pose
		h.clock.advance(60_000)
		h.controller.toggleRotation()
		h.clock.advance(h.clock.frameDuration)
		expect(h.rendered.at(-1)!.pose).toEqual(before)
		h.clock.advance(h.clock.frameDuration)
		expect(h.rendered.at(-1)!.pose.orbit - before.orbit).toBeCloseTo(.24 / refreshRate, 10)
	})

	it('guards a long foreground stall without skipping any delivered animation callback', async () => {
		const h = setup({ refreshRate: 144 })
		await h.ready()
		h.clock.advance(1000)
		const before = h.rendered.at(-1)!
		const [id, pending] = [...h.clock.tasks][0]
		h.clock.tasks.delete(id)
		h.clock.now += 5000
		pending.run()
		const after = h.rendered.at(-1)!
		expect(after.pose.orbit - before.pose.orbit).toBeCloseTo(.1 * .24, 10)
		expect(after.pose.stationOrbit! - before.pose.stationOrbit!).toBeCloseTo(.1 * .24, 10)
		expect(h.rendered).toHaveLength(h.clock.rafExecutions)
		expect(h.clock.tasks.size).toBe(1)
		h.clock.advance(h.clock.frameDuration)
		expect(h.rendered.at(-1)!.pose.orbit - after.pose.orbit).toBeCloseTo(.24 / 144, 10)
		expect(h.win.setTimeout).not.toHaveBeenCalled()
	})
})


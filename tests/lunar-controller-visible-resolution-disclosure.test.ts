import './helpers/lunar-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLunarController, LUNAR_BUDGET, lunarPixelRatio, LunarGpuMemoryError, LunarTextureLimitError, type LunarState } from '../src/lunar-controller'
import type { LunarPose, LunarResolution, LunarScene } from '../src/lunar-scene'
import { defaultLunarView, LUNAR_ZOOM, type LunarView } from '../src/lunar-view'

describe('visible resolution disclosure', () => {
	it('shows actual 4K pixels, device limitation and static fallback without offering lower-resolution options', async () => {
		class Element extends EventTarget {
			classList = { toggle: vi.fn() }
			dataset: Record<string, string> = {}
			setAttribute = vi.fn()
			disabled = false
			textContent = ''
			innerHTML = ''
		}
		const ids = ['lunar-surface', 'lunar-canvas', 'lunar-poster', 'rotation-toggle', 'reset-view', 'scene-status', 'scene-resolution', 'scene-mode', 'rotation-label', 'rotation-icon', 'zoom-in', 'zoom-out', 'zoom-level']
		const elements = Object.fromEntries(ids.map(id => [id, new Element()]))
		const controls = { toggleRotation: vi.fn(), reset: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), destroy: vi.fn() }
		let report!: (state: LunarState) => void
		vi.stubGlobal('document', { querySelector: (selector: string) => elements[selector.slice(1)] })
		vi.stubGlobal('window', new EventTarget())
		vi.doMock('../src/lunar-controller', () => ({
			attachLunarController: (_surface: unknown, _host: unknown, onChange: typeof report) => { report = onChange; return controls }
		}))
		try {
			await import('../src/main')
			const ready: LunarState = { phase: 'ready', rotating: true, dragging: false, zoom: 1, fallbackReason: null, resolution: { width: 3840, height: 2160, requestedWidth: 3840, requestedHeight: 2160, limited: false } }
			report(ready)
			expect(elements['scene-resolution'].textContent).toBe('4K · 3840 × 2160 · 长边 3840')
			expect(elements['scene-resolution'].dataset.limited).toBe('false')
			report({ ...ready, resolution: { ...ready.resolution!, width: 2048, height: 1152, limited: true } })
			expect(elements['scene-resolution'].textContent).toBe('当前设备未达到 4K · 实际 2048 × 1152')
			expect(elements['scene-resolution'].dataset.limited).toBe('true')
			report({ ...ready, phase: 'fallback', rotating: false, resolution: null })
			expect(elements['scene-mode'].textContent).toBe('STATIC PREVIEW')
			expect(elements['scene-resolution'].textContent).toBe('静态预览 · 非实时 4K')
			expect(elements['rotation-toggle'].disabled).toBe(true)
			expect(elements['reset-view'].disabled).toBe(true)
			expect(elements['scene-status'].textContent).toBe('当前为静态预览，三维未能启动')
			report({ ...ready, phase: 'fallback', rotating: false, resolution: null, fallbackReason: { kind: 'texture-limit', width: 7680, height: 3840, maxTextureSize: 4096 } })
			const honestNotice = '当前为静态预览：原始纹理 7680 × 3840 超出设备纹理上限 4096 × 4096，未缩小纹理'
			expect(elements['scene-status'].textContent).toBe(honestNotice)
			expect(elements['lunar-surface'].setAttribute).toHaveBeenCalledWith('aria-label', honestNotice)
			expect(elements['lunar-poster'].classList.toggle).toHaveBeenLastCalledWith('is-hidden', false)
			expect(elements['lunar-canvas'].classList.toggle).toHaveBeenLastCalledWith('is-ready', false)
			expect(elements['scene-mode'].textContent).toBe('STATIC PREVIEW')
			expect(elements['scene-resolution'].textContent).toBe('静态预览 · 非实时 4K')
			expect(elements['scene-status'].textContent).not.toMatch(/8K|8192|LIVE/)
			report({ ...ready, resolution: null })
			expect(elements['scene-resolution'].textContent).toBe('实时三维 · 分辨率未确认')
			report({ ...ready, phase: 'loading', resolution: null })
			expect(elements['scene-resolution'].textContent).toContain('等待确认实际分辨率')
			elements['rotation-toggle'].dispatchEvent(new Event('click'))
			elements['reset-view'].dispatchEvent(new Event('click'))
			expect(controls.toggleRotation).toHaveBeenCalledTimes(1)
			expect(controls.reset).toHaveBeenCalledTimes(1)
			elements['zoom-in'].dispatchEvent(new Event('click'))
			elements['zoom-out'].dispatchEvent(new Event('click'))
			expect(controls.zoomIn).toHaveBeenCalledTimes(1)
			expect(controls.zoomOut).toHaveBeenCalledTimes(1)
			report({ ...ready, zoom: 6 })
			expect(elements['zoom-in'].disabled).toBe(true)
			expect(elements['zoom-out'].disabled).toBe(false)
			expect(elements['zoom-level'].textContent).toBe('6×')
			report(ready)
			expect(elements['zoom-out'].disabled).toBe(true)
			expect(elements['zoom-in'].disabled).toBe(false)
			report({ ...ready, phase: 'fallback' })
			expect(elements['zoom-in'].disabled).toBe(true)
			expect(elements['zoom-out'].disabled).toBe(true)
		} finally {
			vi.doUnmock('../src/lunar-controller')
		}
	})
})


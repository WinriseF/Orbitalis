import { describe, expect, it } from 'vitest'
import { clampLunarView, defaultLunarView, lunarWheelFactor, zoomLunarView } from '../src/lunar-view'

describe('bounded view-space zoom', () => {
  it('bounds zoom and pan, with exactly original framing at 1×', () => {
    expect(clampLunarView({ zoom: 99, panX: -99, panY: 99 })).toEqual({ zoom: 6, panX: -2.5, panY: 2.5 })
    expect(clampLunarView({ zoom: -99, panX: -99, panY: 99 })).toEqual(defaultLunarView())
    expect(clampLunarView({ zoom: NaN, panX: Infinity, panY: NaN })).toEqual(defaultLunarView())
  })

  it('preserves the point beneath a noncentral cursor at the zoom limit and on the way back', () => {
    const anchor = { x: 0.31, y: 0.23 }
    const view = zoomLunarView(defaultLunarView(), 30, anchor)
    expect(view.zoom).toBe(6)
    expect(anchor.x * view.zoom + view.panX).toBeCloseTo(anchor.x, 12)
    expect(anchor.y * view.zoom + view.panY).toBeCloseTo(anchor.y, 12)
    const next = zoomLunarView(view, 2, anchor)
    expect(anchor.x * next.zoom + next.panX).toBeCloseTo(anchor.x, 12)
    expect(anchor.y * next.zoom + next.panY).toBeCloseTo(anchor.y, 12)
    expect(zoomLunarView(next, 1, anchor)).toEqual(defaultLunarView())
  })

  it('moves the old pinch midpoint to the new one while magnifying around it', () => {
    const before = { x: 0.2, y: 0.15 }
    const after = { x: -0.05, y: 0.05 }
    const view = zoomLunarView(defaultLunarView(), 3, before, after)
    expect(before.x * view.zoom + view.panX).toBeCloseTo(after.x)
    expect(before.y * view.zoom + view.panY).toBeCloseTo(after.y)
  })

  it('normalizes line/page wheels and caps large deltas', () => {
    expect(lunarWheelFactor(-3, 1, 700)).toBe(lunarWheelFactor(-48, 0, 700))
    expect(lunarWheelFactor(-0.1, 2, 700)).toBe(lunarWheelFactor(-70, 0, 700))
    expect(lunarWheelFactor(-50000, 0, 700)).toBe(lunarWheelFactor(-120, 0, 700))
    expect(lunarWheelFactor(NaN, 0, 700)).toBe(1)
  })
})

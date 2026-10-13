/** View-space fractions use the viewport center as (0, 0); positive y points down. */
export type LunarView = { zoom: number; panX: number; panY: number }
export type LunarViewPoint = { x: number; y: number }
export const LUNAR_ZOOM = { min: 1, max: 6, buttonFactor: 1.25 } as const
export const defaultLunarView = (): LunarView => ({ zoom: 1, panX: 0, panY: 0 })

/** Keep the zoomed viewport inside its original framing, including after a resize. */
export function clampLunarView(view: LunarView): LunarView {
  const zoom = Math.max(LUNAR_ZOOM.min, Math.min(LUNAR_ZOOM.max, Number.isFinite(view.zoom) ? view.zoom : 1))
  const bound = (zoom - 1) / 2
  const clamp = (value: number) => Math.max(-bound, Math.min(bound, Number.isFinite(value) ? value : 0))
  return { zoom, panX: clamp(view.panX) || 0, panY: clamp(view.panY) || 0 }
}

/** screenNew = ratio * (screenOld - oldAnchor) + newAnchor. */
export function zoomLunarView(view: LunarView, zoom: number, anchor: LunarViewPoint, nextAnchor = anchor): LunarView {
  const bounded = clampLunarView({ ...view, zoom }).zoom
  const ratio = bounded / view.zoom
  return clampLunarView({ zoom: bounded, panX: nextAnchor.x + ratio * (view.panX - anchor.x), panY: nextAnchor.y + ratio * (view.panY - anchor.y) })
}

export function lunarWheelFactor(deltaY: number, deltaMode: number, height: number) {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, height) : 1)
  return Math.exp(-Math.max(-120, Math.min(120, Number.isFinite(pixels) ? pixels : 0)) * 0.002)
}

import { attachLunarController, type LunarState } from './lunar-controller'
import { LUNAR_ZOOM } from './lunar-view'

const surface = document.querySelector<HTMLButtonElement>('#lunar-surface')!
const host = document.querySelector<HTMLElement>('#lunar-canvas')!
const poster = document.querySelector<HTMLImageElement>('#lunar-poster')!
const toggle = document.querySelector<HTMLButtonElement>('#rotation-toggle')!
const reset = document.querySelector<HTMLButtonElement>('#reset-view')!
const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')!
const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')!
const zoomLevel = document.querySelector<HTMLOutputElement>('#zoom-level')!
const status = document.querySelector<HTMLElement>('#scene-status')!
const resolution = document.querySelector<HTMLElement>('#scene-resolution')!
const mode = document.querySelector<HTMLElement>('#scene-mode')!
const toggleLabel = document.querySelector<HTMLElement>('#rotation-label')!
const toggleIcon = document.querySelector<HTMLElement>('#rotation-icon')!
const stateChange = (state: LunarState) => {
  const ready = state.phase === 'ready'
  const fallback = state.phase === 'fallback'
  const reason = state.fallbackReason
  const fallbackNotice = reason?.kind === 'texture-limit'
    ? `当前为静态预览：原始纹理 ${reason.width} × ${reason.height} 超出设备纹理上限 ${reason.maxTextureSize} × ${reason.maxTextureSize}，未缩小纹理`
    : reason?.kind === 'gpu-memory'
      ? '当前为静态预览：图形内存不足，无法载入完整原始纹理；未降低分辨率'
      : '当前为静态预览，三维未能启动'
  poster.classList.toggle('is-hidden', ready)
  host.classList.toggle('is-ready', ready)
  surface.dataset.phase = state.phase
  surface.dataset.dragging = String(state.dragging || state.stationDragging)
  surface.dataset.stationHover = String(!!state.stationHovered)
  surface.dataset.stationDragging = String(!!state.stationDragging)
  surface.setAttribute('aria-disabled', String(fallback))
  surface.setAttribute('aria-busy', String(state.phase === 'loading'))
  surface.setAttribute('aria-label', fallback ? fallbackNotice : '探索场景：拖星球旋转，持续拖空间站前后环绕，调整位置与轨道倾角；滚轮或双指缩放，Shift 拖动平移，方向键调整星球，加减键缩放，Home 复位')
  toggle.disabled = reset.disabled = fallback
  zoomIn.disabled = fallback || state.zoom >= LUNAR_ZOOM.max
  zoomOut.disabled = fallback || state.zoom <= LUNAR_ZOOM.min
  zoomLevel.textContent = `${Number(state.zoom.toFixed(1))}×`
  toggle.setAttribute('aria-pressed', String(state.rotating))
  toggle.setAttribute('aria-label', state.rotating ? '暂停自动旋转' : '开启自动旋转')
  toggleLabel.textContent = state.rotating ? '暂停旋转' : '自动旋转'
  toggleIcon.innerHTML = state.rotating ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zm5 0h3v10H9z"/></svg>' : '<svg viewBox="0 0 16 16" fill="currentColor"><path d="m5 3 8 5-8 5z"/></svg>'
  mode.textContent = ready ? 'LIVE · 3D · 16K TEXTURE' : fallback ? 'STATIC PREVIEW' : 'ORBITAL STUDY'
  const pixels = state.resolution
  const resolutionText = ready && pixels
    ? pixels.limited
      ? `当前设备未达到 4K · 实际 ${pixels.width} × ${pixels.height}`
      : `4K · ${pixels.width} × ${pixels.height} · 长边 3840`
    : ready ? '实时三维 · 分辨率未确认' : fallback ? '静态预览 · 非实时 4K' : state.phase === 'loading' ? '4K 三维载入中 · 等待确认实际分辨率' : '静态预览 · 交互后载入 4K 三维'
  resolution.dataset.limited = String(ready && !!pixels?.limited)
  if (resolution.textContent !== resolutionText) resolution.textContent = resolutionText
  status.textContent = state.phase === 'loading' ? '正在载入完整 16K 纹理与环形空间站…' : fallback ? fallbackNotice : state.phase === 'poster' ? '点击星球，开启交互' : state.stationDragging ? '持续拖动空间站 · 可绕到星球前后' : state.stationHovered ? '按住空间站拖动 · 前后环绕' : state.rotating ? '空间站公转 · 圆环独立自转中' : '动态已暂停 · 拖动旋转 / 缩放查看'
}
const controller = attachLunarController(surface, host, stateChange)
toggle.addEventListener('click', () => controller.toggleRotation())
reset.addEventListener('click', () => controller.reset())
zoomIn.addEventListener('click', () => controller.zoomIn())
zoomOut.addEventListener('click', () => controller.zoomOut())
window.addEventListener('pagehide', event => { if (!event.persisted) controller.destroy() })

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 图表放大预览层（全屏 lightbox）。
 *
 * Mermaid / PlantUML 图在正文里受容器宽度限制，很多大图缩得很小看不清。
 * 点击图块后在这里放大查看，支持滚轮缩放、拖拽平移、双击复位、ESC 关闭。
 *
 * 关键坑：mermaid 输出的 SVG 带 width="100%"（useMaxWidth），在未定宽的
 * flex 容器里会塌缩成 0（宽度 100% 相对一个宽度由内容决定的容器 → 循环依赖）。
 * 所以这里从 viewBox 读回原始宽高，给 SVG 一个明确的像素尺寸再渲染。
 */
const props = defineProps<{
  svg: string
  title?: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

const stageRef = ref<HTMLElement>()
const viewportRef = ref<HTMLElement>()

// 拖拽状态
let dragging = false
let lastX = 0
let lastY = 0

const MIN_SCALE = 0.1
const MAX_SCALE = 8

// 从 SVG 字符串解析出原始宽高（优先 viewBox，其次 width/height 属性）
function parseSvgSize(svgStr: string): { w: number; h: number } {
  const el = document.createElement('div')
  el.innerHTML = svgStr
  const svgEl = el.querySelector('svg')
  if (!svgEl) return { w: 800, h: 600 }

  const vb = svgEl.getAttribute('viewBox')
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] }
    }
  }

  const parseLen = (v: string | null) => {
    if (!v) return 0
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const w = parseLen(svgEl.getAttribute('width'))
  const h = parseLen(svgEl.getAttribute('height'))
  if (w > 0 && h > 0) return { w, h }

  return { w: 800, h: 600 }
}

const svgSize = ref({ w: 800, h: 600 })

function clampScale(v: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

function zoomBy(factor: number) {
  const old = scale.value
  const next = clampScale(old * factor)
  if (next === old) return
  scale.value = next
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  zoomBy(factor)
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  stageRef.value?.setPointerCapture(e.pointerId)
  document.body.style.cursor = 'grabbing'
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  tx.value += e.clientX - lastX
  ty.value += e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
}

function onPointerUp(e: PointerEvent) {
  dragging = false
  document.body.style.cursor = ''
  try {
    stageRef.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* noop */
  }
}

function onDoubleClick() {
  reset()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === '+' || e.key === '=') zoomBy(1.2)
  else if (e.key === '-') zoomBy(1 / 1.2)
  else if (e.key === '0') reset()
}

// 打开时：解析尺寸，并按「初始缩放」适配视口（大图缩到能完整看到）
function initSize() {
  svgSize.value = parseSvgSize(props.svg)
  fitToViewport()
}

function fitToViewport() {
  const vp = viewportRef.value
  if (!vp) return
  const vw = vp.clientWidth
  const vh = vp.clientHeight
  if (vw <= 0 || vh <= 0) return
  const { w, h } = svgSize.value
  // 留出边距，避免贴边
  const fit = Math.min(vw / w, vh / h, 1)
  scale.value = clampScale(fit)
  tx.value = 0
  ty.value = 0
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.body.style.overflow = 'hidden'
  initSize()
})

watch(
  () => props.svg,
  () => initSize(),
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
  document.body.style.cursor = ''
})

const zoomPct = () => Math.round(scale.value * 100)

/** 下载 SVG 为文件 */
function downloadSvg() {
  const { w, h } = svgSize.value
  // 克隆并规整尺寸：确保下载的 SVG 自带明确的宽高（不依赖 viewBox 之外的运行时样式）
  const el = document.createElement('div')
  el.innerHTML = props.svg
  const svgEl = el.querySelector('svg')
  if (!svgEl) return
  svgEl.setAttribute('width', String(w))
  svgEl.setAttribute('height', String(h))
  svgEl.removeAttribute('style') // 去掉可能干扰的运行时内联样式
  const xml = new XMLSerializer().serializeToString(svgEl)
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const base = (props.title || 'diagram').replace(/[\\/:*?"<>|]/g, '_')
  a.href = url
  a.download = `${base}.svg`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
</script>

<template>
  <Teleport to="body">
    <div class="diagram-lightbox" @click.self="emit('close')">
      <div class="dlb-toolbar">
        <span class="dlb-title">{{ title || '图表预览' }}</span>
        <span class="dlb-zoom">{{ zoomPct() }}%</span>
        <button class="dlb-btn" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
        <button class="dlb-btn" title="放大" @click="zoomBy(1.2)">＋</button>
        <button class="dlb-btn" title="适合窗口" @click="fitToViewport">适应</button>
        <button class="dlb-btn" title="复位" @click="reset">1:1</button>
        <button class="dlb-btn" title="下载 SVG" @click="downloadSvg">⭳ 下载</button>
        <button class="dlb-btn dlb-close" title="关闭 (Esc)" @click="emit('close')">✕</button>
      </div>

      <div
        ref="viewportRef"
        class="dlb-viewport"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onDoubleClick"
      >
        <div
          ref="stageRef"
          class="dlb-stage"
          :style="{
            width: svgSize.w + 'px',
            height: svgSize.h + 'px',
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          }"
          v-html="svg"
        />
      </div>

      <div class="dlb-hint">滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭</div>
    </div>
  </Teleport>
</template>

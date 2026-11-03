<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 图表放大预览层（全屏 lightbox）。
 *
 * Mermaid / PlantUML 图在正文里受容器宽度限制，很多大图缩得很小看不清。
 * 点击图块后在这里放大查看，支持滚轮缩放、拖拽平移、双击复位、ESC 关闭。
 *
 * 交互实现走原生 DOM（不依赖库）：缩放用 scale，平移用 translate，
 * 组合成 transform；滚轮缩放以鼠标位置为锚点，体验接近看图软件。
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
  // 只响应左键 / 单指
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

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.body.style.overflow = 'hidden'
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
  document.body.style.cursor = ''
})

const zoomPct = () => Math.round(scale.value * 100)
</script>

<template>
  <Teleport to="body">
    <div class="diagram-lightbox" @click.self="emit('close')">
      <div class="dlb-toolbar">
        <span class="dlb-title">{{ title || '图表预览' }}</span>
        <span class="dlb-zoom">{{ zoomPct() }}%</span>
        <button class="dlb-btn" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
        <button class="dlb-btn" title="放大" @click="zoomBy(1.2)">＋</button>
        <button class="dlb-btn" title="复位" @click="reset">1:1</button>
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
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          v-html="svg"
        />
      </div>

      <div class="dlb-hint">滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭</div>
    </div>
  </Teleport>
</template>

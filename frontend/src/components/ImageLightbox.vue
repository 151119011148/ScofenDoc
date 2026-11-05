<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 正文配图的全屏预览层。
 *
 * 文章里的图常被版心宽度压小（尤其 CSDN 存档里的截图），单击后在这里看大图。
 * 外壳和图表灯箱（DiagramLightbox）共用一套 .diagram-lightbox / .dlb-* 样式，
 * 交互也保持一致：滚轮缩放、拖拽平移、双击复位、Esc / 点空白处关闭。
 *
 * 与 SVG 灯箱的差别：图片尺寸要等 onload 才知道，且初始缩放允许 >1——
 * 小图不放大就失去「点击放大」的意义了。
 */
const props = defineProps<{
  src: string
  title?: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const natural = ref({ w: 0, h: 0 })
const failed = ref(false)
const imgRef = ref<HTMLImageElement>()
const viewportRef = ref<HTMLElement>()

const MIN_SCALE = 0.1
const MAX_SCALE = 12

let dragging = false
let moved = false
let lastX = 0
let lastY = 0
let startX = 0
let startY = 0

function clampScale(v: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

/** 适配窗口：留 24px 内边距；小图也放大到接近满屏 */
function fitToViewport() {
  const vp = viewportRef.value
  const { w, h } = natural.value
  if (!vp || w <= 0 || h <= 0) return
  const fit = Math.min((vp.clientWidth - 48) / w, (vp.clientHeight - 48) / h)
  if (!Number.isFinite(fit) || fit <= 0) return
  scale.value = clampScale(fit)
  tx.value = 0
  ty.value = 0
}

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

function zoomBy(factor: number) {
  const next = clampScale(scale.value * factor)
  if (next !== scale.value) scale.value = next
}

function onLoad() {
  const img = imgRef.value
  if (!img || !img.naturalWidth) return
  failed.value = false
  natural.value = { w: img.naturalWidth, h: img.naturalHeight }
  fitToViewport()
}

function onError() {
  failed.value = true
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  dragging = true
  moved = false
  lastX = startX = e.clientX
  lastY = startY = e.clientY
  viewportRef.value?.setPointerCapture(e.pointerId)
  document.body.style.cursor = 'grabbing'
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) moved = true
  tx.value += e.clientX - lastX
  ty.value += e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
}

function onPointerUp(e: PointerEvent) {
  dragging = false
  document.body.style.cursor = ''
  try {
    viewportRef.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* 指针已释放 */
  }
}

/** 点 viewport 空白处关闭；刚拖过图的那一拍不算点击 */
function onViewportClick(e: MouseEvent) {
  if (e.target !== viewportRef.value) return
  if (moved) {
    moved = false
    return
  }
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === '+' || e.key === '=') zoomBy(1.2)
  else if (e.key === '-') zoomBy(1 / 1.2)
  else if (e.key === '0') reset()
}

function openOriginal() {
  window.open(props.src, '_blank', 'noopener,noreferrer')
}

function onResize() {
  if (natural.value.w > 0) fitToViewport()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize)
  document.body.style.overflow = 'hidden'
  // 图片可能命中缓存、在绑定 @load 之前就完成了
  if (imgRef.value?.complete && imgRef.value.naturalWidth > 0) onLoad()
})

// 同一层里换图（连点不同图片）时重新按新图适配
watch(() => props.src, () => {
  failed.value = false
  natural.value = { w: 0, h: 0 }
  reset()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
  document.body.style.overflow = ''
  document.body.style.cursor = ''
})

const zoomPct = () => Math.round(scale.value * 100)
</script>

<template>
  <Teleport to="body">
    <div class="diagram-lightbox image-lightbox">
      <div class="dlb-toolbar">
        <span class="dlb-title">{{ title || '图片预览' }}</span>
        <span v-if="natural.w" class="dlb-zoom">{{ zoomPct() }}% · {{ natural.w }}×{{ natural.h }}</span>
        <button class="dlb-btn" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
        <button class="dlb-btn" title="放大" @click="zoomBy(1.2)">＋</button>
        <button class="dlb-btn" title="适合窗口" @click="fitToViewport">适应</button>
        <button class="dlb-btn" title="原始尺寸" @click="reset">1:1</button>
        <button class="dlb-btn" title="在新标签打开原图" @click="openOriginal">↗ 原图</button>
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
        @click="onViewportClick"
      >
        <div v-if="failed" class="ilb-msg">
          <b>图片加载失败</b>
          可能是外链原图已失效，可点右上角「原图」在新标签里确认。
        </div>
        <div v-else-if="!natural.w" class="ilb-msg">图片加载中…</div>
        <div
          v-else
          class="dlb-stage"
          :style="{
            width: natural.w + 'px',
            height: natural.h + 'px',
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          }"
          @dblclick="reset"
        >
          <img ref="imgRef" class="ilb-img" :src="src" :alt="title || ''" draggable="false" />
        </div>
        <!-- 图片未就绪时也要把 <img> 挂上，才能收到 load / error -->
        <img
          v-if="!natural.w && !failed"
          ref="imgRef"
          class="ilb-img"
          :src="src"
          :alt="title || ''"
          style="position: absolute; width: 1px; height: 1px; opacity: 0"
          draggable="false"
          @load="onLoad"
          @error="onError"
        />
      </div>

      <div class="dlb-hint">滚轮缩放 · 拖拽平移 · 双击复位 · 点空白处或 Esc 关闭</div>
    </div>
  </Teleport>
</template>

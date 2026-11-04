<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

/**
 * 当前文档的章节大纲：扫描正文编辑器里的 H1–H3，生成可点击跳转的目录。
 * 自带滚动高亮（当前章节高亮并保持在可视区）。独立于左侧的「文档树」，
 * 解决长文档（如 Netty）内部快速定位。
 *
 * 标题位置由调用方（App.vue）通过 editor + refresh 触发重扫，
 * 因为正文是 Yjs 协同、由 Tiptap 渲染，Vue 无法直接响应其 DOM 变化。
 */
interface Item {
  level: number
  text: string
  /** 标题元素本身：位置每次实时计算，避免正文异步渲染（图/表）后快照失效 */
  el: HTMLElement
}

const props = defineProps<{
  /** 正文滚动容器（.main），用于计算标题相对位置与滚动高亮 */
  scroller?: HTMLElement | null
  editor?: { view?: { dom?: HTMLElement } } | null
  /** 触发重扫的信号（每 +1 扫描一次标题） */
  refresh?: number
}>()

/** 点了某条大纲：手机上据此收起底部面板（桌面端忽略） */
const emit = defineEmits<{ (e: 'select'): void }>()

const items = ref<Item[]>([])
const activeId = ref<number | null>(null)

function collect(): Item[] {
  const dom = props.editor?.view?.dom
  if (!dom || !props.scroller) return []
  const heads = Array.from(dom.querySelectorAll('h1, h2, h3')) as HTMLElement[]
  const list: Item[] = []
  for (const h of heads) {
    // 跳过折叠后隐藏的标题（其祖先带 fold-hidden）
    if (h.closest('.fold-hidden')) continue
    const text = (h.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    list.push({
      level: Number(h.tagName.charAt(1)),
      text,
      el: h,
    })
  }
  return list
}

/** 标题相对滚动容器内容顶部的绝对偏移（实时读取，可随正文高度变化自适应） */
function offsetOf(el: HTMLElement): number {
  const scroller = props.scroller
  if (!scroller) return 0
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

/**
 * 跳转落点上方要留出的高度。
 *
 * 桌面就是一条呼吸留白（12px）；手机正文顶部有吸顶的编辑器工具栏，
 * 若只留 12px，标题第一行会被工具栏压住，所以由 CSS 变量 --jump-gap 给出更大值。
 * 数值只维护在 style.css 一处，这里只负责读。
 */
function jumpGap(): number {
  const scroller = props.scroller
  if (!scroller) return 12
  const v = parseFloat(getComputedStyle(scroller).getPropertyValue('--jump-gap'))
  return Number.isFinite(v) ? v : 12
}

const empty = computed(() => items.value.length === 0)

function refresh() {
  items.value = collect()
}

/**
 * 跳转到某个标题。
 *
 * 注意：这里必须用 offsetOf 重新读一次位置，不能再叠加 scrollTop——
 * offsetOf 返回的已经是「距内容顶部的绝对距离」，而 scrollTo 的 top 也是绝对值。
 * （旧实现用「预存绝对偏移 + 当前 scrollTop」，每点一次就多滚一个屏高。）
 */
function jump(item: Item, i: number) {
  const scroller = props.scroller
  if (!scroller) return
  const target = offsetOf(item.el) - jumpGap()
  scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  activeId.value = i
  emit('select')
}

let spyTimer: number | undefined
function spy() {
  if (spyTimer) return
  spyTimer = window.requestAnimationFrame(() => {
    spyTimer = undefined
    if (!props.scroller) return
    const y = props.scroller.scrollTop + 80
    let cur = -1
    // 实时读位置：正文里的图/表渲染完成后高度会变，用刷新时的快照会高亮错位
    items.value.forEach((it, i) => {
      if (offsetOf(it.el) <= y) cur = i
    })
    activeId.value = cur
    // 把当前项保持在面板可视区
    const listEl = document.querySelector('.outline-list') as HTMLElement | null
    const onEl = listEl?.querySelector('.outline-item.on') as HTMLElement | null
    if (listEl && onEl) {
      const top = onEl.offsetTop
      const vh = listEl.clientHeight
      if (top < listEl.scrollTop || top > listEl.scrollTop + vh - 40) {
        listEl.scrollTop = Math.max(0, top - vh / 3)
      }
    }
  })
}

watch(
  () => props.refresh,
  () => refresh(),
)

watch(
  () => props.editor,
  () => refresh(),
)

function onScroll() {
  spy()
}

function bindScroll() {
  props.scroller?.addEventListener('scroll', onScroll, { passive: true })
}

watch(
  () => props.scroller,
  (s, prev) => {
    prev?.removeEventListener('scroll', onScroll)
    if (s) {
      s.addEventListener('scroll', onScroll, { passive: true })
      refresh()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  props.scroller?.removeEventListener('scroll', onScroll)
  if (spyTimer) cancelAnimationFrame(spyTimer)
})
</script>

<template>
  <!-- 只负责列表本身：外框、标题、拖拽宽度都由 App 的中间栏控制 -->
  <div class="outline-body">
    <div v-if="empty" class="outline-empty">本文档暂无标题</div>
    <ul v-else class="outline-list">
      <li
        v-for="(item, i) in items"
        :key="i"
        :class="['outline-item', `lvl-${item.level}`, { on: i === activeId }]"
        @click="jump(item, i)"
      >
        {{ item.text }}
      </li>
    </ul>
  </div>
</template>

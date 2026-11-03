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
  top: number
}

const props = defineProps<{
  /** 正文滚动容器（.main），用于计算标题相对位置与滚动高亮 */
  scroller?: HTMLElement | null
  editor?: { view?: { dom?: HTMLElement } } | null
  /** 触发重扫的信号（每 +1 扫描一次标题） */
  refresh?: number
}>()

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
      top: h.getBoundingClientRect().top - props.scroller.getBoundingClientRect().top + props.scroller.scrollTop,
    })
  }
  return list
}

const empty = computed(() => items.value.length === 0)

function refresh() {
  items.value = collect()
}

function jump(item: Item, i: number) {
  if (!props.scroller) return
  const target = props.scroller.scrollTop + item.top - 12
  props.scroller.scrollTo({ top: target, behavior: 'smooth' })
  activeId.value = i
}

let spyTimer: number | undefined
function spy() {
  if (spyTimer) return
  spyTimer = window.requestAnimationFrame(() => {
    spyTimer = undefined
    if (!props.scroller) return
    const y = props.scroller.scrollTop + 80
    let cur = -1
    items.value.forEach((it, i) => {
      if (it.top <= y) cur = i
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
  <aside class="outline-panel">
    <div class="outline-head">大纲</div>
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
  </aside>
</template>

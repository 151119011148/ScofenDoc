<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'

/**
 * 当前文档的章节大纲：扫描正文编辑器里的 H1–H3，生成可点击跳转的目录。
 * 自带滚动高亮（当前章节高亮并保持在可视区）。独立于左侧的「文档树」，
 * 解决长文档（如 Netty）内部快速定位。
 *
 * 除了跳转，每条标题还能就地「提升 / 降低层级」：改的是正文里 heading 节点的
 * level 属性，不是大纲自己的副本，所以章节号、折叠、协同都会跟着重算。
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

/** 大纲只列 H1–H3，层级调整也限制在这个区间，免得调完条目直接从目录里消失 */
const MIN_LEVEL = 1
const MAX_LEVEL = 3

const props = defineProps<{
  /** 正文滚动容器（.main），用于计算标题相对位置与滚动高亮 */
  scroller?: HTMLElement | null
  /** 正文编辑器实例：既要读 DOM，也要能改 heading 节点的 level */
  editor?: Editor | null
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
    // 标题里的折叠三角是装饰节点，不该出现在大纲文字里
    const copy = h.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.fold-caret').forEach((n) => n.remove())
    const text = (copy.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 开了自动编号的标题，正文里的序号由 CSS 伪元素显示（不在 textContent 里），
    // 大纲这里补上，保持「1 / 1.1」与正文一致
    const num = h.getAttribute('data-number') || ''
    list.push({
      level: Number(h.tagName.charAt(1)),
      text: num ? `${num} ${text}` : text,
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

/**
 * 只读空间不给层级按钮：改了也没意义，还会误导「已生效」。
 *
 * isEditable 本身不是响应式的，所以单独用 ref 跟一下：
 * Tiptap 的 setEditable 默认会 emit('update')，那里同步即可。
 */
const editable = ref(true)
function onEditorUpdate() {
  const now = !!props.editor?.isEditable
  if (now !== editable.value) editable.value = now
}
const canEdit = computed(() => editable.value && !!props.editor)

/**
 * 提升（delta=-1）/ 降低（delta=+1）某个标题的层级。
 *
 * 改的是正文 heading 节点的 level 属性，走 ProseMirror 事务：
 * 于是 Yjs 协同、Ctrl+Z、章节号（HeadingNumber 装饰）、折叠全部自动跟着走，
 * 大纲只是在事务落地后重扫一遍 DOM。位置每次用 posAtDOM 现算，
 * 不依赖扫描快照，避免正文异步渲染后位置漂移。
 *
 * 只动这一个标题，不连带它下面的小标题：这里的使用场景是把导入文档里
 * 错乱的层级一条条摆正，连带下移会把原本对的也弄乱。
 */
function shiftLevel(item: Item, delta: number) {
  const ed = props.editor
  const view = ed?.view
  if (!ed || !view || !ed.isEditable) return
  const next = item.level + delta
  if (next < MIN_LEVEL || next > MAX_LEVEL) return

  let pos: number
  try {
    // posAtDOM(el, 0) 落在标题内容起点，减 1 才是节点自身的位置
    pos = view.posAtDOM(item.el, 0) - 1
  } catch {
    return
  }
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'heading') return
  if (Number(node.attrs.level) === next) return

  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: next }))
  // 标签从 h2 变 h3，缩进要立刻跟上；不等 MutationObserver 那一拍
  window.requestAnimationFrame(() => refresh())
}

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
  () => props.editor,
  (ed, prev) => {
    prev?.off?.('update', onEditorUpdate)
    ed?.on?.('update', onEditorUpdate)
    editable.value = !!ed?.isEditable
    refresh()
  },
  { immediate: true },
)

watch(
  () => props.refresh,
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
  props.editor?.off?.('update', onEditorUpdate)
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
        <span class="outline-text">{{ item.text }}</span>
        <!-- 悬停才出现：提升 / 降低层级，边界层级置灰 -->
        <span v-if="canEdit" class="outline-acts" @click.stop>
          <button
            class="outline-act"
            type="button"
            :disabled="item.level <= MIN_LEVEL"
            :title="item.level <= MIN_LEVEL ? '已经是最高层级' : `提升为 H${item.level - 1}`"
            :aria-label="`提升「${item.text}」层级`"
            @mousedown.stop
            @click.stop="shiftLevel(item, -1)"
          >↑</button>
          <button
            class="outline-act"
            type="button"
            :disabled="item.level >= MAX_LEVEL"
            :title="item.level >= MAX_LEVEL ? '已经是最低层级' : `降低为 H${item.level + 1}`"
            :aria-label="`降低「${item.text}」层级`"
            @mousedown.stop
            @click.stop="shiftLevel(item, 1)"
          >↓</button>
        </span>
      </li>
    </ul>
  </div>
</template>

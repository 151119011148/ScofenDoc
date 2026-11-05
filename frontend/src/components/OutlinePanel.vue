<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'

/**
 * 当前文档的章节大纲：扫描正文编辑器里的 H1–H3，生成可点击跳转的目录。
 * 自带滚动高亮（当前章节高亮并保持在可视区）。独立于左侧的「文档树」，
 * 解决长文档（如 Netty）内部快速定位。
 *
 * 除了跳转，每条标题还能就地「提升 / 降低层级」：改的是正文里 heading 节点的
 * level 属性，不是大纲自己的副本，所以章节号、折叠、协同都会跟着重算。
 *
 * 支持多选批量调整：Cmd/Ctrl 点击加减选、Shift 点击选范围，选中后顶部浮出批量条，
 * 整组按同一方向升降一级（保持组内相对关系）。批量改动合并成一个 ProseMirror
 * 事务，所以 Ctrl+Z 一次就能把整组撤回去，而不是退一条按一次。
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

/**
 * 跳转到某个标题。
 *
 * 注意：这里必须用 offsetOf 重新读一次位置，不能再叠加 scrollTop——
 * offsetOf 返回的已经是「距内容顶部的绝对距离」，而 scrollTo 的 top 也是绝对值。
 * （旧实现用「预存绝对偏移 + 当前 scrollTop」，每点一次就多滚一个屏高。）
 * notify=false 时不关手机上的抽屉：多选是「边挑边看」，关掉面板就没法继续挑了。
 */
function jump(item: Item, i: number, notify = true) {
  const scroller = props.scroller
  if (!scroller) return
  const target = offsetOf(item.el) - jumpGap()
  scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  activeId.value = i
  if (notify) emit('select')
}

/* ---------------- 多选：批量调整层级 ---------------- */

/**
 * 选中集合存的是条目索引，不是 DOM 元素。
 *
 * 元素引用在这里不可靠：改层级时 h2→h3 标签会重建，批量调完选中态立刻失效。
 * 索引在「只改层级」的场景下不漂移；代价是正文标题增删后索引可能错位，
 * 所以 refresh 一旦发现条数变化就作废选择——宁可让用户重选，也不能改错别人的标题。
 */
const selected = ref<Set<number>>(new Set())
/** Shift 范围选的起点 */
const anchor = ref<number | null>(null)
/** 批量条上的临时反馈（执行结果 / 边界提示） */
const hint = ref('')
let hintTimer: number | undefined

const selCount = computed(() => selected.value.size)

interface PickedItem {
  i: number
  it: Item
}
const selItems = computed<PickedItem[]>(() => {
  const out: PickedItem[] = []
  for (const i of [...selected.value].sort((a, b) => a - b)) {
    const it = items.value[i]
    if (it) out.push({ i, it })
  }
  return out
})

/**
 * 批量操作以「整组」为单位：只有全部选中项都还能动才放行。
 *
 * 若逐条 clamp，选中 H2 与 H3 一起降低会变成 H3 与 H3（H3 到边界被跳过），
 * 组内相对关系被压平，比直接拦住更糟。
 */
const canRaiseAll = computed(() => selItems.value.length > 0 && selItems.value.every((p) => p.it.level > MIN_LEVEL))
const canLowerAll = computed(() => selItems.value.length > 0 && selItems.value.every((p) => p.it.level < MAX_LEVEL))
/** 组里最高/最低层级，用于把「为什么点不动」讲清楚 */
const groupTop = computed(() => Math.min(...selItems.value.map((p) => p.it.level), MAX_LEVEL))
const groupBottom = computed(() => Math.max(...selItems.value.map((p) => p.it.level), MIN_LEVEL))

function flash(msg: string) {
  hint.value = msg
  if (hintTimer) window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => (hint.value = ''), 2600)
}

function clearSelection() {
  if (selected.value.size) selected.value = new Set()
  anchor.value = null
}

function toggleSelect(i: number) {
  const s = new Set(selected.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  selected.value = s
}

function selectRange(from: number, to: number) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const s = new Set(selected.value)
  for (let k = lo; k <= hi; k++) s.add(k)
  selected.value = s
}

function selectAll() {
  if (!items.value.length) return
  selected.value = new Set(items.value.map((_, i) => i))
  anchor.value = 0
}

/** Shift/Cmd 点击会拖选正文文字，先把默认行为挡掉 */
function onItemMouseDown(ev: MouseEvent) {
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) ev.preventDefault()
}

function onItemClick(item: Item, i: number, ev: MouseEvent) {
  const multi = ev.shiftKey || ev.metaKey || ev.ctrlKey
  // 普通点击、或只读空间：只跳转。（只读时若还加选中态，会亮一片蓝底却没有批量条）
  if (!multi || !canEdit.value) {
    clearSelection()
    anchor.value = i
    jump(item, i)
    return
  }
  // 范围选：从上次点击的位置连到这一条，不跳转（不然滚动会打断选）
  if (ev.shiftKey && anchor.value !== null) {
    selectRange(anchor.value, i)
    return
  }
  // 加选 / 减选：跳过去，方便边看正文边挑
  toggleSelect(i)
  anchor.value = i
  jump(item, i, false)
}

/**
 * 批量提升（delta=-1）/ 降低（delta=+1）。
 *
 * 所有改动塞进同一个 transaction：既是一个撤销步（Ctrl+Z 整组回退），
 * 也是 Yjs 的一个 update（对方看到的是原子操作，不会一格一格跳）。
 * pos 全部在一次遍历里先算完再 dispatch；setNodeMarkup 只改 attr、不增删节点，
 * 所以前面的改动不会让后面的位置偏移。
 */
function shiftSelected(delta: number) {
  const ed = props.editor
  const view = ed?.view
  if (!ed || !view || !ed.isEditable) return
  const targets = selItems.value
  if (!targets.length) return

  const tr = view.state.tr
  let done = 0
  for (const { it } of targets) {
    let pos: number
    try {
      pos = view.posAtDOM(it.el, 0) - 1
    } catch {
      continue
    }
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'heading') continue
    const next = Number(node.attrs.level) + delta
    if (next < MIN_LEVEL || next > MAX_LEVEL || next === Number(node.attrs.level)) continue
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: next })
    done++
  }

  if (!done) {
    flash('选中项已到边界，无法调整')
    return
  }
  view.dispatch(tr)
  flash(`已调整 ${done} 条`)
  window.requestAnimationFrame(() => refresh())
}

function refresh() {
  const next = collect()
  // 正文标题增删会让索引错位，旧选择可能指向别的标题，直接作废
  if (next.length !== items.value.length) clearSelection()
  items.value = next
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

/** Esc 退出多选：只有真的选了东西才处理，否则不干扰正文/放大图等其他 Esc 行为 */
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && selected.value.size) clearSelection()
}

onMounted(() => document.addEventListener('keydown', onKeydown))

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
  document.removeEventListener('keydown', onKeydown)
  if (spyTimer) cancelAnimationFrame(spyTimer)
  if (hintTimer) window.clearTimeout(hintTimer)
})
</script>

<template>
  <!-- 只负责列表本身：外框、标题、拖拽宽度都由 App 的中间栏控制 -->
  <div class="outline-body">
    <!-- 多选批量条：Cmd/Ctrl 加选、Shift 选范围后出现；整组升降，保持组内相对关系 -->
    <div v-if="canEdit && selCount > 0" class="outline-batch">
      <span class="ob-count">{{ hint || `已选 ${selCount} 条` }}</span>
      <span class="ob-acts">
        <button
          class="ob-btn"
          type="button"
          :disabled="!canRaiseAll"
          :title="canRaiseAll ? '整组提升一级' : `选中项含 H${groupTop}，已是最上层级`"
          @click="shiftSelected(-1)"
        >↑ 提升</button>
        <button
          class="ob-btn"
          type="button"
          :disabled="!canLowerAll"
          :title="canLowerAll ? '整组降低一级' : `选中项含 H${groupBottom}，已是最下层级`"
          @click="shiftSelected(1)"
        >↓ 降低</button>
        <button class="ob-btn ob-plain" type="button" title="全选本文章节" @click="selectAll">全选</button>
        <button class="ob-btn ob-plain" type="button" title="取消选择（Esc）" @click="clearSelection">✕</button>
      </span>
    </div>

    <div v-if="empty" class="outline-empty">本文档暂无标题</div>
    <ul v-else class="outline-list">
      <li
        v-for="(item, i) in items"
        :key="i"
        :class="['outline-item', `lvl-${item.level}`, { on: i === activeId, sel: selected.has(i) }]"
        :title="canEdit ? '点击跳转；Ctrl/⌘ 点击多选，Shift 选连续范围' : ''"
        @mousedown="onItemMouseDown"
        @click="onItemClick(item, i, $event)"
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

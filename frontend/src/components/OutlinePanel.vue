<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { yUndoPluginKey } from 'y-prosemirror'
import { stickyTopGap } from '../stickyGap'

/**
 * 当前文档的章节大纲：扫描正文编辑器里的标题，生成可点击跳转的目录。
 * 自带滚动高亮（当前章节高亮并保持在可视区）。独立于左侧的「文档树」，
 * 解决长文档（如 Netty）内部快速定位。
 *
 * 除了跳转，每条标题还能就地「提升 / 降低层级」：改的是正文里 heading 节点的
 * level 属性，不是大纲自己的副本，所以章节号、折叠、协同都会跟着重算。
 *
 * 三条规则：
 * 1) 级联：升降某个标题时，挂在它下面的所有更深标题（直到遇到同级或更浅）
 *    一起动。只动自己会把结构拆散——把 H2 章节提到 H1 后，它下面的 H3
 *    就成了 H1 的兄弟。
 * 2) 整组原子：子树里只要有一条会越过 H1/H6 边界，就整组拦下并说明原因。
 *    逐条 clamp 会把层级压平（H2、H3 一起降 → H3、H3），比不动更糟。
 * 3) 可撤销：所有改动走单个 ProseMirror 事务（Yjs 里也是一个 update），
 *    面板自带「撤销 / 重做」，焦点在大纲里时 Ctrl/⌘+Z 也能直接用。
 *
 * 支持多选批量调整：Cmd/Ctrl 点击加减选、Shift 点击选范围，选中后顶部浮出批量条，
 * 选中集合按「子树并集」计算，父子同时选中不会把子级降两级。
 *
 * 标题位置由调用方（App.vue）通过 editor + refresh 触发重扫，
 * 因为正文是 Yjs 协同、由 Tiptap 渲染，Vue 无法直接响应其 DOM 变化。
 */
interface Head {
  el: HTMLElement
  level: number
}

interface Item {
  level: number
  /** 展示用：带自动编号前缀 */
  text: string
  /** 纯标题文字：提示与反馈里用，不带编号 */
  raw: string
  /** 标题元素本身：位置每次实时计算，避免正文异步渲染（图/表）后快照失效 */
  el: HTMLElement
  /** 子树里最深的层级（含未显示出来的 H5/H6），决定「降低」还能不能整组走 */
  deep: number
  /** 子树里的标题条数，用于按钮提示 */
  kids: number
}

/** 标题最深 6 级：再往下就不是章节了 */
const MIN_LEVEL = 1
const MAX_LEVEL = 6
/** 大纲至少显示到 H3（短文档只有两三级也照样能调），文档更深就跟着显示 */
const MIN_SHOWN = 3

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

/** 正文里所有标题（含折叠隐藏、含 H5/H6）：级联时看不见的后代也得跟着动 */
function scanHeads(): Head[] {
  const dom = props.editor?.view?.dom
  if (!dom) return []
  const els = Array.from(dom.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]
  return els.map((el) => ({ el, level: Number(el.tagName.charAt(1)) }))
}

/** 标题纯文本：折叠三角是装饰节点、自动编号是伪元素，两者都不该进文字 */
function textOf(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.fold-caret').forEach((n) => n.remove())
  return (copy.textContent || '').replace(/\s+/g, ' ').trim()
}

function buildItems(all: Head[]): { list: Item[]; limit: number } {
  let deepest = MIN_SHOWN
  for (const h of all) if (h.level > deepest) deepest = h.level
  // 显示到「文档真正用到的最深层级」：三级文档不长个子，四级文档也不会把 H4 藏起来
  const limit = Math.min(MAX_LEVEL, deepest)
  const list: Item[] = []
  for (let i = 0; i < all.length; i++) {
    const h = all[i]
    if (h.level > limit) continue
    // 跳过折叠后隐藏的标题（其祖先带 fold-hidden）
    if (h.el.closest('.fold-hidden')) continue
    const raw = textOf(h.el)
    if (!raw) continue
    // 子树 = 紧随其后、每一条都比它深的标题，遇到同级或更浅即止
    let deep = h.level
    let kids = 0
    for (let j = i + 1; j < all.length && all[j].level > h.level; j++) {
      kids++
      if (all[j].level > deep) deep = all[j].level
    }
    // 开了自动编号的标题，正文里的序号由 CSS 伪元素显示（不在 textContent 里），
    // 大纲这里补上，保持「1 / 1.1」与正文一致
    const num = h.el.getAttribute('data-number') || ''
    list.push({ level: h.level, text: num ? `${num} ${raw}` : raw, raw, el: h.el, deep, kids })
  }
  return { list, limit }
}

/** 标题相对滚动容器内容顶部的绝对偏移（实时读取，可随正文高度变化自适应） */
function offsetOf(el: HTMLElement): number {
  const scroller = props.scroller
  if (!scroller) return 0
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

/**
 * 跳转落点上方要留出的高度 = 吸顶格式栏实测高度 + 呼吸位。
 *
 * 桌面端格式栏 sticky 在 .main 顶部，宽屏一行、窄屏 flex-wrap 成两行，
 * 高度会变；以前固定 12px，标题跳上去后正好被压在工具栏下面。
 * 具体计算见 stickyGap.ts（站内 ?h= 锚点跳转共用同一套）。
 */
function jumpGap(): number {
  return stickyTopGap(props.scroller)
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
  syncHistory()
}
const canEdit = computed(() => editable.value && !!props.editor)

/* ---------------- 撤销 / 重做 ---------------- */

/**
 * 撤销栈是 Yjs 的 UndoManager（StarterKit 的 history 已关掉），
 * editor.can().undo() 会看它的栈里还有没有东西可用。
 *
 * 面板单独给按钮的原因：点了大纲里的 ↑↓ 之后焦点在按钮上，
 * 键盘的 Ctrl+Z 根本到不了正文编辑器，用户会以为「撤不了」。
 */
const undoable = ref(false)
const redoable = ref(false)

function syncHistory() {
  const ed = props.editor
  try {
    undoable.value = !!ed && ed.isEditable && !!ed.can().undo()
    redoable.value = !!ed && ed.isEditable && !!ed.can().redo()
  } catch {
    undoable.value = false
    redoable.value = false
  }
}

function undo() {
  if (!canEdit.value || !undoable.value) return
  props.editor?.commands.undo()
  afterHistory()
}

function redo() {
  if (!canEdit.value || !redoable.value) return
  props.editor?.commands.redo()
  afterHistory()
}

function afterHistory() {
  // 撤销回退的是正文节点，大纲要等 DOM 落地后再扫一遍
  window.requestAnimationFrame(() => {
    refresh()
    syncHistory()
  })
}

/**
 * 让每次层级调整单独成为一步撤销。
 *
 * Yjs 的 UndoManager 会把 captureTimeout（默认 500ms）内的连续改动合并成一个
 * 撤销步——连点几下 ↑↓ 就会变成「一次撤销退三级」。大纲里的每次点击都是明确的
 * 独立动作，所以改完主动封口，下次改动另起一步。
 * 本地冒烟页用 StarterKit 的 history，没有这个 manager，取到空就跳过。
 */
function sealUndoStep() {
  const ed = props.editor
  if (!ed) return
  try {
    yUndoPluginKey.getState(ed.state)?.undoManager?.stopCapturing()
  } catch {
    /* 非协同编辑器：没有 Yjs 撤销栈，撤销交给 history 自己 */
  }
}

/* ---------------- 层级调整：级联 + 整组原子 ---------------- */

interface Step {
  el: HTMLElement
  from: number
  to: number
}

interface PlanResult {
  steps: Step[]
  /** 被边界拦下的原因（空串 = 可以执行） */
  blocked: string
}

/**
 * 把「选中若干标题 + 方向」翻译成一份改动清单。
 *
 * 每个选中项先展开成子树（它自己 + 后续所有更深的标题），再取并集：
 * 父子同时选中时，子级不会因为被展开两次而多降一级。
 */
function buildPlan(roots: HTMLElement[], delta: number): PlanResult {
  const all = scanHeads()
  const at = new Map<HTMLElement, number>()
  all.forEach((h, i) => at.set(h.el, i))

  const picked = new Set<number>()
  const roots$ = new Set<number>()
  for (const el of roots) {
    const i = at.get(el)
    if (i === undefined) continue
    roots$.add(i)
    const lv = all[i].level
    picked.add(i)
    for (let j = i + 1; j < all.length && all[j].level > lv; j++) picked.add(j)
  }

  const idx = [...picked].sort((a, b) => a - b)
  if (!idx.length) return { steps: [], blocked: '' }

  // 先整组校验：有一条越界就整组不动，避免把组内相对关系压平
  for (const i of idx) {
    const h = all[i]
    const to = h.level + delta
    if (to < MIN_LEVEL) {
      return { steps: [], blocked: `「${textOf(h.el)}」已是最上层级 H${MIN_LEVEL}` }
    }
    if (to > MAX_LEVEL) {
      return {
        steps: [],
        blocked: roots$.has(i)
          ? `「${textOf(h.el)}」已是最深层级 H${MAX_LEVEL}`
          : `子级「${textOf(h.el)}」已到 H${MAX_LEVEL}，整体降低会超出范围`,
      }
    }
  }

  return {
    steps: idx.map((i) => ({ el: all[i].el, from: all[i].level, to: all[i].level + delta })),
    blocked: '',
  }
}

/**
 * 执行改动清单：全部塞进同一个 transaction。
 *
 * 一个事务 = 一个撤销步（Ctrl+Z 整组回退），也是 Yjs 的一个 update
 * （对方看到的是原子操作，不会一格一格跳）。
 * pos 先算完再 dispatch；setNodeMarkup 只改 attr、不增删节点，前面的改动不影响后面的位置。
 */
function applyPlan(steps: Step[]): number {
  const ed = props.editor
  const view = ed?.view
  if (!ed || !view || !ed.isEditable) return 0

  const tr = view.state.tr
  let done = 0
  for (const s of steps) {
    let pos: number
    try {
      // posAtDOM(el, 0) 落在标题内容起点，减 1 才是节点自身的位置
      pos = view.posAtDOM(s.el, 0) - 1
    } catch {
      continue
    }
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'heading') continue
    if (Number(node.attrs.level) === s.to) continue
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: s.to })
    done++
  }
  if (!done) return 0
  view.dispatch(tr)
  return done
}

/** 单条提升（delta=-1）/ 降低（delta=+1），连同子树 */
function shiftLevel(item: Item, delta: number) {
  if (!canEdit.value) return
  const { steps, blocked } = buildPlan([item.el], delta)
  if (blocked) {
    flash(blocked)
    return
  }
  const done = applyPlan(steps)
  if (!done) return
  sealUndoStep()
  const verb = delta < 0 ? '提升' : '降低'
  const extra = steps.length - 1
  flash(extra > 0 ? `已${verb}「${item.raw}」及 ${extra} 条子级` : `已${verb}「${item.raw}」`)
  // 标签从 h2 变 h3，缩进要立刻跟上；不等 MutationObserver 那一拍
  window.requestAnimationFrame(() => {
    refresh()
    syncHistory()
  })
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
 * 批量操作以「整组」为单位：只有全部选中项（含其子树）都还能动才放行。
 *
 * 若逐条 clamp，选中 H2 与 H3 一起降低会变成 H3 与 H3（H3 到边界被跳过），
 * 组内相对关系被压平，比直接拦住更糟。
 */
const canRaiseAll = computed(() => selItems.value.length > 0 && selItems.value.every((p) => p.it.level > MIN_LEVEL))
const canLowerAll = computed(() => selItems.value.length > 0 && selItems.value.every((p) => p.it.deep < MAX_LEVEL))
/** 组里最高层级 / 最深子树，用于把「为什么点不动」讲清楚 */
const groupTop = computed(() => Math.min(...selItems.value.map((p) => p.it.level), MAX_LEVEL))
const groupDeep = computed(() => Math.max(...selItems.value.map((p) => p.it.deep), MIN_LEVEL))

function flash(msg: string) {
  hint.value = msg
  if (hintTimer) window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => (hint.value = ''), 3000)
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

/** 批量提升（delta=-1）/ 降低（delta=+1），每条都连同其子树 */
function shiftSelected(delta: number) {
  if (!canEdit.value) return
  const roots = selItems.value.map((p) => p.it.el)
  if (!roots.length) return
  const { steps, blocked } = buildPlan(roots, delta)
  if (blocked) {
    flash(blocked)
    return
  }
  const done = applyPlan(steps)
  if (!done) return
  sealUndoStep()
  const verb = delta < 0 ? '提升' : '降低'
  const extra = steps.length - done
  flash(`已${verb} ${done} 条${extra > 0 ? `（另 ${extra} 条已在该层级）` : ''}`)
  window.requestAnimationFrame(() => {
    refresh()
    syncHistory()
  })
}

function refresh() {
  const all = scanHeads()
  const { list } = buildItems(all)
  // 正文标题增删会让索引错位，旧选择可能指向别的标题，直接作废
  if (list.length !== items.value.length) clearSelection()
  items.value = list
}

let spyTimer: number | undefined
function spy() {
  if (spyTimer) return
  spyTimer = window.requestAnimationFrame(() => {
    spyTimer = undefined
    if (!props.scroller) return
    // 判定线与跳转落点保持一致：都以吸顶栏下沿为基准，
    // 否则点完大纲那一瞬会高亮到上一个标题
    const y = props.scroller.scrollTop + stickyTopGap(props.scroller) + 4
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
    // 撤销栈只在正文真的变了时才进出，所以跟着 update 走就够了；
    // 用 transaction 会被「只改选区」的高频事务拖累
    prev?.off?.('update', onEditorUpdate)
    ed?.on?.('update', onEditorUpdate)
    editable.value = !!ed?.isEditable
    refresh()
    syncHistory()
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

/**
 * Esc 退出多选：只有真的选了东西才处理，否则不干扰正文/放大图等其他 Esc 行为。
 * Ctrl/⌘+Z 只在焦点落在大纲里时接管——正文里的撤销得留给编辑器自己。
 */
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && selected.value.size) clearSelection()
  if (!(ev.metaKey || ev.ctrlKey) || !canEdit.value) return
  const t = ev.target as HTMLElement | null
  if (!t || typeof t.closest !== 'function' || !t.closest('.outline-body')) return
  const k = ev.key.toLowerCase()
  if (k === 'z' && !ev.shiftKey) {
    ev.preventDefault()
    undo()
    return
  }
  if (k === 'y' || (k === 'z' && ev.shiftKey)) {
    ev.preventDefault()
    redo()
  }
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
    <!-- 层级调整可撤销：焦点在大纲里时 Ctrl/⌘+Z 也能用，不必先点回正文 -->
    <div v-if="canEdit" class="outline-tools">
      <button
        class="ot-btn"
        type="button"
        :disabled="!undoable"
        :title="undoable ? '撤销上一步（Ctrl/⌘+Z）' : '没有可撤销的操作'"
        @click="undo"
      >↶ 撤销</button>
      <button
        class="ot-btn"
        type="button"
        :disabled="!redoable"
        :title="redoable ? '重做（Ctrl/⌘+Shift+Z）' : '没有可重做的操作'"
        @click="redo"
      >↷ 重做</button>
    </div>

    <!-- 多选批量条：Cmd/Ctrl 加选、Shift 选范围后出现；整组升降，保持组内相对关系 -->
    <div v-if="canEdit && selCount > 0" class="outline-batch">
      <span class="ob-count">{{ hint || `已选 ${selCount} 条` }}</span>
      <span class="ob-acts">
        <button
          class="ob-btn"
          type="button"
          :disabled="!canRaiseAll"
          :title="canRaiseAll ? '整组提升一级（含各自子级）' : `选中项含 H${groupTop}，已是最上层级`"
          @click="shiftSelected(-1)"
        >↑ 提升</button>
        <button
          class="ob-btn"
          type="button"
          :disabled="!canLowerAll"
          :title="canLowerAll ? '整组降低一级（含各自子级）' : `选中项或其子级已到 H${groupDeep}，无法再降低`"
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
            :title="item.level <= MIN_LEVEL ? '已经是最高层级' : `提升为 H${item.level - 1}${item.kids ? `（连同 ${item.kids} 条子级）` : ''}`"
            :aria-label="`提升「${item.raw}」层级`"
            @mousedown.stop
            @click.stop="shiftLevel(item, -1)"
          >↑</button>
          <button
            class="outline-act"
            type="button"
            :disabled="item.deep >= MAX_LEVEL"
            :title="item.deep >= MAX_LEVEL ? '子级已到最深层级' : `降低为 H${item.level + 1}${item.kids ? `（连同 ${item.kids} 条子级）` : ''}`"
            :aria-label="`降低「${item.raw}」层级`"
            @mousedown.stop
            @click.stop="shiftLevel(item, 1)"
          >↓</button>
        </span>
      </li>
    </ul>

    <!-- 没有多选时，操作反馈落在底部轻提示上（有多选就显示在批量条里） -->
    <div v-if="hint && !selCount" class="outline-toast">{{ hint }}</div>
  </div>
</template>

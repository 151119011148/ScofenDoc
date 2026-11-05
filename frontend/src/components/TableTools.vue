<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChainedCommands } from '@tiptap/core'
import type { Editor } from '@tiptap/vue-3'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'

/**
 * 飞书式表格操作层。
 *
 * 鼠标经过表格（或光标在表格里）时，表格左上角浮出一个块手柄：
 *   ▦ 打开块菜单 · ⠿ 选中整张表 · ＋ 在末尾追加一行
 *
 * 块菜单按飞书的组织方式：先放「表格形态」开关（标题行 / 标题列 / 均分列宽），
 * 再放行列增删，最后是删除。右键单元格打开的是同一份菜单，只是定位在鼠标处。
 *
 * 所有结构改动都走 ProseMirror transaction（Tiptap table 命令或 setNodeMarkup），
 * 能进 Yjs UndoManager，Ctrl+Z 可撤销；均分列宽改的是单元格的 colwidth 属性，
 * 和拖动列宽写回的是同一份数据，所以两者不会打架。
 */

const props = withDefaults(
  defineProps<{ editor?: Editor; editable?: boolean }>(),
  { editor: undefined, editable: true },
)

interface TableRef {
  node: PMNode
  pos: number
  el: HTMLElement
  rows: number
  cols: number
}

type Action =
  | 'headerRow'
  | 'headerCol'
  | 'equalize'
  | 'rowBefore'
  | 'rowAfter'
  | 'colBefore'
  | 'colAfter'
  | 'merge'
  | 'split'
  | 'delete'

interface MenuRow {
  key: Action
  label: string
  icon: string
  switch?: boolean
  danger?: boolean
  /** 这一项之前画一条分隔线 */
  sep?: boolean
}

const MENU: MenuRow[] = [
  { key: 'headerRow', label: '标题行', icon: 'headerRow', switch: true },
  { key: 'headerCol', label: '标题列', icon: 'headerCol', switch: true },
  { key: 'equalize', label: '均分列宽', icon: 'equalize' },
  { key: 'rowBefore', label: '在上方插入行', icon: 'rowBefore', sep: true },
  { key: 'rowAfter', label: '在下方插入行', icon: 'rowAfter' },
  { key: 'colBefore', label: '在左侧插入列', icon: 'colBefore' },
  { key: 'colAfter', label: '在右侧插入列', icon: 'colAfter' },
  { key: 'merge', label: '合并单元格', icon: 'merge', sep: true },
  { key: 'split', label: '拆分单元格', icon: 'split' },
  { key: 'delete', label: '删除表格', icon: 'trash', danger: true, sep: true },
]

/** 16×16 线性图标，和飞书一样用细描边，跟着按钮颜色走 */
const ICONS: Record<string, string[]> = {
  table: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11', 'M2.5 9.5h11', 'M6 3.5v9', 'M10 3.5v9'],
  headerRow: ['M2.5 3.5h11v9h-11z', 'M2.5 3.5h11v3h-11z', 'M6 6.5v6', 'M10 6.5v6'],
  headerCol: ['M2.5 3.5h11v9h-11z', 'M2.5 3.5h3.5v9h-3.5z', 'M6 6.5h7.5', 'M6 9.5h7.5'],
  equalize: ['M2.5 3.5h11v9h-11z', 'M6 3.5v9', 'M10 3.5v9', 'M4.5 8h1.2', 'M10.3 8h1.2'],
  rowBefore: ['M3.5 7.5h9v5.5h-9z', 'M8 1v3.6', 'M6.2 2.8 8 1l1.8 1.8'],
  rowAfter: ['M3.5 3h9v5.5h-9z', 'M8 15v-3.6', 'M6.2 13.2 8 15l1.8-1.8'],
  colBefore: ['M7.5 3.5h6v9h-6z', 'M1 8h3.6', 'M2.8 6.2 1 8l1.8 1.8'],
  colAfter: ['M2.5 3.5h6v9h-6z', 'M15 8h-3.6', 'M13.2 6.2 15 8l-1.8 1.8'],
  merge: ['M2.5 4.5h5v7h-5z', 'M8.5 4.5h5v7h-5z', 'M6.6 8h2.8'],
  split: ['M2.5 4.5h11v7h-11z', 'M8 3.8v8.4'],
  trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.6 4.5l.6 8h5.6l.6-8', 'M6.8 7v3', 'M9.2 7v3'],
  grip: ['M5 5h1.2v1.2H5z', 'M9.8 5H11v1.2H9.8z', 'M5 9.8h1.2V11H5z', 'M9.8 9.8H11V11H9.8z'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
}

const handleVisible = ref(false)
const handlePos = ref({ left: 0, top: 0 })
const menuOpen = ref(false)
const menuPos = ref({ left: 0, top: 0 })
const headerRow = ref(false)
const headerCol = ref(false)
const sizeLabel = ref('')

const handleEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)

/** 鼠标当前停在哪张表上（普通变量：只用于算位置，不需要触发渲染） */
let hoverEl: HTMLTableElement | null = null
let hoverTable: TableRef | null = null
/** 菜单打开时冻结目标表：鼠标移到菜单上表格 hover 会丢，操作不能跟着丢 */
let menuTable: TableRef | null = null

/* ---------------- 定位表节点 ---------------- */

function makeRef(node: PMNode, pos: number, el: HTMLElement): TableRef {
  return {
    node,
    pos,
    el,
    rows: node.childCount,
    cols: node.firstChild?.childCount ?? 0,
  }
}

/** nodeDOM(tablePos) 在 prosemirror-tables 里给的是 .tableWrapper，真正的 <table> 在它里面 */
function tableElFromDom(dom: Node | null): HTMLElement | null {
  if (!(dom instanceof HTMLElement)) return null
  if (dom.tagName === 'TABLE') return dom
  const inner = dom.querySelector('table')
  return inner instanceof HTMLElement ? inner : null
}

/** 由 DOM 反查 table 节点：协同会重建节点，所以每次按当前 doc 重新比对 */
function tableRefOf(el: HTMLElement | null): TableRef | null {
  const e = props.editor
  if (!e || !el) return null
  let found: TableRef | null = null
  e.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name !== 'table') return true
    let dom: Node | null = null
    try {
      dom = e.view.nodeDOM(pos)
    } catch {
      dom = null
    }
    if (tableElFromDom(dom) === el) {
      found = makeRef(node, pos, el)
      return false
    }
    return true
  })
  return found
}

/** 光标所在的表格（含「整张表被选中」的 NodeSelection） */
function selectionRef(): TableRef | null {
  const e = props.editor
  if (!e) return null
  const sel = e.state.selection
  if (sel instanceof NodeSelection && sel.node.type.name === 'table') {
    const el = tableElFromDom(e.view.nodeDOM(sel.from))
    if (el) return makeRef(sel.node, sel.from, el)
  }
  const { $from } = sel
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name !== 'table') continue
    const pos = $from.before(d)
    const el = tableElFromDom(e.view.nodeDOM(pos))
    if (el) return makeRef(node, pos, el)
  }
  return null
}

function currentRef(): TableRef | null {
  if (menuOpen.value && menuTable) return menuTable
  if (hoverTable && hoverTable.el.isConnected) return hoverTable
  if (hoverTable) hoverTable = null
  return selectionRef()
}

/* ---------------- 手柄位置 ---------------- */

let raf = 0
function scheduleHandle() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    updateHandle()
  })
}

/** 吸顶格式栏的下沿：手柄不能钻到工具栏下面去 */
function barBottom(): number {
  const bar = document.querySelector('.collab .bar')
  return bar ? bar.getBoundingClientRect().bottom : 0
}

function updateHandle() {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable) {
    handleVisible.value = false
    return
  }
  const ref = currentRef()
  if (!ref) {
    handleVisible.value = false
    return
  }
  const rect = ref.el.getBoundingClientRect()
  if (rect.width < 40 || rect.bottom < 60 || rect.top > window.innerHeight - 20) {
    handleVisible.value = false
    return
  }
  sizeLabel.value = `${ref.rows} 行 × ${ref.cols} 列`
  // 正文左侧有 28px 内边距，够宽就贴表格左外侧；不够时退到表格内部，别压到侧栏。
  // 手柄实际宽约 55px（两个按钮 + 内边距），首次渲染前 el 还不存在，用同一个常量估位。
  const hw = handleEl.value?.offsetWidth || 56
  const left = rect.left - hw - 4 >= 8 ? rect.left - hw - 4 : Math.max(8, rect.left + 3)
  const top = Math.min(Math.max(rect.top - 1, barBottom() + 6), window.innerHeight - 90)
  handlePos.value = { left, top }
  handleVisible.value = true
  refreshHeaderState(ref)

  // 菜单开着时表格结构可能被改（插入行），菜单位置跟着手柄走
  if (menuOpen.value && handleEl.value) {
    const hb = handleEl.value.getBoundingClientRect()
    placeMenu(hb.right + 6, hb.top)
  }
}

function refreshHeaderState(ref: TableRef) {
  const firstRow = ref.node.firstChild
  headerRow.value = firstRow?.firstChild?.type.name === 'tableHeader'
  let colHead = ref.rows > 0
  ref.node.forEach((row) => {
    if (row.firstChild?.type.name !== 'tableHeader') colHead = false
  })
  headerCol.value = colHead
}

function placeMenu(x: number, y: number) {
  const w = 224
  const h = menuEl.value?.offsetHeight || 380
  menuPos.value = {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

/* ---------------- 菜单开合 ---------------- */

function openMenuAt(x: number, y: number, ref: TableRef | null) {
  if (!ref || !props.editable) return
  menuTable = ref
  menuOpen.value = true
  refreshHeaderState(ref)
  nextTick(() => placeMenu(x, y))
}

function openMenuFromHandle() {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  const hb = handleEl.value?.getBoundingClientRect()
  const ref = currentRef()
  if (!hb || !ref) return
  openMenuAt(hb.right + 6, hb.top, ref)
}

/* ---------------- 结构操作 ---------------- */

/** 把光标放进指定表格的第一格，供 Tiptap 的行列命令使用 */
function focusFirstCell(ref: TableRef) {
  const e = props.editor
  if (!e) return false
  try {
    const view = e.view
    // 表格内容起点 = 节点位置 + 1；再进一层到第一行第一格
    let firstCell = -1
    ref.node.descendants((node, offset) => {
      if (firstCell >= 0) return false
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        firstCell = ref.pos + 1 + offset
        return false
      }
      return true
    })
    if (firstCell < 0) return false
    const tr = e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(firstCell + 1)))
    view.dispatch(tr)
    return true
  } catch {
    return false
  }
}

function runChain(fn: (c: ChainedCommands) => ChainedCommands) {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable) return
  try {
    fn(e.chain().focus()).run()
  } catch (err) {
    console.warn('[table] command failed', err)
  }
}

/** 光标是否真的落在某个单元格里（整表被 NodeSelection 选中时不算） */
function cursorInTable(): boolean {
  const e = props.editor
  if (!e) return false
  const { $from } = e.state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') return true
  }
  return false
}

/** 菜单里的行列插入：hover 手柄时没有光标，先落到第一格再执行 */
function withTable(fn: () => void) {
  const ref = currentRef()
  if (!ref) return
  if (!cursorInTable() && !focusFirstCell(ref)) return
  fn()
  nextTick(() => scheduleHandle())
}

/** 在表格末尾追加一行（手柄上的 ＋，也是飞书「在下方添加」的语义） */
function addRowAtEnd() {
  const e = props.editor
  const ref = currentRef()
  if (!e || !ref || !props.editable) return
  const lastRow = ref.node.lastChild
  if (!lastRow) return
  const cells: PMNode[] = []
  lastRow.forEach((cell) => {
    cells.push(
      cell.type.create(
        { ...cell.attrs, colspan: 1, rowspan: 1 },
        cell.type.schema.nodes.paragraph.create(),
      ),
    )
  })
  try {
    const tr = e.state.tr.insert(ref.pos + ref.node.nodeSize - 1, lastRow.type.create(null, cells))
    e.view.dispatch(tr.scrollIntoView())
  } catch (err) {
    console.warn('[table] append row failed', err)
  }
  nextTick(() => scheduleHandle())
}

/**
 * 均分列宽：把每一格的 colwidth 写成 (表格可视宽 / 列数)。
 * 合并单元格按 colspan 占几列就乘几份，避免把跨列格压回一格宽。
 */
function equalize() {
  const e = props.editor
  const ref = currentRef()
  if (!e || !ref || !props.editable) return
  const cols = Math.max(1, ref.cols)
  const width = Math.round(ref.el.getBoundingClientRect().width) || 720
  const each = Math.max(56, Math.floor(width / cols))
  const tr = e.state.tr
  let touched = false
  ref.node.descendants((node, offset) => {
    if (node.type.name !== 'tableCell' && node.type.name !== 'tableHeader') return true
    const span = Number(node.attrs.colspan) || 1
    tr.setNodeMarkup(ref.pos + 1 + offset, undefined, {
      ...node.attrs,
      colwidth: Array(span).fill(each),
    })
    touched = true
    return true
  })
  if (!touched) return
  e.view.dispatch(tr)
  nextTick(() => scheduleHandle())
}

function selectTable() {
  const e = props.editor
  const ref = currentRef()
  if (!e || !ref) return
  try {
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, ref.pos)))
    e.view.focus()
  } catch (err) {
    console.warn('[table] select failed', err)
  }
  scheduleHandle()
}

function apply(row: MenuRow) {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable) return
  switch (row.key) {
    case 'headerRow':
      withTable(() => runChain((c) => c.toggleHeaderRow()))
      break
    case 'headerCol':
      withTable(() => runChain((c) => c.toggleHeaderColumn()))
      break
    case 'equalize':
      equalize()
      break
    case 'rowBefore':
      withTable(() => runChain((c) => c.addRowBefore()))
      break
    case 'rowAfter':
      withTable(() => runChain((c) => c.addRowAfter()))
      break
    case 'colBefore':
      withTable(() => runChain((c) => c.addColumnBefore()))
      break
    case 'colAfter':
      withTable(() => runChain((c) => c.addColumnAfter()))
      break
    case 'merge':
      withTable(() => runChain((c) => c.mergeCells()))
      menuOpen.value = false
      break
    case 'split':
      withTable(() => runChain((c) => c.splitCell()))
      menuOpen.value = false
      break
    case 'delete':
      withTable(() => runChain((c) => c.deleteTable()))
      menuOpen.value = false
      menuTable = null
      break
  }
  // 开关和均分留在菜单里看结果，插行插列因为位置会变则收起菜单
  if (row.key !== 'headerRow' && row.key !== 'headerCol' && row.key !== 'equalize') {
    menuOpen.value = false
  }
  nextTick(() => {
    // menuTable 是操作前的快照：切标题行/插行都会换掉节点，必须按当前 doc 重新取，
    // 否则开关会一直停在旧状态
    let fresh = menuTable ? tableRefOf(menuTable.el) : null
    if (!fresh) fresh = selectionRef()
    if (fresh) {
      if (menuOpen.value) menuTable = fresh
      refreshHeaderState(fresh)
    }
    scheduleHandle()
  })
}

/* ---------------- 事件 ---------------- */

let hideTimer: number | undefined
function cancelHide() {
  if (hideTimer) {
    window.clearTimeout(hideTimer)
    hideTimer = undefined
  }
}
function scheduleHide() {
  cancelHide()
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined
    if (menuOpen.value) return
    hoverEl = null
    hoverTable = null
    handleVisible.value = false
  }, 160)
}

function onMouseMove(ev: MouseEvent) {
  if (!props.editable) return
  const t = ev.target as HTMLElement | null
  if (!t?.closest) return
  if (t.closest('.tbl-handle') || t.closest('.tbl-menu')) {
    cancelHide()
    return
  }
  const table = t.closest('.ProseMirror table') as HTMLTableElement | null
  if (table) {
    cancelHide()
    if (table !== hoverEl) {
      hoverEl = table
      hoverTable = tableRefOf(table)
      scheduleHandle()
    }
    return
  }
  if (hoverEl) scheduleHide()
}

/** 右键单元格：先把光标落进这一格，再在鼠标处打开同一份菜单 */
function cellPosOf($p: ResolvedPos): number {
  for (let d = $p.depth; d > 0; d--) {
    const name = $p.node(d).type.name
    if (name === 'tableCell' || name === 'tableHeader') return $p.before(d)
  }
  return -1
}

function onContextMenu(ev: MouseEvent) {
  const e = props.editor
  if (!e || !props.editable) return
  const t = ev.target as HTMLElement | null
  const table = t?.closest?.('.ProseMirror table') as HTMLTableElement | null
  if (!table) return
  ev.preventDefault()
  try {
    const hit = e.view.posAtCoords({ left: ev.clientX, top: ev.clientY })
    if (hit) {
      const $pos = e.state.doc.resolve(hit.pos)
      const to = cellPosOf($pos)
      const from = cellPosOf(e.state.selection.$from)
      if (to >= 0 && from !== to) {
        e.view.dispatch(e.state.tr.setSelection(TextSelection.near($pos)))
      }
    }
  } catch {
    /* 坐标落在表格边框上时 posAtCoords 可能失效，沿用当前选区 */
  }
  hoverEl = table
  hoverTable = tableRefOf(table)
  updateHandle()
  openMenuAt(ev.clientX, ev.clientY, hoverTable)
}

function onDocDown(ev: MouseEvent) {
  if (!menuOpen.value) return
  const t = ev.target as HTMLElement | null
  if (t?.closest?.('.tbl-handle') || t?.closest?.('.tbl-menu')) return
  menuOpen.value = false
  menuTable = null
}

function onScroll() {
  if (menuOpen.value) {
    menuOpen.value = false
    menuTable = null
  }
  scheduleHandle()
}

function onKeyDown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  if (menuOpen.value) {
    menuOpen.value = false
    menuTable = null
  }
}

const onSelection = () => scheduleHandle()
const onTransaction = () => {
  // 表格被合并/删除后 hover 的 DOM 已失效，清掉缓存重新找
  if (hoverTable && !hoverTable.el.isConnected) {
    hoverEl = null
    hoverTable = null
  }
  scheduleHandle()
}

let bound: Editor | null = null
function bind(e?: Editor) {
  if (bound) {
    bound.off('selectionUpdate', onSelection)
    bound.off('transaction', onTransaction)
    try {
      bound.view.dom.removeEventListener('contextmenu', onContextMenu)
    } catch {
      /* 编辑器已销毁 */
    }
  }
  bound = e ?? null
  if (!e) return
  e.on('selectionUpdate', onSelection)
  e.on('transaction', onTransaction)
  e.view.dom.addEventListener('contextmenu', onContextMenu)
  scheduleHandle()
}

onMounted(() => {
  bind(props.editor)
  document.addEventListener('mousemove', onMouseMove, { passive: true })
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', scheduleHandle)
})

onBeforeUnmount(() => {
  bind(undefined)
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('scroll', onScroll, true)
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', scheduleHandle)
  cancelHide()
  if (raf) cancelAnimationFrame(raf)
})

watch(() => props.editor, (e) => bind(e))
watch(
  () => props.editable,
  (v) => {
    if (!v) {
      handleVisible.value = false
      menuOpen.value = false
      menuTable = null
      hoverEl = null
      hoverTable = null
    } else scheduleHandle()
  },
)
</script>

<template>
  <template v-if="editable">
    <!-- 块手柄：表格左上角，图标开菜单、六点选中整表、＋ 末尾追加行 -->
    <div
      v-if="handleVisible"
      ref="handleEl"
      class="tbl-handle"
      :style="{ left: handlePos.left + 'px', top: handlePos.top + 'px' }"
      @mousedown.prevent
      @mouseenter="cancelHide"
    >
      <div class="tbl-grip-row">
        <button
          :class="['tbl-hbtn', { on: menuOpen }]"
          title="表格操作"
          @click="openMenuFromHandle"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
            <path v-for="d in ICONS.table" :key="d" :d="d" />
          </svg>
        </button>
        <button class="tbl-hbtn tbl-hdots" title="选中整张表格" @click="selectTable">
          <svg viewBox="0 0 16 16" fill="currentColor" stroke="none">
            <path v-for="d in ICONS.grip" :key="d" :d="d" />
          </svg>
        </button>
      </div>
      <button class="tbl-hadd" title="在下方添加一行" @click="addRowAtEnd">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path v-for="d in ICONS.plus" :key="d" :d="d" />
        </svg>
      </button>
    </div>

    <!-- 块菜单：标题行/标题列开关、均分列宽、行列增删、删除表格 -->
    <div
      v-if="menuOpen"
      ref="menuEl"
      class="tbl-menu"
      :style="{ left: menuPos.left + 'px', top: menuPos.top + 'px' }"
      @mousedown.prevent
    >
      <div class="tbl-menu-head">
        <span>{{ sizeLabel }}</span>
      </div>
      <template v-for="row in MENU" :key="row.key">
        <div v-if="row.sep" class="tbl-div" />
        <button :class="['tbl-item', { danger: row.danger }]" @click="apply(row)">
          <svg
            class="tbl-svg"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path v-for="d in ICONS[row.icon]" :key="d" :d="d" />
          </svg>
          <span class="tbl-label">{{ row.label }}</span>
          <span
            v-if="row.switch"
            :class="['tbl-sw', { on: row.key === 'headerRow' ? headerRow : headerCol }]"
          >
            <i />
          </span>
        </button>
      </template>
    </div>
  </template>
</template>

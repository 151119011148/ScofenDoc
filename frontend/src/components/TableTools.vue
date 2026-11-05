<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChainedCommands } from '@tiptap/core'
import type { Editor } from '@tiptap/vue-3'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'

/**
 * 表格操作：飞书式的「表格上方浮动条 + 单元格右键菜单」。
 *
 * 顶部格式栏只留最常用的几个快捷按钮；行列的增删改、表头切换、合并拆分、
 * 删除整张表都收在这两处，光标进表格才出现，不占常驻空间。
 *
 * 所有操作都走 Tiptap 自带的 table 命令（addRow / deleteRow / mergeCells 等），
 * 它们是标准 ProseMirror transaction，能进 Yjs UndoManager，Ctrl+Z 可撤销。
 */

const props = withDefaults(
  defineProps<{ editor?: Editor; editable?: boolean }>(),
  { editor: undefined, editable: true },
)

type Cmd =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn'
  | 'mergeCells'
  | 'splitCell'
  | 'toggleHeaderRow'
  | 'toggleHeaderColumn'
  | 'deleteTable'

interface MenuItem {
  key: Cmd
  label: string
  icon: string
  danger?: boolean
}

interface Group {
  name: string
  items: MenuItem[]
}

const GROUPS: Group[] = [
  {
    name: '行',
    items: [
      { key: 'addRowBefore', label: '在上方插入行', icon: '↑' },
      { key: 'addRowAfter', label: '在下方插入行', icon: '↓' },
      { key: 'deleteRow', label: '删除当前行', icon: '−' },
    ],
  },
  {
    name: '列',
    items: [
      { key: 'addColumnBefore', label: '在左侧插入列', icon: '←' },
      { key: 'addColumnAfter', label: '在右侧插入列', icon: '→' },
      { key: 'deleteColumn', label: '删除当前列', icon: '−' },
    ],
  },
  {
    name: '单元格',
    items: [
      { key: 'mergeCells', label: '合并单元格', icon: '⧉' },
      { key: 'splitCell', label: '拆分单元格', icon: '⧈' },
      { key: 'toggleHeaderRow', label: '切换表头行', icon: '▤' },
      { key: 'toggleHeaderColumn', label: '切换表头列', icon: '▥' },
    ],
  },
  {
    name: '表格',
    items: [{ key: 'deleteTable', label: '删除整个表格', icon: '✕', danger: true }],
  },
]

const QUICK: { key: Cmd; label: string; title: string }[] = [
  { key: 'addRowBefore', label: '↑行', title: '在上方插入行' },
  { key: 'addRowAfter', label: '↓行', title: '在下方插入行' },
  { key: 'addColumnBefore', label: '←列', title: '在左侧插入列' },
  { key: 'addColumnAfter', label: '列→', title: '在右侧插入列' },
  { key: 'deleteRow', label: '删行', title: '删除当前行' },
  { key: 'deleteColumn', label: '删列', title: '删除当前列' },
]

const RUNNERS: Record<Cmd, (c: ChainedCommands) => ChainedCommands> = {
  addRowBefore: (c) => c.addRowBefore(),
  addRowAfter: (c) => c.addRowAfter(),
  deleteRow: (c) => c.deleteRow(),
  addColumnBefore: (c) => c.addColumnBefore(),
  addColumnAfter: (c) => c.addColumnAfter(),
  deleteColumn: (c) => c.deleteColumn(),
  mergeCells: (c) => c.mergeCells(),
  splitCell: (c) => c.splitCell(),
  toggleHeaderRow: (c) => c.toggleHeaderRow(),
  toggleHeaderColumn: (c) => c.toggleHeaderColumn(),
  deleteTable: (c) => c.deleteTable(),
}

const barVisible = ref(false)
const barPos = ref({ left: 0, top: 0 })
const sizeLabel = ref('')
const menuOpen = ref(false)
const menuPos = ref({ left: 0, top: 0 })
const barEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)

function run(cmd: Cmd) {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable) return
  try {
    RUNNERS[cmd](e.chain().focus()).run()
  } catch (err) {
    // 合并/拆分在不适用的选区上 Tiptap 会抛错，这里只让本次操作无效，不带崩编辑器
    console.warn('[table] command failed', cmd, err)
  }
  menuOpen.value = false
  requestAnimationFrame(() => updateBar())
}

/** 从当前选区往上找最近的 table 节点，顺带取它的 DOM 与行列数 */
function tableInfo(e: Editor): { node: PMNode; el: HTMLElement; rows: number; cols: number } | null {
  const { $from } = e.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name !== 'table') continue
    let el: HTMLElement | null = null
    try {
      const dom = e.view.nodeDOM($from.before(d))
      if (dom instanceof HTMLElement) el = dom
    } catch {
      /* 选区正在被远端改动，位置可能暂时无效 */
    }
    if (!el) return null
    const rows = node.childCount
    const cols = rows ? (node.firstChild?.childCount ?? 0) : 0
    return { node, el, rows, cols }
  }
  return null
}

let raf = 0
function scheduleUpdate() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    updateBar()
  })
}

function updateBar() {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable || !e.isActive('table')) {
    barVisible.value = false
    return
  }
  const info = tableInfo(e)
  if (!info) {
    barVisible.value = false
    return
  }
  sizeLabel.value = `${info.rows} 行 × ${info.cols} 列`

  const rect = info.el.getBoundingClientRect()
  // 表格整块滚出视口就别把工具条挂在屏幕边缘
  if (rect.width < 40 || rect.bottom < 70 || rect.top > window.innerHeight - 20) {
    barVisible.value = false
    return
  }
  const w = barEl.value?.offsetWidth || 390
  const left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))
  // 表格顶到吸顶格式栏时，工具条改放在表格顶边内侧，避免被栏遮住
  const top = rect.top >= 100 ? rect.top - 38 : Math.min(rect.top + 6, window.innerHeight - 40)
  barPos.value = { left, top }
  barVisible.value = true
}

function placeMenu(x: number, y: number) {
  const w = 208
  const h = menuEl.value?.offsetHeight || 400
  menuPos.value = {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y,
  }
}

function openMenu(x: number, y: number) {
  menuOpen.value = true
  requestAnimationFrame(() => placeMenu(x, y))
}

function openMore() {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  const b = barEl.value?.getBoundingClientRect()
  const x = b ? Math.max(8, b.right - 208) : barPos.value.left
  const y = b ? b.bottom + 6 : barPos.value.top + 36
  openMenu(x, y)
}

/** 右键单元格时先判断光标在不在这一格，否则「删除行」会删错地方 */
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
  if (!t?.closest?.('table')) return
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
    /* 坐标落在表格边框上，posAtCoords 可能给不出有效位置，直接用当前选区 */
  }
  scheduleUpdate()
  openMenu(ev.clientX, ev.clientY)
}

function onDocDown(ev: MouseEvent) {
  if (!menuOpen.value) return
  const t = ev.target as HTMLElement | null
  if (t?.closest?.('.tbl-bar') || t?.closest?.('.tbl-menu')) return
  menuOpen.value = false
}

function onScroll() {
  if (menuOpen.value) menuOpen.value = false
  scheduleUpdate()
}

function onKeyDown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && menuOpen.value) menuOpen.value = false
}

const onSelection = () => scheduleUpdate()
const onTransaction = () => scheduleUpdate()

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
  scheduleUpdate()
}

onMounted(() => {
  bind(props.editor)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', scheduleUpdate)
})

onBeforeUnmount(() => {
  bind(undefined)
  document.removeEventListener('scroll', onScroll, true)
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', scheduleUpdate)
  if (raf) cancelAnimationFrame(raf)
})

watch(() => props.editor, (e) => bind(e))
watch(
  () => props.editable,
  (v) => {
    if (!v) {
      barVisible.value = false
      menuOpen.value = false
    } else scheduleUpdate()
  },
)
</script>

<template>
  <template v-if="editable">
    <div
      v-if="barVisible"
      ref="barEl"
      class="tbl-bar"
      :style="{ left: barPos.left + 'px', top: barPos.top + 'px' }"
      @mousedown.prevent
    >
      <span class="tbl-size">{{ sizeLabel }}</span>
      <span class="tbl-sep" />
      <button v-for="q in QUICK" :key="q.key" :title="q.title" @click="run(q.key)">{{ q.label }}</button>
      <button class="tbl-more" title="更多表格操作" :class="{ on: menuOpen }" @click="openMore">⋯</button>
    </div>

    <div
      v-if="menuOpen"
      ref="menuEl"
      class="tbl-menu"
      :style="{ left: menuPos.left + 'px', top: menuPos.top + 'px' }"
      @mousedown.prevent
    >
      <template v-for="g in GROUPS" :key="g.name">
        <div class="tbl-group">{{ g.name }}</div>
        <button
          v-for="it in g.items"
          :key="it.key"
          :class="['tbl-item', { danger: it.danger }]"
          @click="run(it.key)"
        >
          <span class="tbl-ic">{{ it.icon }}</span>{{ it.label }}
        </button>
      </template>
    </div>
  </template>
</template>

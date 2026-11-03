<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Doc } from '../api'

const props = defineProps<{
  docs: Doc[]
  currentId: number | null
  /** 拖拽/接口进行中时禁用交互，避免连点造成错乱 */
  disabled?: boolean
  /** 只读（空间角色为 VIEWER）：隐藏写操作入口，也禁用拖拽与双击改名 */
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', doc: Doc): void
  (e: 'create-child', doc: Doc): void
  (e: 'rename', doc: Doc, title: string): void
  (e: 'remove', doc: Doc): void
  (e: 'remove-many', docs: Doc[]): void
  (e: 'move', payload: { doc: Doc; parentId: number | null; index: number | null }): void
}>()

/* ---------------- 组树 ---------------- */

const idSet = computed(() => new Set(props.docs.map((d) => d.id)))

/** 父节点不存在（被删或数据异常）时按根节点处理，避免文档"消失" */
function parentKey(doc: Doc): number | null {
  return doc.parentId !== null && idSet.value.has(doc.parentId) ? doc.parentId : null
}

const childMap = computed(() => {
  const map = new Map<number | null, Doc[]>()
  for (const d of props.docs) {
    const key = parentKey(d)
    const list = map.get(key) ?? []
    list.push(d)
    map.set(key, list)
  }
  return map
})

const expanded = ref<Set<number>>(new Set())
const hasInitExpand = ref(false)

// 拍平成带深度的行，配合展开状态渲染（比递归组件更直观可控）
const rows = computed(() => {
  const out: { doc: Doc; depth: number; hasChildren: boolean }[] = []
  const walk = (parent: number | null, depth: number) => {
    for (const doc of childMap.value.get(parent) ?? []) {
      const children = childMap.value.get(doc.id) ?? []
      out.push({ doc, depth, hasChildren: children.length > 0 })
      if (expanded.value.has(doc.id)) walk(doc.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

// 首次拿到数据时，把所有父节点默认展开
watch(
  () => props.docs,
  (docs) => {
    if (hasInitExpand.value || docs.length === 0) return
    const parents = new Set(docs.map((d) => d.parentId).filter((x): x is number => x !== null))
    expanded.value = new Set(parents)
    hasInitExpand.value = true
  },
  { immediate: true },
)

function toggle(id: number) {
  const next = new Set(expanded.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expanded.value = next
}

// 选中一个尚未展开的父节点时自动展开，省一次点击
function select(doc: Doc) {
  emit('select', doc)
  if ((childMap.value.get(doc.id) ?? []).length > 0 && !expanded.value.has(doc.id)) {
    expanded.value = new Set([...expanded.value, doc.id])
  }
}

/* ---------------- Shift / Ctrl 多选 ---------------- */

const selectedIds = ref<Set<number>>(new Set())
let anchorId: number | null = null

/** 当前展示行的扁平 id 序列（与 rows 同序），用于 Shift 范围选择 */
const rowIds = computed(() => rows.value.map((r) => r.doc.id))

function toggleSelected(id: number) {
  const next = new Set(selectedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedIds.value = next
}

function rangeSelect(fromId: number, toId: number) {
  const ids = rowIds.value
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from === -1 || to === -1) return
  const [lo, hi] = from < to ? [from, to] : [to, from]
  const range = new Set(ids.slice(lo, hi + 1))
  selectedIds.value = new Set([...selectedIds.value, ...range])
}

function clearSelection() {
  selectedIds.value = new Set()
}

/** 行点击：区分普通 / Shift / Ctrl(Cmd) 三种 */
function onRowClick(e: MouseEvent, doc: Doc) {
  if (e.shiftKey) {
    // Shift：从锚点到当前行范围多选
    e.preventDefault()
    const from = anchorId ?? doc.id
    rangeSelect(from, doc.id)
    anchorId = doc.id
    return
  }
  if (e.metaKey || e.ctrlKey) {
    // Ctrl/Cmd：切换单个选中态，不改变打开文档
    e.preventDefault()
    toggleSelected(doc.id)
    anchorId = doc.id
    return
  }
  // 普通点击：单选 + 打开文档 + 清空多选
  clearSelection()
  anchorId = doc.id
  select(doc)
}

/** 批量删除入口 */
function removeSelected() {
  if (selectedIds.value.size === 0) return
  const docs = rows.value.filter((r) => selectedIds.value.has(r.doc.id)).map((r) => r.doc)
  emit('remove-many', docs)
}

/* ---------------- 行内重命名 ---------------- */

const editingId = ref<number | null>(null)
const editingTitle = ref('')

async function startRename(doc: Doc) {
  editingId.value = doc.id
  editingTitle.value = doc.title
  await nextTick()
  const el = document.querySelector<HTMLInputElement>('.rename-input')
  el?.focus()
  el?.select()
}

function commitRename() {
  const id = editingId.value
  if (id === null) return
  const title = editingTitle.value.trim()
  const doc = props.docs.find((d) => d.id === id)
  editingId.value = null
  if (doc && title && title !== doc.title) emit('rename', doc, title)
}

function cancelRename() {
  editingId.value = null
}

/* ---------------- 拖拽改层级 / 改顺序 ---------------- */

type Zone = 'before' | 'inside' | 'after'

const dragId = ref<number | null>(null)
const dropId = ref<number | 'root' | null>(null)
const dropZone = ref<Zone | null>(null)

/** 某文档的整棵子树 id 集合（含自己），用于禁止拖进自己的后代 */
function subtreeIds(rootId: number): Set<number> {
  const out = new Set<number>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const child of childMap.value.get(cur) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return out
}

/** 目标父节点下的兄弟（排除正在拖的那篇，和后端 moveDoc 的算法保持一致） */
function siblingsOf(parentId: number | null): Doc[] {
  return (childMap.value.get(parentId) ?? []).filter((d) => d.id !== dragId.value)
}

function onDragStart(e: DragEvent, doc: Doc) {
  if (props.disabled || props.readonly || editingId.value !== null) {
    e.preventDefault()
    return
  }
  dragId.value = doc.id
  // Firefox 必须写 dataTransfer 才会真正开始拖拽
  e.dataTransfer?.setData('text/plain', String(doc.id))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

/** 判断落在行的上/中/下哪个区域：上=前面、中=变成子文档、下=后面 */
function zoneOf(e: DragEvent, el: HTMLElement): Zone {
  const rect = el.getBoundingClientRect()
  const rel = (e.clientY - rect.top) / rect.height
  if (rel < 0.28) return 'before'
  if (rel > 0.72) return 'after'
  return 'inside'
}

function canDropOn(target: Doc): boolean {
  if (dragId.value === null || dragId.value === target.id) return false
  // 不能拖进自己的后代（否则成环）
  return !subtreeIds(dragId.value).has(target.id)
}

function onDragOver(e: DragEvent, doc: Doc) {
  if (props.disabled || props.readonly || !canDropOn(doc)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropId.value = doc.id
  dropZone.value = zoneOf(e, e.currentTarget as HTMLElement)
}

function onDragLeave(doc: Doc) {
  if (dropId.value === doc.id) {
    dropId.value = null
    dropZone.value = null
  }
}

function onDrop(e: DragEvent, target: Doc) {
  if (props.disabled || props.readonly || !canDropOn(target)) return
  e.preventDefault()
  const dragged = props.docs.find((d) => d.id === dragId.value)
  const zone = zoneOf(e, e.currentTarget as HTMLElement)
  resetDrag()
  if (!dragged) return

  if (zone === 'inside') {
    expanded.value = new Set([...expanded.value, target.id])
    emit('move', { doc: dragged, parentId: target.id, index: siblingsOf(target.id).length })
    return
  }

  const parent = parentKey(target)
  const list = siblingsOf(parent)
  const at = list.findIndex((d) => d.id === target.id)
  const index = zone === 'before' ? Math.max(0, at) : at + 1
  emit('move', { doc: dragged, parentId: parent, index })
}

/* 拖到树底部空白 → 提到根目录末尾 */
const rootHover = ref(false)

function onRootDragOver(e: DragEvent) {
  if (props.disabled || dragId.value === null) return
  e.preventDefault()
  rootHover.value = true
  dropId.value = 'root'
  dropZone.value = 'inside'
}

function onRootDrop(e: DragEvent) {
  if (props.disabled || dragId.value === null) return
  e.preventDefault()
  const dragged = props.docs.find((d) => d.id === dragId.value)
  const index = siblingsOf(null).length
  resetDrag()
  if (dragged && parentKey(dragged) !== null) {
    emit('move', { doc: dragged, parentId: null, index })
  }
}

function resetDrag() {
  dragId.value = null
  dropId.value = null
  dropZone.value = null
  rootHover.value = false
}
</script>

<template>
  <div class="tree" @dragend="resetDrag">
    <!-- 多选工具栏：有选中项时显示 -->
    <div v-if="selectedIds.size > 0 && !readonly" class="tree-batch-bar">
      <span class="batch-count">已选 {{ selectedIds.size }} 篇</span>
      <button class="batch-btn" title="批量删除" @click="removeSelected">🗑 删除</button>
      <button class="batch-btn" title="取消选择" @click="clearSelection">取消</button>
    </div>

    <div
      v-for="row in rows"
      :key="row.doc.id"
      :class="[
        'tree-row',
        {
          active: row.doc.id === currentId,
          selected: selectedIds.has(row.doc.id),
          dragging: dragId === row.doc.id,
          'drop-before': dropId === row.doc.id && dropZone === 'before',
          'drop-after': dropId === row.doc.id && dropZone === 'after',
          'drop-inside': dropId === row.doc.id && dropZone === 'inside',
        },
      ]"
      :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
      :draggable="editingId === null && !readonly"
      @dragstart="onDragStart($event, row.doc)"
      @dragover="onDragOver($event, row.doc)"
      @dragleave="onDragLeave(row.doc)"
      @drop="onDrop($event, row.doc)"
      @click="onRowClick($event, row.doc)"
      @dblclick="!readonly && startRename(row.doc)"
    >
      <span
        v-if="row.hasChildren"
        class="twist"
        :class="{ open: expanded.has(row.doc.id) }"
        @click.stop="toggle(row.doc.id)"
        >▸</span
      >
      <span v-else class="twist placeholder" />

      <span class="doc-icon">📄</span>

      <input
        v-if="editingId === row.doc.id"
        v-model="editingTitle"
        class="rename-input"
        @click.stop
        @keyup.enter="commitRename"
        @keyup.esc="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="title" :title="row.doc.title">{{ row.doc.title }}</span>

      <span v-if="!readonly" class="actions" @click.stop>
        <button title="新建子文档" @click="emit('create-child', row.doc)">＋</button>
        <button title="重命名" @click="startRename(row.doc)">✎</button>
        <button title="删除" @click="emit('remove', row.doc)">🗑</button>
      </span>
    </div>

    <div v-if="rows.length === 0" class="tree-empty">这个空间还没有文档</div>

    <!-- 拖到根目录：把子文档提为顶层 -->
    <div
      v-if="dragId !== null && !readonly"
      :class="['tree-root-drop', { hover: rootHover }]"
      @dragover="onRootDragOver"
      @dragleave="rootHover = false"
      @drop="onRootDrop"
    >
      松手移到根目录
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  /** 拖拽落位：docs 为被拖的一组文档（单选时就是一篇），按树内顺序排列 */
  (e: 'move', payload: { docs: Doc[]; parentId: number | null; index: number | null }): void
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

/** 本次拖拽涉及的文档 id（多选时为整批，保持树内顺序） */
const dragIds = ref<number[]>([])
const dropId = ref<number | 'root' | null>(null)
const dropZone = ref<Zone | null>(null)

const byId = computed(() => new Map(props.docs.map((d) => [d.id, d])))

const dragging = computed(() => dragIds.value.length > 0)

/** 某文档的祖先 id 链（父 → 根） */
function ancestorIds(id: number): number[] {
  const out: number[] = []
  let cur = byId.value.get(id)?.parentId ?? null
  let guard = 0
  while (cur !== null && guard++ < 100) {
    out.push(cur)
    cur = byId.value.get(cur)?.parentId ?? null
  }
  return out
}

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

/**
 * 从拖拽集合里剔掉「祖先也在集合里」的项。
 * 拖父节点时子节点跟着走，若再单独移它一次，层级反而被打乱。
 */
function pruneNested(ids: number[]): number[] {
  const set = new Set(ids)
  return ids.filter((id) => !ancestorIds(id).some((a) => set.has(a)))
}

/** 所有被拖文档的子树并集：落点落在这里面一律不允许（会成环） */
const dragSubtree = computed(() => {
  const out = new Set<number>()
  for (const id of dragIds.value) {
    for (const x of subtreeIds(id)) out.add(x)
  }
  return out
})

/** 目标父节点下的兄弟（排除正在拖的那批，和后端 moveDoc 的算法保持一致） */
function siblingsOf(parentId: number | null): Doc[] {
  return (childMap.value.get(parentId) ?? []).filter((d) => !dragIds.value.includes(d.id))
}

function onDragStart(e: DragEvent, doc: Doc) {
  if (props.disabled || props.readonly || editingId.value !== null) {
    e.preventDefault()
    return
  }
  // 拖的是选中项 → 整批拖；否则只拖这一篇
  const picked =
    selectedIds.value.has(doc.id) && selectedIds.value.size > 1
      ? rows.value.filter((r) => selectedIds.value.has(r.doc.id)).map((r) => r.doc.id)
      : [doc.id]
  dragIds.value = pruneNested(picked)
  // Firefox 必须写 dataTransfer 才会真正开始拖拽
  e.dataTransfer?.setData('text/plain', dragIds.value.join(','))
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
  if (!dragging.value) return false
  // 落点是自己或自己的后代 → 会成环
  return !dragSubtree.value.has(target.id)
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

/** 被拖的那批文档，按树内顺序取出来 */
function draggedDocs(): Doc[] {
  return dragIds.value
    .map((id) => props.docs.find((d) => d.id === id))
    .filter((d): d is Doc => !!d)
}

function onDrop(e: DragEvent, target: Doc) {
  if (props.disabled || props.readonly || !canDropOn(target)) return
  e.preventDefault()
  const moving = draggedDocs()
  const zone = zoneOf(e, e.currentTarget as HTMLElement)
  if (moving.length === 0) {
    resetDrag()
    return
  }

  if (zone === 'inside') {
    const index = siblingsOf(target.id).length
    resetDrag()
    expanded.value = new Set([...expanded.value, target.id])
    emit('move', { docs: moving, parentId: target.id, index })
    return
  }

  const parent = parentKey(target)
  const list = siblingsOf(parent)
  const at = list.findIndex((d) => d.id === target.id)
  // 批量拖拽保持原有上下顺序：整块插到落点位置，后面由 App 依次 +1 递进
  const index = zone === 'before' ? Math.max(0, at) : at + 1
  resetDrag()
  emit('move', { docs: moving, parentId: parent, index })
}

/* 拖到树底部空白 → 提到根目录末尾 */
const rootHover = ref(false)

function onRootDragOver(e: DragEvent) {
  if (props.disabled || props.readonly || !dragging.value) return
  e.preventDefault()
  rootHover.value = true
  dropId.value = 'root'
  dropZone.value = 'inside'
}

function onRootDrop(e: DragEvent) {
  if (props.disabled || props.readonly || !dragging.value) return
  e.preventDefault()
  // 已经是根节点的跳过（后端允许，但没必要多打一次接口）
  const moving = draggedDocs().filter((d) => parentKey(d) !== null)
  const index = siblingsOf(null).length
  resetDrag()
  if (moving.length > 0) emit('move', { docs: moving, parentId: null, index })
}

function resetDrag() {
  dragIds.value = []
  dropId.value = null
  dropZone.value = null
  rootHover.value = false
}

/* ---------------- 定位当前文档 ---------------- */

/**
 * 打开一篇文档时，树要把它「指出来」：祖先全展开 → 滚到可见 → 高亮。
 *
 * 只做一次：同一篇文档在列表刷新（改名、拖动、协同更新）时不再抢滚动，
 * 否则用户正滚着看别的分支，一保存就被拽回当前文档，很难用。
 */
const treeEl = ref<HTMLElement | null>(null)
/** 上一次已经定位过的文档，用来挡住列表刷新时的重复定位 */
let revealedId: number | null = null
/** 刚滚过来的那一行闪一下，视线能跟上（滚动了才闪） */
const locateId = ref<number | null>(null)
let locateTimer: number | undefined

function rowOf(id: number): HTMLElement | null {
  return treeEl.value?.querySelector<HTMLElement>(`[data-doc-id="${id}"]`) ?? null
}

/** 离元素最近的、真的能滚的祖先（树的滚动容器可能就是 .nav-tree 自己） */
function innerScroller(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

/**
 * 让行露出来。已经在可视区里就一点都不动（返回 false），
 * 完全在视野外就居中放，贴着边缘就按最近方向挪一点 —— 都只动树的滚动容器，
 * 不会把上面的空间列表一起卷走。
 */
function revealRow(el: HTMLElement): boolean {
  const box = innerScroller(el)
  if (!box) return false
  const pad = 10
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  // 布局还没算出来（首帧容器高度为 0）时不做判断，否则会把「都是 0」算成需要滚动
  if (!r.height || !b.height) return false
  if (r.top >= b.top + pad && r.bottom <= b.bottom - pad) return false
  const far = r.bottom < b.top || r.top > b.bottom
  const delta = far
    ? r.top - b.top - (b.height - r.height) / 2
    : r.top < b.top + pad
      ? r.top - b.top - pad
      : r.bottom - b.bottom + pad
  const before = box.scrollTop
  box.scrollTop += delta
  // 已经滚到顶/底时 scrollTop 会被夹住不动，这种不算「滚过去了」，别闪
  return Math.abs(box.scrollTop - before) > 0.5
}

function flashRow(id: number) {
  locateId.value = id
  window.clearTimeout(locateTimer)
  locateTimer = window.setTimeout(() => (locateId.value = null), 1200)
}

/**
 * 定位到指定文档（默认当前文档）。
 * 祖先被收起时目标行根本不在 DOM 里，先展开再看。
 */
async function reveal(id: number | null = props.currentId) {
  if (id === null || !byId.value.has(id)) return
  const chain = ancestorIds(id)
  if (chain.some((x) => !expanded.value.has(x))) {
    expanded.value = new Set([...expanded.value, ...chain])
    await nextTick()
  }
  // 拿不到行说明 DOM 还没落地（首帧 / 组件刚挂载），这次不算定位过，
  // 留给下一次触发或 onMounted 重试 —— 否则这一篇会被记成「已定位」，再也不动
  const el = rowOf(id)
  if (!el) return
  if (revealRow(el)) flashRow(id)
  revealedId = id
}

// 切文档（或文档列表刚到齐）时定位一次
watch(
  () => [props.currentId, props.docs] as const,
  () => {
    const id = props.currentId
    if (id === null) {
      revealedId = null
      return
    }
    if (id === revealedId) return
    // 列表可能晚于「打开文档」到达，没这篇就先不动，等下次
    if (!byId.value.has(id)) return
    reveal(id)
  },
  { immediate: true, flush: 'post' },
)

// immediate 那次在 setup 阶段跑，DOM 还没挂上：挂载后再补一次
onMounted(() => {
  if (props.currentId !== null && props.currentId !== revealedId) reveal()
})

defineExpose({ reveal })

/* ---------------- 右键菜单 ---------------- */

type MenuState = { doc: Doc; batch: Doc[] | null }

const menu = ref<MenuState | null>(null)
const menuPos = ref({ x: 0, y: 0 })
const menuEl = ref<HTMLElement | null>(null)

const MENU_PAD = 8
/** 打开时刻，用于忽略打开瞬间由焦点/布局变化引发的滚动 */
let menuOpenedAt = 0

function showMenu(doc: Doc, x: number, y: number) {
  if (props.readonly || props.disabled || editingId.value !== null) return
  // 右键的行在多选内 → 菜单作用于整批；否则清掉遗留多选，只针对这一篇
  const batch =
    selectedIds.value.has(doc.id) && selectedIds.value.size > 1
      ? rows.value.filter((r) => selectedIds.value.has(r.doc.id)).map((r) => r.doc)
      : null
  if (!batch) clearSelection()
  menu.value = { doc, batch }
  menuPos.value = { x, y }
  menuOpenedAt = Date.now()
  // 贴边时翻转，避免菜单被视口裁掉
  nextTick(() => {
    const el = menuEl.value
    if (!el) return
    let { x: mx, y: my } = menuPos.value
    const { width, height } = el.getBoundingClientRect()
    if (mx + width + MENU_PAD > window.innerWidth) mx = Math.max(MENU_PAD, mx - width)
    if (my + height + MENU_PAD > window.innerHeight) my = Math.max(MENU_PAD, my - height)
    menuPos.value = { x: mx, y: my }
  })
}

function onRowContextMenu(e: MouseEvent, doc: Doc) {
  // 只读空间保留浏览器原生菜单，方便复制文字
  if (props.readonly || props.disabled || editingId.value !== null) return
  e.preventDefault()
  e.stopPropagation()
  showMenu(doc, e.clientX, e.clientY)
}

/** 窄屏没有右键：行内「⋯」按钮唤出同一个菜单 */
function onMoreClick(e: MouseEvent, doc: Doc) {
  e.stopPropagation()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  showMenu(doc, rect.right - 6, rect.bottom + 2)
}

function closeMenu() {
  menu.value = null
}

function onMenuPick(action: 'child' | 'rename' | 'remove') {
  const m = menu.value
  if (!m) return
  closeMenu()
  if (action === 'child') return emit('create-child', m.doc)
  if (action === 'rename') return startRename(m.doc)
  if (m.batch) return emit('remove-many', m.batch)
  emit('remove', m.doc)
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && menu.value) closeMenu()
}

function onGlobalScroll() {
  // 滚动后锚点已失效，直接收起；刚打开的 150ms 内不判，避免误关
  if (menu.value && Date.now() - menuOpenedAt > 150) closeMenu()
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('scroll', onGlobalScroll, true)
  window.addEventListener('resize', onGlobalScroll)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('scroll', onGlobalScroll, true)
  window.removeEventListener('resize', onGlobalScroll)
  window.clearTimeout(locateTimer)
})

</script>

<template>
  <div ref="treeEl" class="tree" @dragend="resetDrag">
    <!-- 多选工具栏：有选中项时显示 -->
    <div v-if="selectedIds.size > 0 && !readonly" class="tree-batch-bar">
      <span class="batch-count">已选 {{ selectedIds.size }} 篇 · 拖动整批移动</span>
      <button class="batch-btn" title="删除所选文档" @click="removeSelected">删除所选</button>
      <button class="batch-btn" title="取消选择" @click="clearSelection">取消</button>
    </div>

    <div
      v-for="row in rows"
      :key="row.doc.id"
      :data-doc-id="row.doc.id"
      :class="[
        'tree-row',
        {
          active: row.doc.id === currentId,
          selected: selectedIds.has(row.doc.id),
          // 刚从屏幕外滚过来：闪一下再落回高亮色，视线能跟上
          locating: row.doc.id === locateId,
          'menu-open': menu?.doc.id === row.doc.id,
          dragging: dragIds.includes(row.doc.id),
          'drop-before': dropId === row.doc.id && dropZone === 'before',
          'drop-after': dropId === row.doc.id && dropZone === 'after',
          'drop-inside': dropId === row.doc.id && dropZone === 'inside',
          // 收起（还有子文档没展开）：三角常驻，一眼看出这层被收起来了
          collapsed: row.hasChildren && !expanded.has(row.doc.id),
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
      @contextmenu="onRowContextMenu($event, row.doc)"
    >
      <!-- 折叠三角：样式与「文章大纲」一致 —— 蓝色、悬停才出现、收起后常驻。
           槽位始终占着（叶子行用同宽的 .placeholder），所以出现/消失不会挤动标题 -->
      <button
        v-if="row.hasChildren"
        class="twist"
        :class="{ open: expanded.has(row.doc.id) }"
        type="button"
        :title="expanded.has(row.doc.id) ? `折叠「${row.doc.title}」` : `展开「${row.doc.title}」`"
        :aria-label="expanded.has(row.doc.id) ? `折叠「${row.doc.title}」` : `展开「${row.doc.title}」`"
        :aria-expanded="expanded.has(row.doc.id)"
        @click.stop="toggle(row.doc.id)"
        @dblclick.stop
      />
      <span v-else class="twist placeholder" aria-hidden="true" />

      <span class="doc-icon">📄</span>

      <!-- 章节号由后端按层级派生：拖动改层级/顺序后重新拉列表就会自动重算 -->
      <span v-if="row.doc.number" class="doc-no tree-no">{{ row.doc.number }}</span>

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

      <!-- 桌面端操作都收进右键菜单，行内只在窄屏留一个「⋯」 -->
      <span v-if="!readonly" class="actions" @click.stop>
        <button class="more" title="更多操作（桌面右键同效）" @click="onMoreClick($event, row.doc)">
          ⋯
        </button>
      </span>
    </div>

    <div v-if="rows.length === 0" class="tree-empty">这个空间还没有文档</div>

    <!-- 拖到根目录：把子文档提为顶层 -->
    <div
      v-if="dragging && !readonly"
      :class="['tree-root-drop', { hover: rootHover }]"
      @dragover="onRootDragOver"
      @dragleave="rootHover = false"
      @drop="onRootDrop"
    >
      松手移到根目录
    </div>
  </div>

  <!-- 传送到 body：侧栏是滚动容器（移动端还是 transform 抽屉），fixed 会错位 -->
  <Teleport to="body">
    <div class="ctx-layer">
      <div v-if="menu" class="ctx-mask" @pointerdown="closeMenu" @contextmenu.prevent="closeMenu" />
      <div
        v-if="menu"
        ref="menuEl"
        class="ctx-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
        @contextmenu.prevent
      >
        <div class="ctx-title" :title="menu.batch ? `已选 ${menu.batch.length} 篇` : menu.doc.title">
          <span v-if="!menu.batch && menu.doc.number" class="doc-no ctx-no">{{ menu.doc.number }}</span>
          {{ menu.batch ? `已选 ${menu.batch.length} 篇` : menu.doc.title }}
        </div>
        <button class="ctx-item" @click="onMenuPick('child')">
          <span class="k">＋</span>新建子文档
        </button>
        <button class="ctx-item" @click="onMenuPick('rename')">
          <span class="k">✎</span>重命名
        </button>
        <div class="ctx-sep" />
        <button class="ctx-item danger" @click="onMenuPick('remove')">
          <span class="k">🗑</span>{{ menu.batch ? `删除所选 ${menu.batch.length} 篇` : '删除' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

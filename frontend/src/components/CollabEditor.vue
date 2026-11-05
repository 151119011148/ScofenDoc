<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { ChainedCommands } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import MermaidBlock from '../extensions/MermaidBlock'
import PlantUMLBlock from '../extensions/PlantUMLBlock'
import DiagramCodeBlock from '../extensions/DiagramCodeBlock'
import HeadingFold from '../extensions/HeadingFold'
import HeadingNumber from '../extensions/HeadingNumber'
import ListItemHeading from '../extensions/ListItemHeading'
import TabIndent from '../extensions/TabIndent'
import { CommentMark } from '../extensions/CommentMark'
import SelectionToolbar from './SelectionToolbar.vue'
import TableTools from './TableTools.vue'
import { getLastColor, setLastColor } from '../colorMemory'
import { setLastHeading } from '../headingMemory'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { COLLAB_URL } from '../config'

const props = withDefaults(
  defineProps<{
    docName?: string
    userName?: string
    userColor?: string
    wsUrl?: string
    /** 后端签发的协同 token，只对本篇文档有效 */
    collabToken?: string
    /** 只读：空间角色为 VIEWER 时为 false，只能看不能改 */
    editable?: boolean
    /** 当前空间 id：站内链接没带 space 参数时用它兜底 */
    spaceId?: number
  }>(),
  {
    docName: 'demo-doc',
    userName: '匿名',
    userColor: '#3370ff',
    wsUrl: COLLAB_URL,
    collabToken: '',
    editable: true,
    spaceId: 0,
  },
)

const editor = ref<Editor>()
const toolbarRef = ref<InstanceType<typeof SelectionToolbar> | null>(null)
let provider: HocuspocusProvider | null = null

/** 顶部格式栏：吸顶后加个投影，让「已经贴上去了」有视觉反馈 */
const barEl = ref<HTMLElement | null>(null)
const barStuck = ref(false)
let barScrollHost: HTMLElement | null = null

// 在 setup 里创建，选中文工具栏要拿它挂评论 Map（换文档时组件整体重建，实例天然隔离）
const ydoc = new Y.Doc()

/**
 * 撤销/重做快捷键补全。
 *
 * 关掉 StarterKit 的 history 后，撤销由 Collaboration 扩展提供（Yjs UndoManager），
 * 它只注册了 Mod-z —— 在 macOS 上 Mod 等于 ⌘，所以习惯按 Ctrl+Z 的人会觉得"撤不了"。
 * 这里把 Ctrl 系列也显式绑上，两个平台的肌肉记忆都能用。
 * 注意必须走 editor.commands.undo()，那是 Yjs 的撤销栈；用 ProseMirror 的 history 会和 CRDT 打架。
 */
const UndoRedoShortcuts = Extension.create({
  name: 'undoRedoShortcuts',
  addKeyboardShortcuts() {
    return {
      'Ctrl-z': () => this.editor.commands.undo(),
      'Ctrl-Shift-z': () => this.editor.commands.redo(),
      'Ctrl-y': () => this.editor.commands.redo(),
    }
  },
})

const emit = defineEmits<{
  /** 编辑器实例就绪后上报，供大纲/折叠等外部面板使用 */
  (e: 'editor-ready', editor: Editor): void
  /** 点了站内链接：交给外层切换文档并滚到锚点，不整页刷新 */
  (e: 'navigate', payload: { spaceId: number; docId: number; anchor: string }): void
}>()
const connected = ref(false)
const peers = ref(0)
const authError = ref('')

/* ---------------- 斜杠菜单数据 ---------------- */

interface SlashItem {
  key: string
  label: string
  hint: string
  icon: string
  color?: string
  keywords: string
  run: (chain: ChainedCommands) => ChainedCommands
  /** 二级子菜单：展开后替代主项 */
  children?: SlashItem[]
}

interface SlashGroup {
  name: string
  items: SlashItem[]
}

const TABLE_PRESETS = [
  { rows: 2, cols: 2, label: '2×2', hint: '2 行 2 列' },
  { rows: 3, cols: 3, label: '3×3', hint: '3 行 3 列（带表头）' },
  { rows: 4, cols: 4, label: '4×4', hint: '4 行 4 列' },
  { rows: 5, cols: 5, label: '5×5', hint: '5 行 5 列' },
  { rows: 6, cols: 8, label: '6×8', hint: '宽表：6 行 8 列' },
]

/**
 * 斜杠菜单设标题：顺手记住级别，之后正文里选中别的行，
 * 浮动工具条的标题主键点一下就套用这个级别，不用每次都翻菜单。
 */
function markHeading(level: 1 | 2 | 3 | 4 | 5 | 6, c: ChainedCommands) {
  setLastHeading(level)
  return c.toggleHeading({ level })
}

const SLASH_GROUPS: SlashGroup[] = [
  {
    name: '基础',
    items: [
      { key: 'h1', label: '一级标题', hint: '章节大标题', icon: 'H1', keywords: 'h1 yiji biaoti title', run: (c) => markHeading(1, c) },
      { key: 'h2', label: '二级标题', hint: '小节标题', icon: 'H2', keywords: 'h2 erji biaoti title', run: (c) => markHeading(2, c) },
      { key: 'h3', label: '三级标题', hint: '更小的标题', icon: 'H3', keywords: 'h3 sanji biaoti title', run: (c) => markHeading(3, c) },
      { key: 'h4', label: '四级标题', hint: '四级小节', icon: 'H4', keywords: 'h4 siji biaoti title', run: (c) => markHeading(4, c) },
      { key: 'h5', label: '五级标题', hint: '五级小节', icon: 'H5', keywords: 'h5 wuji biaoti title', run: (c) => markHeading(5, c) },
      { key: 'h6', label: '六级标题', hint: '最深一级', icon: 'H6', keywords: 'h6 liuji biaoti title', run: (c) => markHeading(6, c) },
      { key: 'hnum', label: '有序标题', hint: '标题 + 有序序号 1 / 1.1', icon: '№', keywords: 'youxu biaoti bianhao heading number 有序 编号', run: (c) => c.toggleHeadingNumber(true, 'ordered') },
      { key: 'hbullet', label: '无序标题', hint: '标题 + 层级符号 ● ○ ■', icon: '●', keywords: 'wuxu biaoti heading bullet unordered 无序 符号', run: (c) => c.toggleHeadingNumber(true, 'unordered') },
      { key: 'bullet', label: '无序列表', hint: '圆点列表', icon: '•', keywords: 'wuxu liebiao list bullet ul', run: (c) => c.toggleBulletList() },
      { key: 'ordered', label: '有序列表', hint: '带编号列表', icon: '1.', keywords: 'youxu liebiao list ordered ol number', run: (c) => c.toggleOrderedList() },
      { key: 'task', label: '待办清单', hint: '可勾选的任务项', icon: '☑', keywords: 'daiban qingdan todo task checkbox', run: (c) => c.toggleTaskList() },
      { key: 'code', label: '代码块', hint: '等宽字体代码', icon: '</>', keywords: 'daima code codeblock', run: (c) => c.toggleCodeBlock() },
      { key: 'quote', label: '引用', hint: '引述一段话', icon: '❝', keywords: 'yinyong quote blockquote', run: (c) => c.toggleBlockquote() },
      { key: 'text', label: '正文', hint: '普通段落', icon: '¶', keywords: 'zhengwen text p paragraph', run: (c) => c.setParagraph() },
      { key: 'divider', label: '分割线', hint: '分隔内容区块', icon: '─', keywords: 'fengexian divider hr line', run: (c) => c.setHorizontalRule() },
      // run 是空转：图片需要先问地址，由 applySlash 里的 insertImageByUrl 接管
      { key: 'image', label: '图片', hint: '按图片地址插入', icon: '🖼', keywords: 'tupian image img picture photo', run: (c) => c },
    ],
  },
  {
    name: '常用',
    items: [
      {
        key: 'table', label: '表格', hint: '插入表格', icon: '▦', color: '#16a085', keywords: 'biaoge table grid liebiao',
        run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
        children: TABLE_PRESETS.map((p) => ({
          key: `table-${p.rows}x${p.cols}`, label: `表格 ${p.label}`, hint: p.hint, icon: '▦',
          keywords: `biaoge table ${p.rows} ${p.cols}`,
          run: (c) => c.insertTable({ rows: p.rows, cols: p.cols, withHeaderRow: true }),
        })),
      },
      { key: 'mermaid', label: 'Mermaid 图', hint: 'flowchart / sequence 流程图', icon: '🖼', color: '#e67e22', keywords: 'mermaid liucheng tu flowchart sequence graph 图', run: (c) => c.insertContent({ type: 'mermaid', attrs: { code: 'graph TD\n  A[开始] --> B[结束]' } }) },
      { key: 'plantuml', label: 'PlantUML 图', hint: '时序图/类图/用例图', icon: '🌱', color: '#27ae60', keywords: 'plantuml puml uml shixu tu sequence class usecase 图', run: (c) => c.insertContent({ type: 'plantuml', attrs: { code: '@startuml\nAlice -> Bob: Hello\n@enduml' } }) },
    ],
  },
]

const ALL_ITEMS: SlashItem[] = SLASH_GROUPS.flatMap((g) => g.items)

/* ---------------- 斜杠菜单状态 ---------------- */

const slashOpen = ref(false)
const slashX = ref(0)
const slashY = ref(0)
const slashFrom = ref(0)
const slashTo = ref(0)
const slashQuery = ref('')
const slashIndex = ref(0)

/* ---------------- 行内 + 按钮 / 块菜单 ---------------- */

/** 菜单来源：'slash' 由 / 触发（选中后替换 /xxx），'plus' 由行内 + 触发（在当前块后插入） */
const menuSource = ref<'slash' | 'plus'>('slash')
/** 块菜单要在「当前块之后」插入，记录目标块的结束 pos */
const plusBlockTo = ref(0)
/** 行内 + 按钮本身的位置（相对正文容器） */
const plusDotX = ref(0)
const plusDotY = ref(0)
const plusDotVisible = ref(false)

/** 无查询时按分组返回；有查询时跨分组扁平搜索（含子菜单项），并按匹配强度排序 */
const filtered = computed(() => {
  const q = slashQuery.value.trim().toLowerCase()
  if (!q) return SLASH_GROUPS

  // 0 文本以查询开头 → 1 文本包含 → 2 key 以查询开头 → 3 拼音/英文关键词命中
  const scored: { item: SlashItem; score: number; order: number }[] = []
  ALL_ITEMS.forEach((item, order) => {
    const label = item.label.toLowerCase()
    let score = -1
    if (label.startsWith(q)) score = 0
    else if (label.includes(q)) score = 1
    else if (item.key.toLowerCase().startsWith(q)) score = 2
    else if (item.keywords.toLowerCase().includes(q)) score = 3
    if (score >= 0) scored.push({ item, score, order })
  })
  const sorted = scored.sort((a, b) => a.score - b.score || a.order - b.order).map((x) => x.item)
  return sorted.length ? [{ name: '匹配结果', items: sorted }] : []
})

/** 当前处于「展开子菜单」状态时的父项 key（非空表示在展示子菜单） */
const submenuOf = ref('')

/** 子菜单项列表（当 submenuOf 指向某父项时） */
const activeChildren = computed(() => {
  if (!submenuOf.value) return []
  return ALL_ITEMS.find((i) => i.key === submenuOf.value)?.children ?? []
})

/* ---------------- 文字颜色记忆 ---------------- */

/** 从一组 marks 里取出文字颜色（TextStyle 的 color），没有颜色返回空串 */
function colorOfMarks(marks: readonly Mark[]): string {
  for (const m of marks) {
    if (m.type.name === 'textStyle') return (m.attrs.color as string) || ''
  }
  return ''
}

/** 取一个块（或文本节点）里最后一个文本节点的 marks */
function lastTextMarks(node: PMNode | null | undefined): readonly Mark[] {
  if (!node) return []
  if (node.isText) return node.marks
  let marks: readonly Mark[] = []
  node.descendants((child) => {
    if (child.isText) marks = child.marks
    return true
  })
  return marks
}

/**
 * 光标前紧挨着的文字是什么颜色。
 *
 * 回车换段是最常见的情形：新段落是空的，段落内部找不到任何文字，
 * 这时要退回上一块的末尾去看——「上一段是红的，这一段接着写还想要红」就靠这一步。
 */
function colorBeforeCaret(state: EditorState, pos: number): string {
  const $pos = state.doc.resolve(pos)

  const inline = $pos.nodeBefore
  if (inline?.isText) return colorOfMarks(inline.marks)

  // 段首 / 空段：看上一块
  let depth = $pos.depth
  while (depth > 0) {
    const before = $pos.before(depth)
    if (before > 0) {
      const prev = state.doc.resolve(before).nodeBefore
      if (!prev) return ''
      // 上一块是代码块、图片、分割线之类，没有「文字颜色」可继承
      if (!prev.isTextblock) return ''
      return colorOfMarks(lastTextMarks(prev))
    }
    depth--
  }
  return ''
}

/**
 * 让新输入的文字延续「记忆色」。
 *
 * 触发条件刻意收得很紧：光标处本身没颜色时，只有当光标紧挨着的文字正好是记忆色，
 * 才把它塞进 storedMarks。这样红色段落后面的续写自动是红色，而正文其他位置
 * 不会莫名其妙被上一次的颜色污染。
 */
function applyColorMemory() {
  const ed = editor.value
  if (!ed || ed.isDestroyed || !ed.isEditable) return

  const { state, view } = ed
  const sel = state.selection
  if (!sel.empty) return

  const remembered = getLastColor()
  const current = colorOfMarks((state.storedMarks ?? sel.$from.marks()) as readonly Mark[])

  // 光标已经落在有色文字里：把颜色记为记忆，后续输入由 ProseMirror 自然延续
  if (current) {
    if (current !== remembered) setLastColor(current)
    return
  }

  if (!remembered) return
  if (colorBeforeCaret(state, sel.from) !== remembered) return

  const textStyle = state.schema.marks.textStyle
  if (!textStyle) return

  const base = (state.storedMarks ?? (sel.$from.marks() as readonly Mark[])).filter(
    (m) => m.type.name !== 'textStyle',
  )
  view.dispatch(state.tr.setStoredMarks([...base, textStyle.create({ color: remembered })]))
}

let colorMemoryQueued = false

/**
 * selectionUpdate 本身就在一次 dispatch 里，直接再 dispatch 会打架，
 * 挪到本轮微任务之后执行（仍在下一个按键事件之前，不会漏字）。
 */
function scheduleColorMemory() {
  if (colorMemoryQueued) return
  colorMemoryQueued = true
  queueMicrotask(() => {
    colorMemoryQueued = false
    try {
      applyColorMemory()
    } catch {
      /* 文档正在被远端改动、位置失效时忽略即可 */
    }
  })
}

/* ---------------- 顶部格式栏状态 ----------------
 * isActive() 不是响应式的：光标从正文挪进表格，Vue 不会自己重渲染，
 * 于是「表格操作」按钮组常年不出现。用 transaction 计数驱动一次重算即可。
 */

const barTick = ref(0)
const numMenuOpen = ref(false)

const barState = computed(() => {
  void barTick.value
  const e = editor.value
  if (!e || e.isDestroyed) {
    return {
      bold: false, italic: false, strike: false, underline: false, code: false,
      h1: false, h2: false, bullet: false, ordered: false, task: false,
      quote: false, table: false, numbered: false, numberStyle: '',
    }
  }
  return {
    bold: e.isActive('bold'),
    italic: e.isActive('italic'),
    strike: e.isActive('strike'),
    underline: e.isActive('underline'),
    code: e.isActive('code'),
    h1: e.isActive('heading', { level: 1 }),
    h2: e.isActive('heading', { level: 2 }),
    bullet: e.isActive('bulletList'),
    ordered: e.isActive('orderedList'),
    task: e.isActive('taskList'),
    quote: e.isActive('blockquote'),
    table: e.isActive('table'),
    numbered: e.isActive('heading', { numbered: true }),
    numberStyle: e.isActive('heading')
      ? ((e.getAttributes('heading').numberStyle as string) || 'ordered')
      : '',
  }
})

/**
 * 顶部格式栏设标题：顺手记住级别，选中工具条的标题主键随后就能一键复用。
 *
 * 顶部栏本身是切换按钮（点亮再点回正文），所以保留 toggleHeading 的手感；
 * 记忆跟着「这一下之后是什么」走 —— 转成标题就记住级别，退回正文就记正文。
 */
function applyBarHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const e = editor.value
  if (!e) return
  const turningOn = !e.isActive('heading', { level })
  e.chain().focus().toggleHeading({ level }).run()
  setLastHeading(turningOn ? level : 0)
}

function toggleCurrentNumber() {
  editor.value?.chain().focus().toggleHeadingNumber().run()
  numMenuOpen.value = false
}

/** 当前标题切到有序 / 无序；再点同一样式即关闭前缀 */
function setCurrentNumberStyle(style: 'ordered' | 'unordered') {
  const e = editor.value
  if (!e) return
  const active =
    e.isActive('heading', { numbered: true }) &&
    ((e.getAttributes('heading').numberStyle as string) || 'ordered') === style
  if (active) e.chain().focus().toggleHeadingNumber(false).run()
  else e.chain().focus().toggleHeadingNumber(true, style).run()
  numMenuOpen.value = false
}

function setAllNumbered(value: boolean, style?: 'ordered' | 'unordered') {
  editor.value?.chain().focus().setAllHeadingsNumbered(value, style).run()
  numMenuOpen.value = false
}

/** 点格式栏之外收起「全文编号」下拉 */
function onGlobalDown(e: MouseEvent) {
  if (!numMenuOpen.value) return
  const t = e.target as HTMLElement | null
  if (!t?.closest?.('.num-dd')) numMenuOpen.value = false
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape') numMenuOpen.value = false
}

/* ---------------- 顶部栏吸顶状态 ---------------- */

function updateBarStuck() {
  const el = barEl.value
  if (!el) return
  const host = barScrollHost ?? (barScrollHost = el.closest('.main') as HTMLElement | null)
  const hostTop = host ? host.getBoundingClientRect().top : 0
  barStuck.value = el.getBoundingClientRect().top <= hostTop + 1
}

/** 光标是否处在「段首输入 /xxx」的状态；是则更新菜单位置 */
function syncSlash(revealPlus = false) {
  const ed = editor.value
  if (!ed || ed.isDestroyed) return
  if (!props.editable) {
    plusDotVisible.value = false
    return
  }
  const { state } = ed
  if (!state.selection.empty) {
    plusDotVisible.value = false
    return closeSlash()
  }

  const { $from } = state.selection
  // 代码块里打 / 不应该弹菜单
  if ($from.parent.type.name === 'codeBlock') {
    plusDotVisible.value = false
    return closeSlash()
  }

  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const matched = /^\/([^\s/]*)$/.exec(before)
  if (!matched) {
    // 非斜杠输入：光标动了就把 ＋ 送到新位置并露出来（键盘换段时鼠标往往还留在老地方）
    if (!slashOpen.value) syncPlusDot(revealPlus)
    return closeSlash()
  }

  const prevQuery = slashQuery.value
  const query = matched[1]
  if (query !== prevQuery) slashIndex.value = 0

  const coords = ed.view.coordsAtPos($from.pos)
  const menuW = 260
  const menuH = 320
  slashX.value = Math.max(8, Math.min(coords.left, window.innerWidth - menuW - 8))
  // 下方放不下就翻到光标上方
  slashY.value =
    coords.bottom + menuH > window.innerHeight
      ? Math.max(8, coords.top - menuH - 6)
      : coords.bottom + 6

  slashFrom.value = $from.pos - before.length
  slashTo.value = $from.pos
  slashQuery.value = query
  menuSource.value = 'slash'
  plusDotVisible.value = false
  slashOpen.value = true
}

function closeSlash() {
  slashOpen.value = false
  slashQuery.value = ''
  slashIndex.value = 0
  submenuOf.value = ''
}

/* ---------- 行内 ＋ 按钮：只挂在「光标所在块」上 ----------
 * 规则（与飞书一致）：
 *   ＋ 的位置永远跟着光标：光标在哪一块的哪一行，＋ 就贴在那一行左侧
 *   鼠标压在这一块上（或 ＋ 本身、它的块菜单上）→ 显示
 *   鼠标跑到别的块 / 别的地方 → 160ms 后收起，块菜单一起收
 * 也就是：鼠标和光标不在一块儿时，＋ 不该出现。
 */

/** 行内 + 的块菜单是否正开着（用于让 + 保持可见、保持高亮） */
const plusMenuOpen = computed(() => slashOpen.value && menuSource.value === 'plus')

/** 鼠标是否正压在「光标所在块 / ＋ / 块菜单」上 */
const plusHovering = ref(false)

/** 光标所在块 + 光标那一行的几何范围（＋ 的可见区间）；ok=false 表示当前位置不该有 ＋ */
const plusAnchor = {
  ok: false,
  top: 0,
  bottom: 0,
  left: 0,
  lineTop: 0,
  lineBottom: 0,
  /** 上次记录的光标块 / 光标 pos，用来判断「光标是不是真的搬家了」 */
  blockStart: -1,
  caretPos: -1,
}

const PLUS_SIZE = 20
/** 收起延迟：正文和 ＋ 之间还有 6px 缝，留一点缓冲，否则手还没点上去按钮先没了 */
const PLUS_HIDE_DELAY = 160
/** 光标搬家用键盘操作时，鼠标常常还在原处；停手这么久后复核一次显隐 */
const PLUS_RECHECK_DELAY = 900

let plusHideTimer = 0
let plusRecheckTimer = 0
let plusRaf = 0
/** 最后一次鼠标位置；seen=false 表示还没动过鼠标，此时 ＋ 一律不显示 */
const plusPointer = { x: 0, y: 0, seen: false }

function hidePlusDotNow() {
  // 块菜单是从 ＋ 长出来的，按钮收掉时菜单也得跟着走，不然会留一个没有锚点的浮窗；
  // 斜杠菜单（键入 / 触发）不归这里管，保持原有关闭逻辑
  if (plusMenuOpen.value) closeSlash()
  if (plusRecheckTimer) {
    window.clearTimeout(plusRecheckTimer)
    plusRecheckTimer = 0
  }
  plusHovering.value = false
  plusDotVisible.value = false
}

function cancelPlusHide() {
  if (plusHideTimer) {
    window.clearTimeout(plusHideTimer)
    plusHideTimer = 0
  }
}

/**
 * 光标搬家会把 ＋ 直接亮出来，但鼠标可能压根不在这一行（比如用键盘挪光标、鼠标停在侧栏）。
 * 停手一会儿后复核一次：鼠标还是不在光标那一行，就收掉，别让它一直赖在屏幕上。
 */
function schedulePlusRecheck() {
  if (plusRecheckTimer) window.clearTimeout(plusRecheckTimer)
  plusRecheckTimer = window.setTimeout(() => {
    plusRecheckTimer = 0
    if (!plusPointer.seen || plusMenuOpen.value) return
    const el = document.elementFromPoint(plusPointer.x, plusPointer.y) as HTMLElement | null
    if (!pointerOnAnchorLine(plusPointer.x, plusPointer.y, el)) hidePlusDotNow()
  }, PLUS_RECHECK_DELAY)
}

function schedulePlusHide() {
  if (plusHideTimer) return
  plusHideTimer = window.setTimeout(() => {
    plusHideTimer = 0
    hidePlusDotNow()
  }, PLUS_HIDE_DELAY)
}

/** 指针是否还压在 ＋ 上（连同它和正文之间那道缝）。坐标就是 fixed 定位值，直接比，省一次布局读取 */
function nearPlusDot(x: number, y: number) {
  if (!plusDotVisible.value && !plusMenuOpen.value) return false
  return (
    x >= plusDotX.value - 8 &&
    x <= plusDotX.value + PLUS_SIZE + 10 &&
    y >= plusDotY.value - 8 &&
    y <= plusDotY.value + PLUS_SIZE + 8
  )
}

/**
 * 指针是否还压在「光标那一行」上。
 * 取行而不是取整块：长段落、嵌套列表的一整个 LI 可能横跨十几行，
 * 按块判定会出现「鼠标已经挪到别的行，＋ 还赖着不走」。
 */
function pointerOnAnchorLine(x: number, y: number, el: HTMLElement | null) {
  if (!plusAnchor.ok) return false
  if (y < plusAnchor.lineTop - 6 || y > plusAnchor.lineBottom + 6) return false
  const pm = editor.value?.view.dom
  if (pm && el && pm.contains(el)) return true
  // 正文左边缘到 ＋ 之间有 6px 缝，鼠标横移过去时不能判成「离开」
  return x >= plusAnchor.left - 40 && x <= plusAnchor.left + 2
}

/**
 * 鼠标判定：只认「光标那一行 / ＋ / 块菜单」三处，别处一律收起。
 * 位置和判定都以光标为准 —— 插进去的是光标所在块，判定的也得是同一个地方，
 * 否则会出现「看着挂在 A 行、实际插到 B 行」。
 */
function applyPlusHover(x: number, y: number) {
  const ed = editor.value
  if (!ed || ed.isDestroyed || !props.editable) {
    schedulePlusHide()
    return
  }
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const onPlusOrMenu = !!el?.closest('.plus-dot') || !!el?.closest('.slash-menu')

  // 键入「/」唤起的斜杠菜单开着时，不弹 ＋（两套菜单同时出现会让人不知道在选什么）
  if (slashOpen.value && menuSource.value === 'slash') {
    plusDotVisible.value = false
    return
  }

  if (onPlusOrMenu || nearPlusDot(x, y) || pointerOnAnchorLine(x, y, el)) {
    plusHovering.value = true
    plusDotVisible.value = true
    cancelPlusHide()
  } else {
    schedulePlusHide()
  }
}

/** 文档级 mousemove：rAF 节流，一帧最多算一次 */
function onDocMouseMove(ev: MouseEvent) {
  plusPointer.x = ev.clientX
  plusPointer.y = ev.clientY
  plusPointer.seen = true
  if (plusRaf) return
  plusRaf = requestAnimationFrame(() => {
    plusRaf = 0
    applyPlusHover(plusPointer.x, plusPointer.y)
  })
}

/** 鼠标整个离开窗口（切到别的应用、移出浏览器）时 mousemove 就断了，这里兜底收起 */
function onWindowMouseOut(ev: MouseEvent) {
  if (ev.relatedTarget) return
  if (plusMenuOpen.value) return
  hidePlusDotNow()
}

/**
 * 把 ＋ 对齐到「光标所在块的那一行」，并按需要决定是否露面。
 * @param reveal 光标搬家后调用：把 ＋ 直接送到新位置并显示出来（否则要等鼠标自己挪过去，
 *               键盘移动光标时鼠标还在老地方，按钮永远不会跟过去）。滚动/缩放只摆位置，不改显隐。
 */
function syncPlusDot(reveal = false) {
  const ed = editor.value
  if (!ed || ed.isDestroyed || !props.editable) {
    plusAnchor.ok = false
    hidePlusDotNow()
    return
  }
  const { state } = ed
  const { $from } = state.selection
  // 有选区 / 在代码块里 / 光标不在任何顶层块内（比如选中了一张图）→ 不给 ＋
  if (!state.selection.empty || $from.depth < 1 || $from.parent.type.name === 'codeBlock') {
    plusAnchor.ok = false
    hidePlusDotNow()
    return
  }
  const start = $from.before(1)
  const node = state.doc.nodeAt(start)
  const dom = node ? ed.view.nodeDOM(start) : null
  const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
  if (!node || !rect || rect.height === 0) {
    plusAnchor.ok = false
    hidePlusDotNow()
    return
  }
  // 光标那一块已经滚出视口，没必要还挂在屏幕边缘
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    plusAnchor.ok = false
    hidePlusDotNow()
    return
  }
  const block = ed.view.coordsAtPos(start)
  // 贴着正文内容左边缘往左挪一格（26px = 按钮 20 + 缝 6）；图块这类 coordsAtPos
  // 给不出横坐标的，退到 DOM 盒子上取，否则按钮会被算到屏幕外、看起来像「没出现」
  const left = block && block.left > 0 ? block.left : rect.left

  let dotTop: number
  let lineTop: number
  let lineBottom: number
  // 关键：能不能按「行」对齐，看的是**光标所在的那个文本块**，不是顶层块。
  // 列表里 before(1) 拿到的是整个 bulletList、引用块里拿到的是 blockquote，
  // 这两者都不是文本块；按「顶层块不是文本块 → 贴它顶边」处理，
  // 就会把 ＋ 顶到列表第一行 / 引用首行去（用户实测到的就是这个）。
  const caretBlock = $from.parent
  if (caretBlock.isTextblock) {
    // 光标所在那一行：行高一般 24~30，按钮 20
    const line = ed.view.coordsAtPos($from.pos)
    if (line && line.bottom > line.top) {
      lineTop = line.top
      lineBottom = line.bottom
      dotTop = line.top + Math.max(0, (line.bottom - line.top - PLUS_SIZE) / 2)
    } else {
      lineTop = rect.top
      lineBottom = rect.bottom
      dotTop = rect.top
    }
  } else {
    // 图块 / 图片 / 表格 / 分割线没有「行」的概念：贴它可见内容的顶边，
    // 否则会停在 node view 外框的 padding 里，看着像挂在上一块旁边
    const inner = dom instanceof HTMLElement ? dom.firstElementChild : null
    const innerRect = inner instanceof HTMLElement ? inner.getBoundingClientRect() : null
    dotTop = innerRect && innerRect.height > 0 ? innerRect.top : rect.top
    lineTop = rect.top
    lineBottom = rect.bottom
  }
  dotTop = Math.min(Math.max(dotTop, rect.top), rect.bottom - PLUS_SIZE)

  plusAnchor.ok = true
  plusAnchor.top = rect.top
  plusAnchor.bottom = rect.bottom
  plusAnchor.left = left
  plusAnchor.lineTop = lineTop
  plusAnchor.lineBottom = lineBottom
  // 插入位置：顶层块末尾。列表里也按「整个列表之后」算 —— 往列表内部插（li 内、
  // 或新建 li）会让后续命令在越界选区上做 nodesBetween，抛 RangeError，实测不可靠。
  plusBlockTo.value = start + node.nodeSize
  plusDotX.value = Math.round(left - 26)
  plusDotY.value = Math.round(dotTop)

  // 光标真的换位置了吗？（协作者在别处打字也会触发 selectionUpdate，
  // 那种情况不该把 ＋ 从用户眼前重新弹出来）
  const moved = start !== plusAnchor.blockStart || $from.pos !== plusAnchor.caretPos
  plusAnchor.blockStart = start
  plusAnchor.caretPos = $from.pos

  if (reveal && moved) {
    // 光标搬到哪儿，＋ 就跟到哪儿（键盘上下左右、点击、Tab 都算）。
    // 鼠标还停在老段落也没关系：下一次 mousemove 会把它收掉，停手 900ms 也会复核一次。
    plusHovering.value = true
    plusDotVisible.value = true
    cancelPlusHide()
    schedulePlusRecheck()
  }
  // 其它情况（滚动、缩放、位置没变）只重排位置，不动显隐：
  // 光标换行时浏览器常会自动滚动一下，这里若按鼠标位置重判，刚露面的 ＋ 会立刻被收掉。
}

/** 点击/悬停行内 + 按钮：打开块菜单（复用斜杠菜单渲染，但插入语义为「块后插入」） */
function openPlusMenu() {
  const ed = editor.value
  if (!ed) return
  // 已经开着就不要再重算位置——鼠标从菜单挪回 + 上时 mouseenter 会再触发一次，
  // 重复计算会让菜单轻微跳动
  if (plusMenuOpen.value) return
  menuSource.value = 'plus'
  slashQuery.value = ''
  submenuOf.value = ''
  slashIndex.value = 0
  // 菜单从 ＋ 的右侧长出来：按按钮的实际位置算，别按「块起点」——
  // 列表 / 引用里块起点是第一行，菜单会跑到离光标很远的地方
  const menuW = 280
  const menuH = 360
  const anchorX = plusDotX.value + PLUS_SIZE + 8
  const anchorY = plusDotY.value
  slashX.value = Math.max(8, Math.min(anchorX, window.innerWidth - menuW - 8))
  slashY.value =
    anchorY + menuH > window.innerHeight ? Math.max(8, anchorY - menuH + PLUS_SIZE) : anchorY
  slashOpen.value = true
  // 注意：这里不要隐藏 + 按钮。菜单是从它身上长出来的，按钮一消失，
  // 用户会以为操作已结束，也失去「再点一次收起」的锚点。
  plusHovering.value = true
  plusDotVisible.value = true
  cancelPlusHide()
}

/** 键盘导航用的扁平项列表：展开子菜单时用子项，否则用过滤结果扁平化 */
const flatItems = computed<SlashItem[]>(() => {
  if (submenuOf.value) return activeChildren.value
  return filtered.value.flatMap((g) => g.items)
})

/** 当前高亮项的 key（根态用，用于跨分组定位高亮） */
const currentFlatKey = computed(() => flatItems.value[slashIndex.value]?.key ?? '')

/** 根态下按 key 反查扁平索引（供 mouseenter 同步高亮） */
function flatIndexOf(item: SlashItem) {
  return flatItems.value.findIndex((x) => x.key === item.key)
}

function applySlash(item: SlashItem) {
  const ed = editor.value
  if (!ed) return
  const source = menuSource.value
  const from = source === 'plus' ? plusBlockTo.value : slashFrom.value
  const to = source === 'plus' ? plusBlockTo.value : slashTo.value
  closeSlash()
  // 图片要现填地址，不能像别的块那样直接 run
  if (item.key === 'image') {
    insertImageByUrl(source, from, to)
    return
  }
  if (source === 'plus') {
    // 行内 + 触发：在当前块之后插入新块（列表里插到列表之后，正文里插在当前段之后）
    const chain = ed
      .chain()
      .focus()
      .insertContentAt(from, { type: 'paragraph' })
      // 插入后把光标放进新块。Tiptap 自带的 selectionToInsertionEnd 在「列表末尾」这种位置
      // 会把选区末端算到文档之外，后续命令（比如「正文」的 setParagraph）再拿这个选区
      // 做 nodesBetween 就会抛 RangeError: Position xx out of range，表现成点了没反应。
      .command(({ tr }) => {
        const size = tr.doc.content.size
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(Math.max(1, from + 1), size)), 1))
        return true
      })
    try {
      // 「正文」这一项本身就是 setParagraph；插入的已经是空段落，再转一次在列表末尾
      // 会把选区末端算到文档之外（RangeError: Position xx out of range），结果也一样，直接跳过。
      if (item.key === 'text') chain.run()
      else item.run(chain).run()
    } catch (err) {
      console.error('[plus] insert failed', (err as Error)?.stack || err, { from })
    }
  } else {
    // 斜杠触发：先删掉输入的 "/xxx"，再执行块转换
    item.run(ed.chain().focus().deleteRange({ from, to })).run()
  }
}

/**
 * 插入图片。
 * 目前没有上传接口，所以走「填地址」：既支持外链，也支持站内路径
 * （存档文章那 1892 张图就由 nginx 静态托管在 /scofendoc/files/archive/ 下）。
 */
function insertImageByUrl(source: 'plus' | 'slash', from: number, to: number) {
  const ed = editor.value
  if (!ed) return
  const input = window.prompt('图片地址（https://… 或 /scofendoc/files/…）', '')
  if (!input) return
  const src = input.trim()
  if (!src) return
  try {
    const chain = ed.chain().focus()
    if (source === 'slash') chain.deleteRange({ from, to })
    chain.insertContentAt(from, { type: 'image', attrs: { src } }).run()
  } catch (err) {
    console.error('[image] insert failed', (err as Error)?.stack || err, { from })
  }
}

function openSubmenu(item: SlashItem) {
  if (item.children?.length) {
    submenuOf.value = item.key
    slashIndex.value = 0
  } else {
    applySlash(item)
  }
}

function backToRoot() {
  submenuOf.value = ''
  slashIndex.value = 0
}

function moveSlash(delta: number) {
  const n = flatItems.value.length
  if (n === 0) return
  slashIndex.value = (slashIndex.value + delta + n) % n
}

/* ---------------- 编辑器 ---------------- */

onMounted(() => {
  provider = new HocuspocusProvider({
    url: props.wsUrl,
    name: props.docName,
    document: ydoc,
    token: props.collabToken,
    onStatus: ({ status }) => {
      connected.value = status === 'connected'
    },
    onAuthenticationFailed: () => {
      authError.value = '协同鉴权失败，请刷新页面重新登录'
      connected.value = false
    },
    onAwarenessChange: ({ states }) => {
      // states 包含本地 + 远端，减去自己即为在线协作者数
      peers.value = Math.max(0, states.length - 1)
    },
  })

  editor.value = new Editor({
    extensions: [
      // 使用 Yjs 协同时必须关闭 Tiptap 自带 history（冲突解决交给 CRDT）
      // codeBlock 交给下面的 DiagramCodeBlock：节点名不变，只换渲染层，
      // 这样粘贴进来的 flowchart / sequenceDiagram 代码块能直接出图
      // listItem 换成允许标题的版本：H1 与有序/无序列表可以同时存在
      StarterKit.configure({ history: false, codeBlock: false, listItem: false }),
      ListItemHeading,
      DiagramCodeBlock,
      TaskList,
      TaskItem.configure({ nested: true }),
      // 表格：履历、方案这类文档大量用表格承载对照关系，没有表格节点就只能退化成纯文本
      Table.configure({ resizable: false, lastColumnResizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      // 链接：文档之间互相引用（总索引→各篇、各篇→相关篇）全靠这层 mark；
      // openOnClick 关掉，点击行为由下面的 onContentClick 接管（站内跳转不整页刷新）
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      // 选中文字后的浮动工具条要用到下划线 / 文字颜色（Color 依赖 TextStyle）
      Underline,
      TextStyle,
      Color,
      // 批注锚点：正文只留 id，评论正文在 ydoc 的 comments Map 里
      CommentMark,
      // 图片：存档文章导入、以及正文里贴图都需要。inline:false 让它独占一段，
      // 否则图片会混进行内文本，markdown 导入时层级很容易乱。
      Image.configure({ inline: false, allowBase64: false }),
      MermaidBlock,
      PlantUMLBlock,
      HeadingFold,
      // 标题自动编号：标题块仍属 heading，只是多了 numbered 属性和派生序号
      HeadingNumber,
      UndoRedoShortcuts,
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: { name: props.userName, color: props.userColor },
      }),
      // 放最后：列表缩进、表格跳格、斜杠菜单确认都优先，只有剩下的普通文本块才轮到「空两格」
      TabIndent,
    ],
    content: '',
    editable: props.editable,
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (!slashOpen.value) return false
        if (event.key === 'Escape') {
          closeSlash()
          return true
        }
        if (event.key === 'ArrowDown') {
          moveSlash(1)
          return true
        }
        if (event.key === 'ArrowUp') {
          moveSlash(-1)
          return true
        }
        if (event.key === 'ArrowLeft') {
          if (submenuOf.value) {
            backToRoot()
            return true
          }
          return false
        }
        if (event.key === 'ArrowRight') {
          const item = flatItems.value[slashIndex.value]
          if (item?.children?.length) {
            openSubmenu(item)
            return true
          }
          return false
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = flatItems.value[slashIndex.value]
          if (item) {
            if (item.children?.length) openSubmenu(item)
            else applySlash(item)
          }
          return true
        }
        return false
      },
    },
    onUpdate: () => syncSlash(false),
    // 光标搬家（点击 / 方向键 / Tab）→ 把 ＋ 送到新段落；顺带把文字颜色记忆接上
    onSelectionUpdate: () => {
      syncSlash(true)
      scheduleColorMemory()
    },
    onBlur: closeSlash,
  })

  emit('editor-ready', editor.value)

  // 顶部格式栏的按钮状态（含「光标是否在表格里」）跟着每次 transaction 重算
  editor.value.on('transaction', () => {
    barTick.value++
  })

  document.addEventListener('scroll', onAnyScroll, true)
  document.addEventListener('mousedown', onGlobalDown, true)
  document.addEventListener('keydown', onGlobalKey)

  // 顶部格式栏吸顶：正文滚动容器是 .main，贴上边缘时给它加投影
  barScrollHost = (barEl.value?.closest('.main') as HTMLElement | null) ?? null
  barScrollHost?.addEventListener('scroll', updateBarStuck, { passive: true })
  window.addEventListener('resize', updateBarStuck)
  updateBarStuck()

  // ＋ 按钮的显隐跟着鼠标走（飞书式），用文档级监听，因为按钮本体在编辑器 DOM 之外
  document.addEventListener('mousemove', onDocMouseMove, { passive: true })
  document.addEventListener('mousedown', onDocMouseMove, { passive: true })
  window.addEventListener('mouseout', onWindowMouseOut)

  // 编辑器就绪后先量一次位置（此时按钮还是隐藏的，等鼠标过来才露面）
  setTimeout(() => syncPlusDot(), 300)
})

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onAnyScroll, true)
  barScrollHost?.removeEventListener('scroll', updateBarStuck)
  window.removeEventListener('resize', updateBarStuck)
  document.removeEventListener('mousemove', onDocMouseMove)
  document.removeEventListener('mousedown', onDocMouseMove)
  document.removeEventListener('mousedown', onGlobalDown, true)
  document.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('mouseout', onWindowMouseOut)
  cancelPlusHide()
  if (plusRecheckTimer) window.clearTimeout(plusRecheckTimer)
  if (plusRaf) cancelAnimationFrame(plusRaf)
  provider?.destroy()
  editor.value?.destroy()
})

/** 权限可能在会话中途变化（比如被管理员降为仅查看），这里跟着切 */
watch(
  () => props.editable,
  (v) => {
    editor.value?.setEditable(v)
    if (!v) closeSlash()
  },
)

function onAnyScroll(e: Event) {
  // 滚动时：若斜杠菜单开着则关闭（菜单自身滚动除外），并刷新 + 按钮位置
  if (slashOpen.value) {
    const el = e.target as HTMLElement | null
    if (el && el.classList && el.classList.contains('slash-list')) return
    closeSlash()
  }
  syncPlusDot()
}

/**
 * 正文里的链接点击。
 *
 * 站内链接的 href 是 `?space=2&doc=20`（可能带 `&h=锚点文字`）这种形式——
 * 由 Markdown 导入时按文档清单改写而来，不写死域名，换域名/换机器都不用重发。
 * 点它不应该整页刷新：解析出 docId 交给外层 selectDoc（SPA 内切文档）。
 *
 * 外链（http/https）保持默认行为：新标签打开，编辑器本身不跳走。
 */
function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null

  // 点批注高亮 → 打开这条评论（正在拖选文字时不弹，避免选到一半被打断）
  const cmt = target?.closest?.('mark[data-comment-id]') as HTMLElement | null
  if (cmt && window.getSelection()?.isCollapsed) {
    const id = cmt.getAttribute('data-comment-id') || ''
    if (id) {
      e.preventDefault()
      toolbarRef.value?.openThread(id, cmt)
      return
    }
  }

  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  // 编辑态下按住修饰键点链接是「放光标进链接」，不拦截
  if (props.editable && (e.metaKey || e.ctrlKey)) return

  const href = anchor.getAttribute('href') || ''
  if (!href) return

  // 纯站内锚点（老数据里可能残留 #xxx）：在当前文档内滚动
  if (href.startsWith('#')) {
    e.preventDefault()
    emit('navigate', {
      spaceId: props.spaceId,
      docId: 0,
      anchor: decodeURIComponent(href.slice(1)),
    })
    return
  }

  let url: URL
  try {
    url = new URL(href, location.href)
  } catch {
    return
  }

  const docId = Number(url.searchParams.get('doc'))
  const isInternal = docId > 0 && url.origin === location.origin
  if (isInternal) {
    e.preventDefault()
    emit('navigate', {
      spaceId: Number(url.searchParams.get('space')) || props.spaceId,
      docId,
      anchor: url.searchParams.get('h') || '',
    })
    return
  }

  if (/^https?:/i.test(href)) {
    // 浏览器不会在 contenteditable 里激活 <a> 的默认跳转（点了什么都不发生），
    // 而 Link 扩展又配了 openOnClick:false 不帮忙，所以这里必须自己开。
    // 只改 target 是没用的 —— 没有默认动作可改。
    e.preventDefault()
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}
</script>

<template>
  <div class="collab">
    <div ref="barEl" :class="['bar', { stuck: barStuck }]">
      <span :class="['dot', connected ? 'on' : 'off']" />
      <span class="status">
        <template v-if="authError">{{ authError }}</template>
        <template v-else>
          {{ connected ? '已连接协同' : '连接中…' }}
          <template v-if="connected && peers > 0">· 在线协作者 {{ peers }} 人</template>
        </template>
      </span>

      <template v-if="editable">
        <span class="bar-sep" />

        <button :class="{ active: barState.bold }" title="加粗" @click="editor?.chain().focus().toggleBold().run()">
          <b>B</b>
        </button>
        <button :class="{ active: barState.italic }" title="斜体" @click="editor?.chain().focus().toggleItalic().run()">
          <i>I</i>
        </button>
        <button :class="{ active: barState.strike }" title="删除线" @click="editor?.chain().focus().toggleStrike().run()">
          <s>S</s>
        </button>
        <button :class="{ active: barState.underline }" title="下划线" @click="editor?.chain().focus().toggleUnderline().run()">
          <u>U</u>
        </button>
        <button :class="{ active: barState.code }" title="行内代码" @click="editor?.chain().focus().toggleCode().run()">
          &lt;/&gt;
        </button>

        <span class="bar-sep" />

        <button :class="{ active: barState.h1 }" @click="applyBarHeading(1)">H1</button>
        <button :class="{ active: barState.h2 }" @click="applyBarHeading(2)">H2</button>

        <!-- 标题前缀：有序 1 / 1.1 与无序 ● ○ ■ 两种样式，▾ 里可全文切换 -->
        <div class="num-dd">
          <button
            :class="['num-main', { active: barState.numbered }]"
            title="标题前缀：当前标题开关（有序 1 / 1.1 或无序 ● ○ ■）；列表项里会就地升为 H1 并留在列表中"
            @mousedown.prevent
            @click="toggleCurrentNumber"
          >№</button>
          <button class="num-caret" title="标题前缀样式" @mousedown.prevent @click="numMenuOpen = !numMenuOpen">▾</button>
          <div v-if="numMenuOpen" class="num-dd-menu">
            <span class="num-dd-group">当前标题</span>
            <button
              :class="{ on: barState.numbered && barState.numberStyle === 'ordered' }"
              @mousedown.prevent
              @click="setCurrentNumberStyle('ordered')"
            >有序编号 1 / 1.1</button>
            <button
              :class="{ on: barState.numbered && barState.numberStyle === 'unordered' }"
              @mousedown.prevent
              @click="setCurrentNumberStyle('unordered')"
            >无序符号 ● ○ ■</button>
            <span class="num-dd-sep" />
            <span class="num-dd-group">全文标题</span>
            <button @mousedown.prevent @click="setAllNumbered(true, 'ordered')">全文设为有序编号</button>
            <button @mousedown.prevent @click="setAllNumbered(true, 'unordered')">全文设为无序符号</button>
            <button @mousedown.prevent @click="setAllNumbered(false)">全文关闭前缀</button>
            <span class="num-dd-tip">H1–H6 共 6 级；数字与符号统一蓝色</span>
          </div>
        </div>

        <button :class="{ active: barState.bullet }" title="无序列表" @click="editor?.chain().focus().toggleBulletList().run()">•</button>
        <button :class="{ active: barState.ordered }" title="有序列表" @click="editor?.chain().focus().toggleOrderedList().run()">1.</button>
        <button :class="{ active: barState.task }" title="待办清单" @click="editor?.chain().focus().toggleTaskList().run()">☑</button>
        <button :class="{ active: barState.quote }" title="引用" @click="editor?.chain().focus().toggleBlockquote().run()">❝</button>

        <!-- 光标在表格里才出现的快捷操作；完整行列操作见表格上方的浮动条 / 右键菜单 -->
        <template v-if="barState.table">
          <span class="bar-sep" />
          <button title="在上方插入一行" @mousedown.prevent @click="editor?.chain().focus().addRowBefore().run()">↑行</button>
          <button title="在下方插入一行" @mousedown.prevent @click="editor?.chain().focus().addRowAfter().run()">↓行</button>
          <button title="在左侧插入一列" @mousedown.prevent @click="editor?.chain().focus().addColumnBefore().run()">←列</button>
          <button title="在右侧插入一列" @mousedown.prevent @click="editor?.chain().focus().addColumnAfter().run()">列→</button>
          <button title="删除当前行" @mousedown.prevent @click="editor?.chain().focus().deleteRow().run()">删行</button>
          <button title="删除当前列" @mousedown.prevent @click="editor?.chain().focus().deleteColumn().run()">删列</button>
          <button title="删除整个表格" @mousedown.prevent @click="editor?.chain().focus().deleteTable().run()">删表</button>
        </template>

        <span class="bar-sep" />

        <button title="撤销" @click="editor?.chain().focus().undo().run()">↶</button>
        <button title="重做" @click="editor?.chain().focus().redo().run()">↷</button>

        <span class="slash-tip">输入 / 插入区块</span>
      </template>

      <!-- 只读态：不显示格式按钮，明确告诉用户为什么改不了 -->
      <span v-else class="readonly-badge">👁 仅查看 · 你没有编辑权限</span>
    </div>

    <EditorContent :editor="editor" class="content" @click="onContentClick" />

    <!-- 选中文字后的浮动格式条（标题/列表/加粗/删除线/斜体/下划线/链接/代码/颜色/评论） -->
    <SelectionToolbar
      v-if="editor"
      ref="toolbarRef"
      :editor="editor"
      :ydoc="ydoc"
      :editable="editable"
      :user-name="userName"
      :user-color="userColor"
    />

    <!-- 光标进表格才出现：上方浮动条 + 单元格右键菜单（行列增删改、合并拆分、删表） -->
    <TableTools v-if="editor" :editor="editor" :editable="editable" />

    <!-- 斜杠菜单：position: fixed，坐标直接来自 coordsAtPos -->
    <div
      v-if="slashOpen"
      class="slash-menu"
      :style="{ left: slashX + 'px', top: slashY + 'px' }"
      @mousedown.prevent
    >
      <div class="slash-head">
        <template v-if="submenuOf">
          <button class="slash-back" @click="backToRoot">‹ 返回</button>
          <span>选择规格</span>
        </template>
        <template v-else>
          插入区块
          <em v-if="slashQuery">「{{ slashQuery }}」</em>
        </template>
      </div>

      <!-- 子菜单态：列出父项的所有子项 -->
      <div v-if="submenuOf" class="slash-list">
        <button
          v-for="(item, i) in activeChildren"
          :key="item.key"
          :class="['slash-item', { on: i === slashIndex }]"
          @click="applySlash(item)"
          @mouseenter="slashIndex = i"
        >
          <span class="slash-icon" :style="item.color ? { background: item.color, borderColor: item.color, color: '#fff' } : {}">{{ item.icon }}</span>
          <span class="slash-text">
            <b>{{ item.label }}</b>
            <i>{{ item.hint }}</i>
          </span>
        </button>
      </div>

      <!-- 根态：分组展示，支持有子菜单的项 -->
      <div v-else class="slash-list">
        <template v-for="group in filtered" :key="group.name">
          <div class="slash-group-name">{{ group.name }}</div>
          <button
            v-for="item in group.items"
            :key="item.key"
            :class="['slash-item', { on: item.key === currentFlatKey }]"
            @click="openSubmenu(item)"
            @mouseenter="slashIndex = flatIndexOf(item)"
          >
            <span class="slash-icon" :style="item.color ? { background: item.color, borderColor: item.color, color: '#fff' } : {}">{{ item.icon }}</span>
            <span class="slash-text">
              <b>{{ item.label }}</b>
              <i>{{ item.hint }}</i>
            </span>
            <span v-if="item.children?.length" class="slash-sub">›</span>
          </button>
        </template>
        <div v-if="filtered.length === 0" class="slash-empty">没有匹配的区块</div>
      </div>

      <div class="slash-foot">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
    </div>

    <!-- 行内 + 按钮：光标所在块左侧，悬停弹出块菜单；菜单开着时按钮保留（高亮成「已展开」态） -->
    <button
      v-if="editable && (plusDotVisible || plusMenuOpen)"
      :class="['plus-dot', { on: plusMenuOpen }]"
      :style="{ left: plusDotX + 'px', top: plusDotY + 'px' }"
      :title="plusMenuOpen ? '收起区块菜单' : '插入区块'"
      :aria-expanded="plusMenuOpen ? 'true' : 'false'"
      @mousedown.prevent
      @mouseenter="openPlusMenu"
      @click="openPlusMenu"
    >
      ＋
    </button>
  </div>
</template>

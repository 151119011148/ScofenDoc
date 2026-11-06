<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type * as Y from 'yjs'
import { getLastColor, setLastColor } from '../colorMemory'
import { getLastHeading, headingName, headingShort, setLastHeading } from '../headingMemory'
import {
  ALIGN_OPTIONS,
  FONT_SIZE_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  type ParagraphStyleAttrs,
} from '../extensions/ParagraphStyle'

/**
 * 选中文字后的浮动格式条（对标飞书/Notion 的 bubble toolbar）。
 *
 * 为什么不用 @tiptap/extension-bubble-menu：
 * 它依赖 tippy 定位，选中多行、靠近视口顶部、正文里嵌了表格/图块时位置会飘；
 * 而且下拉面板需要和工具条长在一起，tippy 的层级不好控。这里直接读
 * selection 的 Range rect，自己 fixed 定位，行为完全可预测（见 tools/verify-browser/bubble-check.mjs）。
 *
 * 评论数据落在 ydoc.getMap('comments')：
 * 正文只留 mark[data-comment-id] 作为锚点，评论正文/回复/已解决状态都在 Map 里，
 * 随协同服务一起增量同步并落进 .bin，不需要后端建表。
 */

interface CommentReply {
  id: string
  author: string
  color: string
  body: string
  at: number
}

interface CommentThread {
  id: string
  author: string
  color: string
  body: string
  at: number
  resolved: boolean
  /** 创建时选中的原文摘录，正文改动后仍能知道评论针对的是哪段 */
  quote: string
  replies: CommentReply[]
}

const props = withDefaults(
  defineProps<{
    editor?: Editor
    /** 与正文同一个 Y.Doc，评论 Map 挂在它上面 */
    ydoc?: Y.Doc
    editable?: boolean
    userName?: string
    userColor?: string
  }>(),
  {
    editor: undefined,
    ydoc: undefined,
    editable: true,
    userName: '匿名',
    userColor: '#3370ff',
  },
)

/* ---------------- 显隐与定位 ---------------- */

const barVisible = ref(false)
const barPos = ref({ left: 0, top: 0 })
const rootEl = ref<HTMLElement | null>(null)
const barEl = ref<HTMLElement | null>(null)
const barW = ref(340)
const barH = ref(40)

/** 当前展开的下拉/输入面板 */
const panel = ref<'' | 'heading' | 'list' | 'color' | 'link' | 'more' | 'comment' | 'paragraph'>('')

const linkUrl = ref('')
const linkInput = ref<HTMLInputElement | null>(null)
const commentDraft = ref('')
const commentInput = ref<HTMLTextAreaElement | null>(null)

/** 字体颜色色板（飞书式色块；「恢复默认」单独放底部） */
const COLOR_SWATCHES = [
  { name: '红', value: '#f54a45' },
  { name: '橙', value: '#ff8800' },
  { name: '黄', value: '#f5c400' },
  { name: '绿', value: '#34c759' },
  { name: '蓝', value: '#3370ff' },
  { name: '紫', value: '#7b61ff' },
  { name: '洋红', value: '#eb2f96' },
  { name: '灰', value: '#8f959e' },
]

/* 最近一次用过的颜色见下方「状态」区块：它挂在同一份 tick 上，
 * 编辑器写入记忆色后横线会自动跟着变，不会出现「横线是蓝的、点下去却是红的」。 */

/** 工具栏/面板内按下鼠标不能抢走正文选区，否则点一下就丢选 */
function keepSelection(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
}

/** 面板里的输入框需要真正拿到焦点，只阻止冒泡 */
function keepFocus(e: MouseEvent) {
  e.stopPropagation()
}

function hideBar() {
  barVisible.value = false
}

/* ---------------- 出现时机：等选区收口 ---------------- */

/**
 * 拖选（按下 → 拖动 → 松开）过程中不弹工具条。
 * 原因：selectionUpdate 在拖动途中会连续触发，每触发一次就重算一次位置，
 * 工具条会跟着鼠标在行间上下跳，还正好盖住正在选的那几行 —— 飞书是松手之后才出现。
 *
 * 键盘选择（Shift+方向键、⌘A）没有「松手」事件，用一小段停顿（KEY_SETTLE）收口；
 * 连续敲方向键时不断把计时器往后推，停下来才弹。
 */
const KEY_SETTLE = 120

/** 鼠标/手指是否正按在正文里（正在拖选） */
let pointerDown = false
let settleTimer = 0

function clearSettle() {
  if (settleTimer) {
    window.clearTimeout(settleTimer)
    settleTimer = 0
  }
}

function revealAfter(delay: number) {
  clearSettle()
  settleTimer = window.setTimeout(() => {
    settleTimer = 0
    updatePosition()
  }, delay)
}

function editorDom(): HTMLElement | null {
  const e = props.editor
  if (!e || e.isDestroyed) return null
  return (e.view.dom as HTMLElement) ?? null
}

function onPointerDown(ev: PointerEvent) {
  const t = ev.target as HTMLElement | null
  if (!t?.closest) return
  // 工具条 / 批注弹层里的点击不是「开始选正文」
  if (t.closest('.sel-wrap') || t.closest('.cmt-pop')) return
  const dom = editorDom()
  if (!dom || !dom.contains(t)) return
  pointerDown = true
  clearSettle()
  // 上一轮的工具条先撤掉：拖选途中它会横在选区的行上跟着一起跳
  hideBar()
}

function onPointerUp() {
  if (!pointerDown) return
  pointerDown = false
  clearSettle()
  // 等一帧，让浏览器把最终选区落定后再量 rect
  requestAnimationFrame(() => {
    if (!pointerDown) updatePosition()
  })
}

/** 松手发生在窗口外（拖到侧栏、切到别的应用）时收个尾，避免 pointerDown 卡在 true 再也不弹 */
function resetPointer() {
  pointerDown = false
  clearSettle()
}

function selectionRect(): { left: number; top: number; bottom: number; width: number; height: number } | null {
  const sel = window.getSelection()
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const range = sel.getRangeAt(0)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
    // 跨多行时 getBoundingClientRect() 是所有行的联合包围盒，工具条会被顶到选区
    // 最上方、离真正收尾的光标很远 —— 这正是「选中多行后工具条像没弹」的原因。
    // 改成锚在光标所在行：无论从上往下选还是从下往上选，都跟着鼠标那一头。
    if (rects.length > 1) {
      try {
        const caret = document.createRange()
        caret.setStart(sel.focusNode!, sel.focusOffset)
        caret.collapse(true)
        const r = caret.getBoundingClientRect()
        if (r.left || r.top) {
          return {
            left: r.left,
            top: r.top,
            bottom: r.bottom || r.top + 16,
            width: 1,
            height: Math.max(r.bottom - r.top, 16),
          }
        }
      } catch {
        // focusNode 是元素节点、offset 越界时退回最后一行
      }
      const last = rects[rects.length - 1]
      return { left: last.left, top: last.top, bottom: last.bottom, width: last.width, height: last.height }
    }
    const r = range.getBoundingClientRect()
    if (r.width || r.height) {
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
  }
  const e = props.editor
  if (!e) return null
  try {
    const a = e.view.coordsAtPos(e.state.selection.from)
    const b = e.view.coordsAtPos(e.state.selection.to)
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      bottom: Math.max(a.bottom, b.bottom),
      width: Math.abs(b.left - a.left) || 1,
      height: Math.abs(b.bottom - a.top) || 16,
    }
  } catch {
    return null
  }
}

let rafId = 0
function schedule() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    updatePosition()
  })
}

function updatePosition() {
  const e = props.editor
  if (!e || e.isDestroyed || !props.editable) return hideBar()
  // 还在拖选（手指/鼠标没松）：一律不弹，等 pointerup 再来一次
  if (pointerDown) return hideBar()
  // 评论弹层打开时，工具条让位，不跟着重新计算
  if (threadId.value) return
  // 只服务文字选区。CellSelection（跨表格单元格）与 NodeSelection（整图/整表）
  // 不是 TextSelection 的子类，一起挡掉：否则文字浮条会盖住 TableTools 的
  // 单元格操作条，而且这里的加粗/上色按钮对它们点了也没有意义。
  if (!(e.state.selection instanceof TextSelection)) return hideBar()
  if (e.state.selection.empty && !panel.value) return hideBar()

  // 焦点已经落到面板输入框里，DOM 选区不在正文，别乱动
  const active = document.activeElement as HTMLElement | null
  if (active && rootEl.value?.contains(active)) return

  const rect = selectionRect()
  if (!rect) return hideBar()
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (rect.bottom < 0 || rect.top > vh) return hideBar()

  const w = barW.value || 340
  const h = barH.value || 40
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, vw - w - 8))

  // 上方空间够就放上面（飞书的习惯），不够就翻到选区下方
  const above = rect.top > 96
  let top = above ? rect.top - h - 10 : rect.bottom + 10
  top = Math.max(8, Math.min(top, vh - h - 8))

  barPos.value = { left, top }
  barVisible.value = true

  // 首帧量不到真实宽高，渲染后按实际尺寸再校正一次
  nextTick(() => {
    const el = barEl.value
    if (!el) return
    const w2 = el.offsetWidth
    const h2 = el.offsetHeight
    if (!w2) return
    barW.value = w2
    barH.value = h2
    const left2 = Math.max(8, Math.min(rect.left + rect.width / 2 - w2 / 2, vw - w2 - 8))
    const top2 = above ? rect.top - h2 - 10 : rect.bottom + 10
    barPos.value = { left: left2, top: Math.max(8, Math.min(top2, vh - h2 - 8)) }
  })
}

function onDocScroll() {
  if (threadId.value) {
    placeThread()
    return
  }
  if (panel.value) {
    schedule()
    return
  }
  hideBar()
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (threadId.value) return closeThread()
  if (panel.value) {
    panel.value = ''
    return
  }
  if (barVisible.value) hideBar()
}

/* ---------------- 状态（isActive 不是响应式的，靠 tick 驱动重算） ---------------- */

const tick = ref(0)

/**
 * 上次用过的颜色（＝飞书 A 按钮下面那根横线的颜色）。
 *
 * 用 computed 而不是 ref：颜色不只由本组件写入，编辑器在「光标落进有色文字」
 * 时也会更新记忆色（applyColorMemory）。挂在 tick 上就能跟着每次 transaction
 * 自动刷新，横线、色板角标、A 的一键上色永远指向同一个颜色。
 */
const recentColor = computed(() => (void tick.value, getLastColor()))
const recentColorName = computed(
  () => COLOR_SWATCHES.find((c) => c.value === recentColor.value)?.name ?? '自定义',
)

const headingLabel = computed(() => {
  void tick.value
  const e = props.editor
  if (!e) return 'T'
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    if (e.isActive('heading', { level })) return `H${level}`
  }
  return 'T'
})

/**
 * 上次用过的标题级别（＝工具条标题按钮主键会刷成的级别）。
 *
 * 和 recentColor 一样挂在 tick 上：面板里点一次、顶部格式栏按一下，都会刷新，
 * 主键的标签与高亮始终跟着「这一下点了会变成什么」走。
 */
const recentHeading = computed(() => (void tick.value, getLastHeading()))
/** 主键上显示的文字：有记忆时显示「将要刷成」的级别，没记忆时退回当前级别 */
const headingTarget = computed(() =>
  recentHeading.value === null ? headingLabel.value : headingShort(recentHeading.value),
)
/** 选区当前已经是记忆级别（点了也不会有变化，用高亮点出来） */
const headingApplied = computed(() => {
  const level = recentHeading.value
  if (level === null) return false
  return headingLabel.value === headingShort(level)
})
const headingTip = computed(() => {
  const level = recentHeading.value
  if (level === null) return '标题（首次请先选一个级别）'
  if (headingApplied.value) return `当前已是${headingName(level)}，点 ▾ 换级别`
  return `单击套用上次的${headingName(level)}（点 ▾ 换级别）`
})
/** 当前标题的前缀样式：'' 表示没开编号 */
const headingNumberStyle = computed(() => {
  void tick.value
  const e = props.editor
  if (!e || !e.isActive('heading', { numbered: true })) return ''
  return (e.getAttributes('heading').numberStyle as string) || 'ordered'
})
const isBold = computed(() => (void tick.value, !!props.editor?.isActive('bold')))
const isItalic = computed(() => (void tick.value, !!props.editor?.isActive('italic')))
const isStrike = computed(() => (void tick.value, !!props.editor?.isActive('strike')))
const isUnderline = computed(() => (void tick.value, !!props.editor?.isActive('underline')))
const isCode = computed(() => (void tick.value, !!props.editor?.isActive('code')))
const hasLink = computed(() => (void tick.value, !!props.editor?.isActive('link')))
const hasComment = computed(() => (void tick.value, !!props.editor?.isActive('comment')))
const listKind = computed(() => {
  void tick.value
  const e = props.editor
  if (!e) return ''
  if (e.isActive('taskList')) return 'task'
  if (e.isActive('bulletList')) return 'bullet'
  if (e.isActive('orderedList')) return 'ordered'
  return ''
})
const colorValue = computed(() => {
  void tick.value
  return (props.editor?.getAttributes('textStyle').color as string) || ''
})

/**
 * 选区里某个 mark 是否「一部分有、一部分没有」。
 *
 * Tiptap 的 isActive 要求选区 100% 被该 mark 覆盖才返回 true，所以跨段落
 * 「一段加粗、一段没加粗」时 B 按钮是全灭的；而 toggleBold 看到 isActive=false
 * 会走 setMark，把整段选区全部加粗 —— 界面状态与点击结果对不上。
 * 这里单独算出混合态，给按钮一个第三种视觉状态并在 title 里说明点击结果。
 */
function markMixed(name: string): boolean {
  const e = props.editor
  if (!e || e.isDestroyed) return false
  const sel = e.state.selection
  if (sel.empty || !(sel instanceof TextSelection)) return false
  let has = false
  let missing = false
  e.state.doc.nodesBetween(sel.from, sel.to, (node) => {
    if (!node.isText || !node.text?.length) return
    if (node.marks.some((m) => m.type.name === name)) has = true
    else missing = true
  })
  return has && missing
}
const mixedBold = computed(() => (void tick.value, markMixed('bold')))
const mixedItalic = computed(() => (void tick.value, markMixed('italic')))
const mixedStrike = computed(() => (void tick.value, markMixed('strike')))
const mixedUnderline = computed(() => (void tick.value, markMixed('underline')))

/**
 * 选区内所有段落的排版属性值。值不一致时该键返回 '' 并置 mixed，
 * 避免把第一段的对齐方式错当成整片选区的状态。
 */
const paraState = computed(() => {
  void tick.value
  const state = { textAlign: '', lineHeight: '', fontSize: '', mixed: false, blocks: 0 }
  const e = props.editor
  if (!e || e.isDestroyed) return state
  const sel = e.state.selection
  const blocks: PMNode[] = []
  e.state.doc.nodesBetween(sel.from, sel.to, (node) => {
    if (node.isTextblock) blocks.push(node)
  })
  if (!blocks.length) {
    for (let d = sel.$from.depth; d > 0; d--) {
      const n = sel.$from.node(d)
      if (n.isTextblock) {
        blocks.push(n)
        break
      }
    }
  }
  if (!blocks.length) return state
  const read = (k: string) => {
    const vals = blocks.map((b) => (b.attrs[k] as string | null) ?? '')
    const first = vals[0]
    const mixed = vals.some((v) => v !== first)
    return { value: mixed ? '' : first, mixed }
  }
  const a = read('textAlign')
  const l = read('lineHeight')
  const f = read('fontSize')
  return {
    textAlign: a.value,
    lineHeight: l.value,
    fontSize: f.value,
    mixed: a.mixed || l.mixed || f.mixed,
    blocks: blocks.length,
  }
})

/** 各面板大致高度：用来判断上方空间够不够（不够就向下展开） */
const PANEL_HEIGHT: Record<string, number> = {
  heading: 360,
  list: 240,
  color: 150,
  link: 70,
  more: 220,
  comment: 232,
  paragraph: 300,
}

/** 工具条在选区上方时面板向上展开，别把刚选中的字盖住 */
const panelUp = computed(() => {
  const p = panel.value
  const need = p ? (PANEL_HEIGHT[p] ?? 220) + 12 : 260
  return barPos.value.top > need
})

/* ---------------- 格式命令 ---------------- */

function togglePanel(p: typeof panel.value) {
  const next = panel.value === p ? '' : p
  panel.value = next
  if (next === 'link') {
    const href = (props.editor?.getAttributes('link').href as string) || ''
    linkUrl.value = href
    nextTick(() => {
      linkInput.value?.focus()
      linkInput.value?.select()
    })
  }
  if (next === 'comment') {
    commentDraft.value = ''
    nextTick(() => commentInput.value?.focus())
  }
}

/**
 * 设置标题级别并记进「上次使用的级别」。
 *
 * 注意这里用 setHeading / setParagraph 而不是 toggleHeading：
 * 主键要做的是「套用上次格式」，同一级别再点一次应当保持不变（幂等），
 * 不能因为已经是二级标题就把选区打回正文 —— 取消标题请走面板里的「正文」。
 */
function setHeading(level: number) {
  const e = props.editor
  if (!e) return
  if (level === 0) e.chain().focus().setParagraph().run()
  else e.chain().focus().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
  setLastHeading(level)
  panel.value = ''
  tick.value++
}

/**
 * 飞书式「一键套用」：单击标题按钮直接把上次用的级别刷到选区上。
 * 第一次用（还没有记忆）时退化成打开面板，避免点一下毫无反应。
 */
function applyRecentHeading() {
  const level = getLastHeading()
  if (level === null) {
    togglePanel('heading')
    return
  }
  setHeading(level)
}

/**
 * 切换标题前缀样式：有序数字 / 无序符号。
 * 再点一次当前样式就是关掉前缀，和飞书「点亮的项再点即取消」一致。
 */
function setHeadingNumberStyle(style: 'ordered' | 'unordered') {
  const e = props.editor
  if (!e) return
  if (headingNumberStyle.value === style) {
    e.chain().focus().toggleHeadingNumber(false).run()
  } else {
    e.chain().focus().toggleHeadingNumber(true, style).run()
  }
  panel.value = ''
  tick.value++
}

function setList(kind: 'bullet' | 'ordered' | 'task') {
  const e = props.editor
  if (!e) return
  if (kind === 'bullet') e.chain().focus().toggleBulletList().run()
  else if (kind === 'ordered') e.chain().focus().toggleOrderedList().run()
  else e.chain().focus().toggleTaskList().run()
  panel.value = ''
}

/**
 * 飞书式「一键上色」：单击 A 直接把上次选的颜色刷到选区上。
 * 第一次用（还没有记忆色）时退化成打开色板，避免点一下毫无反应。
 * 想换颜色点右侧的 ▾，不影响记忆色被重复使用的路径。
 */
function applyRecentColor() {
  const remembered = getLastColor()
  if (!remembered) return togglePanel('color')
  applyColor(remembered)
}

function applyColor(value: string) {
  const e = props.editor
  if (!e) return
  if (!value) e.chain().focus().unsetColor().run()
  else e.chain().focus().setColor(value).run()
  // 记住这次的选择：紧接着敲的字自动用同一个颜色，不用再点一次色板
  setLastColor(value)
  panel.value = ''
  tick.value++
}

function applyLink() {
  const e = props.editor
  if (!e) return
  const raw = linkUrl.value.trim()
  if (!raw) return removeLink()
  // 用户常常只敲 www.xxx.com / example.com，补协议；站内 ?space=&doc= 与 mailto/tel 保持原样
  const href = /^(https?:|mailto:|tel:|#|\/|\?)/i.test(raw) ? raw : `https://${raw}`
  e.chain().focus().extendMarkRange('link').setLink({ href }).run()
  panel.value = ''
  tick.value++
}

function removeLink() {
  props.editor?.chain().focus().unsetLink().run()
  panel.value = ''
  tick.value++
}

function clearFormat() {
  props.editor
    ?.chain()
    .focus()
    .unsetBold()
    .unsetItalic()
    .unsetStrike()
    .unsetUnderline()
    .unsetCode()
    .unsetColor()
    .unsetLink()
    // 段落级排版（对齐/行高/字号）也一并清掉，否则「清除格式」之后
    // 选中的几行看起来还是被调过，和按钮名字对不上
    .unsetParagraphStyle()
    .run()
  // 清格式连记忆一起清，否则后面每段都会被上一次的颜色续上
  setLastColor('')
  panel.value = ''
  tick.value++
}

/** 对选区内所有段落一次性设置排版属性（跨多行、跨列表/引用/表格单元格都生效） */
function applyParagraphStyle(patch: ParagraphStyleAttrs) {
  props.editor?.chain().focus().setParagraphStyle(patch).run()
  panel.value = ''
  tick.value++
}

/** 恢复正文默认排版 */
function resetParagraphStyle() {
  props.editor?.chain().focus().unsetParagraphStyle().run()
  panel.value = ''
  tick.value++
}

/** 「更多」里的块级操作：执行完收起面板 */
function runBlock(kind: 'quote' | 'codeBlock' | 'hr' | 'table') {
  const e = props.editor
  if (!e) return
  const chain = e.chain().focus()
  if (kind === 'quote') chain.toggleBlockquote().run()
  else if (kind === 'codeBlock') chain.toggleCodeBlock().run()
  else if (kind === 'hr') chain.setHorizontalRule().run()
  else chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  panel.value = ''
}

/* ---------------- 评论 ---------------- */

const threads = ref<Record<string, CommentThread>>({})
const threadId = ref('')
const replyDraft = ref('')
const threadEl = ref<HTMLElement | null>(null)
const threadPos = ref({ left: 0, top: 0 })
let anchorEl: HTMLElement | null = null

const threadData = computed<CommentThread | null>(() => {
  const id = threadId.value
  return id ? threads.value[id] ?? null : null
})

let ymap: Y.Map<CommentThread> | null = null
let unbindDoc: (() => void) | null = null

function bindDoc(doc?: Y.Doc) {
  unbindDoc?.()
  unbindDoc = null
  ymap = null
  threads.value = {}
  if (!doc) return
  const m = doc.getMap<CommentThread>('comments')
  ymap = m
  const sync = () => {
    const out: Record<string, CommentThread> = {}
    m.forEach((v, k) => {
      if (v) out[k] = v
    })
    threads.value = out
  }
  m.observe(sync)
  sync()
  unbindDoc = () => m.unobserve(sync)
}

function putThread(t: CommentThread) {
  threads.value = { ...threads.value, [t.id]: t }
  ymap?.set(t.id, t)
}

function newId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 找出正文里所有带该批注 id 的连续文本区间（一段批注可能被粗体等切成多段） */
function rangesOf(id: string) {
  const e = props.editor
  const out: { from: number; to: number }[] = []
  if (!e) return out
  e.state.doc.descendants((node, pos) => {
    if (!node.isText) return
    const hit = node.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)
    if (!hit) return
    const last = out[out.length - 1]
    if (last && last.to === pos) last.to = pos + node.nodeSize
    else out.push({ from: pos, to: pos + node.nodeSize })
  })
  return out
}

function updateCommentMarks(id: string, mode: 'resolve' | 'reopen' | 'remove') {
  const e = props.editor
  const type = e?.schema.marks.comment
  if (!e || !type) return
  const ranges = rangesOf(id)
  if (!ranges.length) return
  const { tr } = e.state
  for (const r of ranges) {
    // 同类型 mark 换了 attrs 不会自动替换（excludes 为空时会两个并存），
    // 必须先 removeMark 再 addMark，否则「已解决」的样式永远盖不住原来的黄色
    tr.removeMark(r.from, r.to, type)
    if (mode !== 'remove') {
      tr.addMark(r.from, r.to, type.create({ id, resolved: mode === 'resolve' }))
    }
  }
  e.view.dispatch(tr)
  tick.value++
}

function openComment() {
  const e = props.editor
  if (!e || !props.editable) return
  const activeId = (e.getAttributes('comment').id as string) || ''
  if (activeId && threads.value[activeId]) {
    openThread(activeId)
    return
  }
  if (e.state.selection.empty) return
  togglePanel('comment')
}

function submitComment() {
  const e = props.editor
  const body = commentDraft.value.trim()
  if (!e || !body) return
  const { from, to } = e.state.selection
  if (from === to) return
  const id = newId()
  const quote = e.state.doc.textBetween(from, to, ' ').slice(0, 140)
  // 先清掉选区里原有的批注锚点，避免同一段文字挂两个 comment mark
  e.chain().focus().unsetComment().setComment(id).run()
  putThread({
    id,
    author: props.userName,
    color: props.userColor,
    body,
    at: Date.now(),
    resolved: false,
    quote,
    replies: [],
  })
  commentDraft.value = ''
  panel.value = ''
  tick.value++
}

function openThread(id: string, el?: HTMLElement | null) {
  if (!props.editor) return
  anchorEl =
    el || (document.querySelector(`.ProseMirror mark[data-comment-id="${id}"]`) as HTMLElement | null)
  panel.value = ''
  hideBar()
  threadId.value = id
  replyDraft.value = ''
  placeThread()
}

function closeThread() {
  threadId.value = ''
  replyDraft.value = ''
  anchorEl = null
}

function placeThread() {
  const rect = anchorEl?.getBoundingClientRect()
  const w = 304
  const vw = window.innerWidth
  const vh = window.innerHeight
  const h = threadEl.value?.offsetHeight || 200
  let left = rect ? rect.left : vw / 2 - w / 2
  let top = rect ? rect.bottom + 8 : 160
  left = Math.max(8, Math.min(left, vw - w - 8))
  if (top + h > vh - 8) top = Math.max(8, rect ? rect.top - h - 8 : 80)
  threadPos.value = { left, top }
  nextTick(() => {
    const el = threadEl.value
    if (!el || !rect) return
    const h2 = el.offsetHeight
    if (threadPos.value.top + h2 > vh - 8) {
      threadPos.value = { left, top: Math.max(8, rect.top - h2 - 8) }
    }
  })
}

function submitReply() {
  const t = threadData.value
  const body = replyDraft.value.trim()
  if (!t || !body) return
  putThread({
    ...t,
    replies: [
      ...(t.replies || []),
      { id: newId(), author: props.userName, color: props.userColor, body, at: Date.now() },
    ],
  })
  replyDraft.value = ''
}

function toggleResolve() {
  const t = threadData.value
  if (!t) return
  const resolved = !t.resolved
  putThread({ ...t, resolved })
  updateCommentMarks(t.id, resolved ? 'resolve' : 'reopen')
}

function removeThread() {
  const t = threadData.value
  if (!t) return
  updateCommentMarks(t.id, 'remove')
  if (ymap) ymap.delete(t.id)
  else {
    const copy = { ...threads.value }
    delete copy[t.id]
    threads.value = copy
  }
  closeThread()
}

function onDocDown(e: MouseEvent) {
  const t = e.target as HTMLElement | null

  // 点到工具条/面板之外：收起下拉
  if (panel.value && !rootEl.value?.contains(t)) panel.value = ''

  if (!threadId.value) return
  if (t?.closest?.('.cmt-pop')) return
  // 点正文里另一处批注：交给编辑器 click 逻辑切换
  if (t?.closest?.('mark[data-comment-id]')) return
  closeThread()
}

function initialOf(name: string) {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

function timeText(at: number) {
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date().toDateString()) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/* ---------------- 生命周期 ---------------- */

let boundEditor: Editor | null = null
const onSelection = () => {
  tick.value++
  // 拖选途中：位置每动一下都变，先不弹（否则工具条一路跟着鼠标跳）
  if (pointerDown) {
    clearSettle()
    hideBar()
    return
  }
  // 松手后 / 键盘选择停顿后，再算位置弹出来
  revealAfter(KEY_SETTLE)
}
const onTransaction = () => {
  tick.value++
}
const onBlur = () => {
  if (panel.value || threadId.value) return
  window.setTimeout(() => {
    if (!panel.value && !threadId.value) hideBar()
  }, 120)
}

function bindEditor(e?: Editor) {
  if (boundEditor) {
    boundEditor.off('selectionUpdate', onSelection)
    boundEditor.off('transaction', onTransaction)
    boundEditor.off('blur', onBlur)
  }
  boundEditor = e ?? null
  if (!e) return
  e.on('selectionUpdate', onSelection)
  e.on('transaction', onTransaction)
  e.on('blur', onBlur)
}

onMounted(() => {
  bindEditor(props.editor)
  bindDoc(props.ydoc)
  document.addEventListener('scroll', onDocScroll, true)
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKeyDown)
  // 拖选的「按下 / 松开」：用 pointer 事件，鼠标和触屏（长按拖选）都覆盖
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', resetPointer, true)
  window.addEventListener('blur', resetPointer)
  window.addEventListener('resize', schedule)
})

onBeforeUnmount(() => {
  bindEditor(undefined)
  unbindDoc?.()
  clearSettle()
  document.removeEventListener('scroll', onDocScroll, true)
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', resetPointer, true)
  window.removeEventListener('blur', resetPointer)
  window.removeEventListener('resize', schedule)
  if (rafId) cancelAnimationFrame(rafId)
})

watch(() => props.editor, (e) => bindEditor(e))
watch(() => props.ydoc, (d) => bindDoc(d))
watch(
  () => props.editable,
  (v) => {
    if (!v) {
      hideBar()
      closeThread()
    }
  },
)

/** 供父组件在「点击正文里的批注」时调用 */
defineExpose({ openThread, closeThread })
</script>

<template>
  <!-- 选中文字后的浮动格式条 -->
  <div
    v-if="barVisible"
    ref="rootEl"
    class="sel-wrap"
    :class="{ up: panelUp }"
    :style="{ left: barPos.left + 'px', top: barPos.top + 'px' }"
  >
    <div ref="barEl" class="sel-bar">
      <!-- 标题（飞书式拆分按钮）：单击 = 直接刷上次的级别；▾ = 换级别 -->
      <span class="heading-dd">
        <button
          :class="{ on: panel === 'heading' || headingApplied }"
          :title="headingTip"
          @mousedown="keepSelection"
          @click="applyRecentHeading"
        >
          <span class="dd-label">{{ headingTarget }}</span>
        </button>
        <button
          class="heading-caret"
          :class="{ on: panel === 'heading' }"
          title="选择其他标题级别 / 正文"
          @mousedown="keepSelection"
          @click="togglePanel('heading')"
        >
          <span class="chev">▾</span>
        </button>
      </span>

      <button
        class="wide"
        :class="{ on: panel === 'list' || !!listKind }"
        title="列表"
        @mousedown="keepSelection"
        @click="togglePanel('list')"
      >
        <span class="list-ico"><i /><i /><i /></span>
        <span class="chev">▾</span>
      </button>

      <button
        class="wide"
        :class="{ on: panel === 'paragraph' || paraState.mixed || !!(paraState.textAlign || paraState.lineHeight || paraState.fontSize) }"
        :title="`段落排版：对齐 / 行高 / 字号（选中 ${paraState.blocks} 个段落，一次统一生效）`"
        @mousedown="keepSelection"
        @click="togglePanel('paragraph')"
      >
        <span class="para-ico">¶</span>
        <span class="chev">▾</span>
      </button>

      <span class="sel-sep" />

      <button :class="{ on: isBold, mixed: mixedBold }" :title="mixedBold ? '部分文字已加粗，点击统一加粗' : '加粗 ⌘B'" @mousedown="keepSelection" @click="editor?.chain().focus().toggleBold().run()">
        <b>B</b>
      </button>
      <button :class="{ on: isStrike, mixed: mixedStrike }" :title="mixedStrike ? '部分文字有删除线，点击统一加上' : '删除线'" @mousedown="keepSelection" @click="editor?.chain().focus().toggleStrike().run()">
        <span class="ic-strike">S</span>
      </button>
      <button :class="{ on: isItalic, mixed: mixedItalic }" :title="mixedItalic ? '部分文字是斜体，点击统一设为斜体' : '斜体 ⌘I'" @mousedown="keepSelection" @click="editor?.chain().focus().toggleItalic().run()">
        <i>I</i>
      </button>
      <button :class="{ on: isUnderline, mixed: mixedUnderline }" :title="mixedUnderline ? '部分文字有下划线，点击统一加上' : '下划线 ⌘U'" @mousedown="keepSelection" @click="editor?.chain().focus().toggleUnderline().run()">
        <u>U</u>
      </button>
      <button :class="{ on: hasLink || panel === 'link' }" title="链接" @mousedown="keepSelection" @click="togglePanel('link')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M10 13a5 5 0 0 0 7 0l2.5-2.5a5 5 0 0 0-7-7L11 5" />
          <path d="M14 11a5 5 0 0 0-7 0L4.5 13.5a5 5 0 0 0 7 7L13 19" />
        </svg>
      </button>
      <button :class="{ on: isCode }" title="行内代码 ⌘E" @mousedown="keepSelection" @click="editor?.chain().focus().toggleCode().run()">
        <span class="ic-code">&lt;/&gt;</span>
      </button>

      <span class="sel-sep" />

      <!-- 字体颜色（飞书式拆分按钮）：单击 A = 直接刷上次的颜色；▾ = 换颜色 -->
      <span class="color-dd">
        <button
          :class="{ on: panel === 'color' || !!colorValue }"
          :title="recentColor ? `单击应用上次颜色：${recentColorName}（点 ▾ 换颜色）` : '字体颜色（首次请选一个颜色）'"
          @mousedown="keepSelection"
          @click="applyRecentColor"
        >
          <span class="ic-color">
            <span>A</span>
            <span class="cbar" :style="{ background: recentColor || colorValue || '#1f2329' }" />
          </span>
        </button>
        <button
          class="color-caret"
          :class="{ on: panel === 'color' }"
          title="选择其他颜色 / 恢复默认"
          @mousedown="keepSelection"
          @click="togglePanel('color')"
        >
          <span class="chev">▾</span>
        </button>
      </span>
      <button :class="{ on: panel === 'more' }" title="更多" @mousedown="keepSelection" @click="togglePanel('more')">⋯</button>
      <button :class="{ on: hasComment || panel === 'comment' }" title="评论" @mousedown="keepSelection" @click="openComment">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
          <path d="M4 4h16v12H9l-5 4z" />
        </svg>
      </button>
    </div>

    <!-- 段落排版：对齐 / 行高 / 字号，一次作用于选区内的所有段落 -->
    <div v-if="panel === 'paragraph'" class="sel-panel sel-para">
      <div class="sel-sect">
        对齐
        <span v-if="paraState.mixed" class="sel-mixed-tip">选区内不一致，点击即统一</span>
      </div>
      <div class="sel-grid">
        <button
          v-for="o in ALIGN_OPTIONS"
          :key="o.value"
          class="sel-chip"
          :class="{ on: paraState.textAlign === o.value }"
          @mousedown="keepSelection"
          @click="applyParagraphStyle({ textAlign: o.value })"
        >
          <span class="sel-ic">{{ o.icon }}</span>{{ o.label }}
        </button>
      </div>
      <div class="sel-sect">行高</div>
      <div class="sel-grid">
        <button
          v-for="o in LINE_HEIGHT_OPTIONS"
          :key="o.value"
          class="sel-chip"
          :class="{ on: paraState.lineHeight === o.value }"
          @mousedown="keepSelection"
          @click="applyParagraphStyle({ lineHeight: o.value })"
        >
          {{ o.label }} <small>{{ o.value }}</small>
        </button>
      </div>
      <div class="sel-sect">字号</div>
      <div class="sel-grid">
        <button
          v-for="o in FONT_SIZE_OPTIONS"
          :key="o.value"
          class="sel-chip"
          :class="{ on: paraState.fontSize === o.value }"
          @mousedown="keepSelection"
          @click="applyParagraphStyle({ fontSize: o.value })"
        >
          {{ o.label }} <small>{{ o.value }}</small>
        </button>
      </div>
      <span class="sel-sep-line" />
      <button class="sel-item" @mousedown="keepSelection" @click="resetParagraphStyle">
        <span class="sel-ic">↺</span>恢复默认排版
      </button>
      <div class="sel-hint">对选中的 {{ paraState.blocks }} 个段落统一生效</div>
    </div>

    <!-- 标题 -->
    <div v-if="panel === 'heading'" class="sel-panel">
      <button class="sel-item" :class="{ on: headingLabel === 'T' }" @mousedown="keepSelection" @click="setHeading(0)">
        <span class="sel-ic">¶</span>正文
        <span v-if="recentHeading === 0" class="sel-last">上次</span>
      </button>
      <button
        v-for="lv in [1, 2, 3, 4, 5, 6]"
        :key="lv"
        class="sel-item"
        :class="{ on: headingLabel === `H${lv}` }"
        @mousedown="keepSelection"
        @click="setHeading(lv)"
      >
        <span class="sel-ic" :style="{ fontSize: 17 - lv + 'px' }">H{{ lv }}</span>
        {{ ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'][lv - 1] }}
        <span v-if="recentHeading === lv" class="sel-last">上次</span>
      </button>
      <span class="sel-sep-line" />
      <button
        class="sel-item"
        :class="{ on: headingNumberStyle === 'ordered' }"
        @mousedown="keepSelection"
        @click="setHeadingNumberStyle('ordered')"
      >
        <span class="sel-ic">№</span>标题有序编号（1 / 1.1 / 1.1.1）
      </button>
      <button
        class="sel-item"
        :class="{ on: headingNumberStyle === 'unordered' }"
        @mousedown="keepSelection"
        @click="setHeadingNumberStyle('unordered')"
      >
        <span class="sel-ic">●</span>标题无序符号（● ○ ■ □ ◆ ◇）
      </button>
    </div>

    <!-- 列表 -->
    <div v-if="panel === 'list'" class="sel-panel">
      <button class="sel-item" :class="{ on: listKind === 'bullet' }" @mousedown="keepSelection" @click="setList('bullet')">
        <span class="sel-ic">•</span>无序列表
      </button>
      <button class="sel-item" :class="{ on: listKind === 'ordered' }" @mousedown="keepSelection" @click="setList('ordered')">
        <span class="sel-ic">1.</span>有序列表
      </button>
      <button class="sel-item" :class="{ on: listKind === 'task' }" @mousedown="keepSelection" @click="setList('task')">
        <span class="sel-ic">☑</span>待办清单
      </button>
      <span class="sel-sep-line" />
      <button
        class="sel-item"
        :class="{ on: headingNumberStyle === 'ordered' }"
        @mousedown="keepSelection"
        @click="setHeadingNumberStyle('ordered')"
      >
        <span class="sel-ic">№</span>标题 + 有序编号（1 / 1.1）
      </button>
      <button
        class="sel-item"
        :class="{ on: headingNumberStyle === 'unordered' }"
        @mousedown="keepSelection"
        @click="setHeadingNumberStyle('unordered')"
      >
        <span class="sel-ic">●</span>标题 + 无序符号（● ○ ■）
      </button>
    </div>

    <!-- 颜色：只有点 ▾ 才展开；日常改色单击 A 一步完成 -->
    <div v-if="panel === 'color'" class="sel-panel sel-colors">
      <div class="sel-colors-title">字体颜色</div>
      <div class="sel-colors-grid">
        <button
          v-for="c in COLOR_SWATCHES"
          :key="c.name"
          class="swatch"
          :title="c.value === recentColor ? `${c.name}（上次使用，点 A 可直接复用）` : c.name"
          :style="{ background: c.value }"
          :class="{
            on: (colorValue || '') === c.value,
            recent: c.value === recentColor,
          }"
          @mousedown="keepSelection"
          @click="applyColor(c.value)"
        />
      </div>
      <button class="sel-colors-reset" @mousedown="keepSelection" @click="applyColor('')">恢复默认</button>
    </div>

    <!-- 链接 -->
    <div v-if="panel === 'link'" class="sel-panel sel-link" @mousedown="keepFocus">
      <input
        ref="linkInput"
        v-model="linkUrl"
        placeholder="粘贴或输入链接，回车确认"
        spellcheck="false"
        @keydown.enter.prevent="applyLink"
        @keydown.esc.prevent="panel = ''"
      />
      <button class="sel-primary" @click="applyLink">确定</button>
      <button v-if="hasLink" class="sel-ghost" @click="removeLink">移除</button>
    </div>

    <!-- 更多 -->
    <div v-if="panel === 'more'" class="sel-panel">
      <button class="sel-item" @mousedown="keepSelection" @click="runBlock('quote')">
        <span class="sel-ic">❝</span>引用
      </button>
      <button class="sel-item" @mousedown="keepSelection" @click="runBlock('codeBlock')">
        <span class="sel-ic">&lt;/&gt;</span>代码块
      </button>
      <button class="sel-item" @mousedown="keepSelection" @click="runBlock('hr')">
        <span class="sel-ic">─</span>分割线
      </button>
      <button class="sel-item" @mousedown="keepSelection" @click="runBlock('table')">
        <span class="sel-ic">▦</span>插入表格
      </button>
      <span class="sel-sep-line" />
      <button class="sel-item" @mousedown="keepSelection" @click="clearFormat">
        <span class="sel-ic">⌫</span>清除格式
      </button>
    </div>

    <!-- 写评论 -->
    <div v-if="panel === 'comment'" class="sel-panel sel-comment" @mousedown="keepFocus">
      <div class="sel-comment-head">评论选中内容</div>
      <textarea
        ref="commentInput"
        v-model="commentDraft"
        rows="3"
        placeholder="写下你的想法，@同事一起看…"
        @keydown.meta.enter.prevent="submitComment"
        @keydown.ctrl.enter.prevent="submitComment"
        @keydown.esc.prevent="panel = ''"
      />
      <div class="sel-comment-foot">
        <span class="tip">⌘/Ctrl + Enter 发送</span>
        <button class="sel-primary" :disabled="!commentDraft.trim()" @click="submitComment">评论</button>
      </div>
    </div>
  </div>

  <!-- 批注线程弹层 -->
  <div
    v-if="threadData"
    ref="threadEl"
    class="cmt-pop"
    :style="{ left: threadPos.left + 'px', top: threadPos.top + 'px' }"
    @mousedown.stop
  >
    <div class="cmt-head">
      <span class="cmt-avatar" :style="{ background: threadData.color || '#3370ff' }">{{ initialOf(threadData.author) }}</span>
      <b>{{ threadData.author }}</b>
      <span class="cmt-time">{{ timeText(threadData.at) }}</span>
      <span v-if="threadData.resolved" class="cmt-done">已解决</span>
      <button class="cmt-x" title="关闭" @click="closeThread">✕</button>
    </div>

    <div v-if="threadData.quote" class="cmt-quote">“{{ threadData.quote }}”</div>
    <div class="cmt-body">{{ threadData.body }}</div>

    <div v-for="r in threadData.replies" :key="r.id" class="cmt-reply">
      <span class="cmt-avatar sm" :style="{ background: r.color || '#3370ff' }">{{ initialOf(r.author) }}</span>
      <div class="cmt-reply-main">
        <div class="cmt-reply-head"><b>{{ r.author }}</b><span class="cmt-time">{{ timeText(r.at) }}</span></div>
        <p>{{ r.body }}</p>
      </div>
    </div>

    <div v-if="editable" class="cmt-reply-box">
      <input
        v-model="replyDraft"
        placeholder="回复…"
        @keydown.enter.prevent="submitReply"
        @keydown.esc.prevent="closeThread"
      />
      <button :disabled="!replyDraft.trim()" @click="submitReply">发送</button>
    </div>

    <div class="cmt-actions">
      <button v-if="editable" @click="toggleResolve">{{ threadData.resolved ? '重新打开' : '标记已解决' }}</button>
      <button v-if="editable" class="danger" @click="removeThread">删除</button>
      <span v-else class="cmt-ro">仅查看</span>
    </div>
  </div>
</template>

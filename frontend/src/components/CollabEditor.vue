<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { ChainedCommands } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import MermaidBlock from '../extensions/MermaidBlock'
import PlantUMLBlock from '../extensions/PlantUMLBlock'
import HeadingFold from '../extensions/HeadingFold'
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
  }>(),
  {
    docName: 'demo-doc',
    userName: '匿名',
    userColor: '#3370ff',
    wsUrl: COLLAB_URL,
    collabToken: '',
    editable: true,
  },
)

const editor = ref<Editor>()
let provider: HocuspocusProvider | null = null

const emit = defineEmits<{
  /** 编辑器实例就绪后上报，供大纲/折叠等外部面板使用 */
  (e: 'editor-ready', editor: Editor): void
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

const SLASH_GROUPS: SlashGroup[] = [
  {
    name: '基础',
    items: [
      { key: 'h1', label: '一级标题', hint: '章节大标题', icon: 'H1', keywords: 'h1 yiji biaoti title', run: (c) => c.toggleHeading({ level: 1 }) },
      { key: 'h2', label: '二级标题', hint: '小节标题', icon: 'H2', keywords: 'h2 erji biaoti title', run: (c) => c.toggleHeading({ level: 2 }) },
      { key: 'h3', label: '三级标题', hint: '更小的标题', icon: 'H3', keywords: 'h3 sanji biaoti title', run: (c) => c.toggleHeading({ level: 3 }) },
      { key: 'bullet', label: '无序列表', hint: '圆点列表', icon: '•', keywords: 'wuxu liebiao list bullet ul', run: (c) => c.toggleBulletList() },
      { key: 'ordered', label: '有序列表', hint: '带编号列表', icon: '1.', keywords: 'youxu liebiao list ordered ol number', run: (c) => c.toggleOrderedList() },
      { key: 'task', label: '待办清单', hint: '可勾选的任务项', icon: '☑', keywords: 'daiban qingdan todo task checkbox', run: (c) => c.toggleTaskList() },
      { key: 'code', label: '代码块', hint: '等宽字体代码', icon: '</>', keywords: 'daima code codeblock', run: (c) => c.toggleCodeBlock() },
      { key: 'quote', label: '引用', hint: '引述一段话', icon: '❝', keywords: 'yinyong quote blockquote', run: (c) => c.toggleBlockquote() },
      { key: 'text', label: '正文', hint: '普通段落', icon: '¶', keywords: 'zhengwen text p paragraph', run: (c) => c.setParagraph() },
      { key: 'divider', label: '分割线', hint: '分隔内容区块', icon: '─', keywords: 'fengexian divider hr line', run: (c) => c.setHorizontalRule() },
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
/** 块菜单要在「当前块之后」插入，记录目标块的起止 pos */
const plusBlockFrom = ref(0)
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

/** 光标是否处在「段首输入 /xxx」的状态；是则更新菜单位置 */
function syncSlash() {
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
    // 非斜杠输入：刷新行内 + 按钮位置
    if (!slashOpen.value) syncPlusDot()
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

/** 定位行内 + 按钮：取当前光标所在块的左侧位置 */
function syncPlusDot() {
  const ed = editor.value
  if (!ed || ed.isDestroyed) {
    plusDotVisible.value = false
    return
  }
  if (!props.editable) {
    plusDotVisible.value = false
    return
  }
  const { state } = ed
  const { $from } = state.selection
  // 根文档或空文档不显示 + 按钮
  if ($from.depth === 0 && $from.parent.type.name === 'doc' && $from.parent.childCount === 0) {
    plusDotVisible.value = false
    return
  }
  // 取块起点坐标，+ 按钮放在块左侧
  const blockStart = $from.before($from.depth)
  const coords = ed.view.coordsAtPos(blockStart)
  plusBlockFrom.value = blockStart
  plusBlockTo.value = $from.after($from.depth)
  // + 按钮固定在正文内容左侧，与块首行垂直对齐
  plusDotX.value = coords.left - 26
  plusDotY.value = coords.top
  plusDotVisible.value = true
}

/** 点击行内 + 按钮：打开块菜单（复用斜杠菜单渲染，但插入语义为「块后插入」） */
function openPlusMenu() {
  const ed = editor.value
  if (!ed) return
  menuSource.value = 'plus'
  slashQuery.value = ''
  submenuOf.value = ''
  slashIndex.value = 0
  const coords = ed.view.coordsAtPos(plusBlockFrom.value)
  const menuW = 280
  const menuH = 360
  slashX.value = Math.max(8, Math.min(coords.left, window.innerWidth - menuW - 8))
  slashY.value =
    coords.bottom + menuH > window.innerHeight
      ? Math.max(8, coords.top - menuH - 6)
      : coords.bottom + 6
  slashOpen.value = true
  plusDotVisible.value = false
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
  if (source === 'plus') {
    // 行内 + 触发：在当前块之后插入新块
    item.run(ed.chain().focus().insertContentAt(from, { type: 'paragraph' })).run()
  } else {
    // 斜杠触发：先删掉输入的 "/xxx"，再执行块转换
    item.run(ed.chain().focus().deleteRange({ from, to })).run()
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
  const ydoc = new Y.Doc()

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
      StarterKit.configure({ history: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // 表格：履历、方案这类文档大量用表格承载对照关系，没有表格节点就只能退化成纯文本
      Table.configure({ resizable: false, lastColumnResizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      MermaidBlock,
      PlantUMLBlock,
      HeadingFold,
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: { name: props.userName, color: props.userColor },
      }),
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
    onUpdate: syncSlash,
    onSelectionUpdate: syncSlash,
    onBlur: closeSlash,
  })

  emit('editor-ready', editor.value)

  document.addEventListener('scroll', onAnyScroll, true)

  // 编辑器就绪后定位一次行内 + 按钮（协同内容异步加载，延迟一点再定位）
  setTimeout(() => syncPlusDot(), 300)
})

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onAnyScroll, true)
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
</script>

<template>
  <div class="collab">
    <div class="bar">
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

        <button :class="{ active: editor?.isActive('bold') }" title="加粗" @click="editor?.chain().focus().toggleBold().run()">
          <b>B</b>
        </button>
        <button :class="{ active: editor?.isActive('italic') }" title="斜体" @click="editor?.chain().focus().toggleItalic().run()">
          <i>I</i>
        </button>
        <button :class="{ active: editor?.isActive('strike') }" title="删除线" @click="editor?.chain().focus().toggleStrike().run()">
          <s>S</s>
        </button>
        <button :class="{ active: editor?.isActive('code') }" title="行内代码" @click="editor?.chain().focus().toggleCode().run()">
          &lt;/&gt;
        </button>

        <span class="bar-sep" />

        <button :class="{ active: editor?.isActive('heading', { level: 1 }) }" @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()">H1</button>
        <button :class="{ active: editor?.isActive('heading', { level: 2 }) }" @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()">H2</button>
        <button :class="{ active: editor?.isActive('bulletList') }" title="无序列表" @click="editor?.chain().focus().toggleBulletList().run()">•</button>
        <button :class="{ active: editor?.isActive('orderedList') }" title="有序列表" @click="editor?.chain().focus().toggleOrderedList().run()">1.</button>
        <button :class="{ active: editor?.isActive('taskList') }" title="待办清单" @click="editor?.chain().focus().toggleTaskList().run()">☑</button>
        <button :class="{ active: editor?.isActive('blockquote') }" title="引用" @click="editor?.chain().focus().toggleBlockquote().run()">❝</button>

        <!-- 光标在表格里才出现的表格操作，避免常驻挤占工具栏 -->
        <template v-if="editor?.isActive('table')">
          <span class="bar-sep" />
          <button title="下方插入一行" @click="editor?.chain().focus().addRowAfter().run()">+行</button>
          <button title="右侧插入一列" @click="editor?.chain().focus().addColumnAfter().run()">+列</button>
          <button title="删除当前行" @click="editor?.chain().focus().deleteRow().run()">-行</button>
          <button title="删除当前列" @click="editor?.chain().focus().deleteColumn().run()">-列</button>
          <button title="删除整个表格" @click="editor?.chain().focus().deleteTable().run()">删表</button>
        </template>

        <span class="bar-sep" />

        <button title="撤销" @click="editor?.chain().focus().undo().run()">↶</button>
        <button title="重做" @click="editor?.chain().focus().redo().run()">↷</button>

        <span class="slash-tip">输入 / 插入区块</span>
      </template>

      <!-- 只读态：不显示格式按钮，明确告诉用户为什么改不了 -->
      <span v-else class="readonly-badge">👁 仅查看 · 你没有编辑权限</span>
    </div>

    <EditorContent :editor="editor" class="content" />

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

    <!-- 行内 + 按钮：光标所在块左侧，hover 出 + 弹出块菜单 -->
    <button
      v-if="plusDotVisible && editable"
      class="plus-dot"
      :style="{ left: plusDotX + 'px', top: plusDotY + 'px' }"
      title="插入区块"
      @mousedown.prevent
      @mouseenter="openPlusMenu"
      @click="openPlusMenu"
    >
      ＋
    </button>
  </div>
</template>

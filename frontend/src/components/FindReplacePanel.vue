<script setup lang="ts">
/**
 * 全文查找 / 替换面板。
 *
 * 为什么不直接用浏览器自带 Ctrl+F：正文是 ProseMirror 渲染的，浏览器查找只能
 * 滚动到可见位置、不能替换，也定位不到被折叠或懒渲染的块。
 *
 * 匹配基于「文档纯文本 + 字符→文档位置」的索引：把每个 text 节点拼成一条字符串，
 * 同时记下每个字符真实的 ProseMirror 位置；块与块之间插入一个 -1 占位，
 * 保证匹配不会跨块（跨块替换会破坏块结构）。高亮用 Decoration 叠加，
 * 只带 meta 的事务没有 step，不会写进 Yjs、也不污染撤销栈。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const props = defineProps<{ editor: Editor | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface Hit {
  from: number
  to: number
}

const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const replaceMode = ref(false)
const hits = ref<Hit[]>([])
const active = ref(0)
const tip = ref('')
/** 只读空间只给查找：替换按钮留着会让人以为能改 */
const canEdit = ref(true)
const queryEl = ref<HTMLInputElement>()
const replaceEl = ref<HTMLInputElement>()

const key = new PluginKey<DecorationSet>('scofendocFindReplace')
let plugin: Plugin<DecorationSet> | null = null
let offUpdate: (() => void) | null = null
let tipTimer: number | undefined

const countLabel = computed(() => {
  if (!query.value) return ''
  if (!hits.value.length) return '无结果'
  return `${active.value + 1}/${hits.value.length}`
})

/** 拼纯文本 + 位置表；块边界记为 -1，命中时跳过 */
function buildIndex(doc: PMNode) {
  let text = ''
  const pos: number[] = []
  doc.descendants((node, p) => {
    if (node.isText) {
      const t = node.text || ''
      for (let i = 0; i < t.length; i++) pos.push(p + i)
      text += t
      return false
    }
    // 块与叶子节点都插一个分隔符：跨块匹配没有意义
    if (node.isBlock || node.isLeaf) {
      text += '\n'
      pos.push(-1)
    }
    return true
  })
  return { text, pos }
}

function computeHits(): Hit[] {
  const ed = props.editor
  const q = query.value
  if (!ed || !q) return []
  const { text, pos } = buildIndex(ed.state.doc)

  let hay = text
  let needle = q
  if (!caseSensitive.value) {
    const lower = text.toLowerCase()
    // 极少数语言（如土耳其语 İ）转小写会变长，位置表就对不上了，退回区分大小写
    if (lower.length === text.length) {
      hay = lower
      needle = q.toLowerCase()
    }
  }

  const out: Hit[] = []
  let i = 0
  while (needle && i <= hay.length - needle.length) {
    const j = hay.indexOf(needle, i)
    if (j < 0) break
    let ok = true
    for (let k = j; k < j + needle.length; k++) {
      if (pos[k] < 0) {
        ok = false
        break
      }
    }
    if (ok) out.push({ from: pos[j], to: pos[j + needle.length - 1] + 1 })
    i = j + Math.max(1, needle.length)
  }
  return out
}

/** 高亮：当前项深一档，其余浅黄 */
function paint() {
  const ed = props.editor
  if (!ed || !plugin) return
  const decos = hits.value.map((h, i) =>
    Decoration.inline(h.from, h.to, { class: i === active.value ? 'fr-hit fr-cur' : 'fr-hit' }),
  )
  const tr = ed.state.tr.setMeta(key, DecorationSet.create(ed.state.doc, decos))
  ed.view.dispatch(tr)
}

function reveal(hit: Hit) {
  const ed = props.editor
  if (!ed) return
  try {
    const at = ed.view.domAtPos(hit.from)
    const node = at.node.nodeType === 3 ? at.node.parentElement : (at.node as HTMLElement)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    /* 位置在渲染中失效时忽略，下一次输入会重算 */
  }
}

/** 重算匹配并保持当前项尽量不跳 */
function search(reset = false) {
  const prev = hits.value[active.value]
  hits.value = computeHits()
  if (reset || !hits.value.length) {
    active.value = 0
  } else if (prev) {
    // 正文改动后位置会变，按 from 找最近的命中
    const idx = hits.value.findIndex((h) => h.from >= prev.from)
    active.value = idx >= 0 ? idx : Math.max(0, hits.value.length - 1)
  }
  if (active.value > hits.value.length - 1) active.value = 0
  paint()
  if (hits.value[active.value]) reveal(hits.value[active.value])
}

function next() {
  if (!hits.value.length) return
  active.value = (active.value + 1) % hits.value.length
  paint()
  reveal(hits.value[active.value])
}

function prev() {
  if (!hits.value.length) return
  active.value = (active.value - 1 + hits.value.length) % hits.value.length
  paint()
  reveal(hits.value[active.value])
}

function flash(msg: string) {
  tip.value = msg
  window.clearTimeout(tipTimer)
  tipTimer = window.setTimeout(() => (tip.value = ''), 2200)
}

function replaceOne() {
  if (!canEdit.value) return
  const ed = props.editor
  const hit = hits.value[active.value]
  if (!ed || !hit) return
  ed.view.dispatch(ed.state.tr.insertText(replacement.value, hit.from, hit.to))
  search()
  flash('已替换 1 处')
}

function replaceAll() {
  if (!canEdit.value) return
  const ed = props.editor
  if (!ed || !hits.value.length) return
  const total = hits.value.length
  const tr = ed.state.tr
  // 从后往前替换：前面的位置不会失效；整批一个事务 = 一次 Ctrl+Z 回退
  for (const h of [...hits.value].reverse()) tr.insertText(replacement.value, h.from, h.to)
  ed.view.dispatch(tr)
  search(true)
  flash(`已替换 ${total} 处`)
}

function toggleReplace() {
  replaceMode.value = !replaceMode.value
  if (replaceMode.value) nextTick(() => replaceEl.value?.focus())
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Enter') return
  // 替换框自己处理 Enter（替换一处），别再触发"下一个"
  const el = e.target as HTMLElement | null
  if (el?.classList.contains('fr-replace')) return
  e.preventDefault()
  if (e.shiftKey) prev()
  else next()
}

/** 焦点可能在正文或按钮上，Esc 必须挂 window 才收得到 */
function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

/** 正文被本地或协同改动后重算：装饰会随 mapping 偏移，命中列表必须重扫 */
function onDocUpdate() {
  search()
}

function bindEditor(ed: Editor | null) {
  offUpdate?.()
  offUpdate = null
  if (!ed) {
    hits.value = []
    return
  }
  plugin = new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(key) as DecorationSet | undefined
        return meta ?? set.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations(state) {
        return key.getState(state)
      },
    },
  })
  canEdit.value = ed.isEditable
  canEdit.value = ed.isEditable
  ed.registerPlugin(plugin)
  const handler = () => onDocUpdate()
  ed.on('update', handler)
  offUpdate = () => {
    ed.off('update', handler)
    ed.unregisterPlugin(key)
    plugin = null
  }
  search(true)
}

watch(
  () => props.editor,
  (ed) => bindEditor(ed),
  { immediate: true },
)

watch([query, caseSensitive], () => search(true))

onBeforeUnmount(() => {
  offUpdate?.()
  window.removeEventListener('keydown', onWindowKeydown)
  window.clearTimeout(tipTimer)
})

onMounted(() => window.addEventListener('keydown', onWindowKeydown))

nextTick(() => queryEl.value?.focus())
</script>

<template>
  <div class="find-panel" @keydown="onKeydown">
    <div class="fr-row">
      <span class="fr-ic fr-static" aria-hidden="true">🔍</span>
      <input
        ref="queryEl"
        v-model="query"
        class="fr-input"
        placeholder="查找内容"
        spellcheck="false"
      />
      <span class="fr-count">{{ countLabel }}</span>
      <button class="fr-ic" title="上一个（Shift+Enter）" @click="prev">↑</button>
      <button class="fr-ic" title="下一个（Enter）" @click="next">↓</button>
      <button
        class="fr-ic"
        :class="{ on: caseSensitive }"
        title="区分大小写"
        @click="caseSensitive = !caseSensitive"
      >
        Aa
      </button>
      <button
        v-if="canEdit"
        class="fr-ic"
        :class="{ on: replaceMode }"
        title="替换"
        @click="toggleReplace"
      >
        ⇄
      </button>
      <button class="fr-ic" title="关闭（Esc）" @click="emit('close')">✕</button>
    </div>

    <div v-if="canEdit && replaceMode" class="fr-row">
      <span class="fr-ic fr-static" aria-hidden="true">→</span>
      <input
        ref="replaceEl"
        v-model="replacement"
        class="fr-input fr-replace"
        placeholder="替换为"
        spellcheck="false"
        @keydown.enter.prevent="replaceOne"
      />
      <button class="fr-btn" :disabled="!hits.length" @click="replaceOne">替换</button>
      <button class="fr-btn" :disabled="!hits.length" @click="replaceAll">全部替换</button>
    </div>

    <div v-if="tip" class="fr-tip">{{ tip }}</div>
  </div>
</template>

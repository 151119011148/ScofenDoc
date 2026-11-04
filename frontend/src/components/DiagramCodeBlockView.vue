<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import mermaid from 'mermaid'
import plantumlEncoder from 'plantuml-encoder'
import DiagramLightbox from './DiagramLightbox.vue'

/**
 * 代码块的「能画就画」视图。
 *
 * 为什么不是又加一个 atom 节点：正文里出现 flowchart 有两条来源 ——
 * ① 导入管线产出的 mermaid 原子节点（MermaidBlock 负责，已经能用）；
 * ② 用户从别处粘贴 / 早期导入留下的**普通代码块**，它可能连 language 都没有，
 *    这种节点如果再靠 parseHTML 规则去救，是救不回来的（数据里就是 codeBlock）。
 *
 * 所以这里挂在 codeBlock 自己的 NodeView 上，靠**内容首行**判断是不是图语法。
 * 好处是：不需要改 Yjs 二进制、粘贴任何图代码立刻能画、源码始终可编辑。
 *
 * 交互：光标进到块内显示源码（边打字边渲染会打断输入），移出光标自动变图；
 * 也可以点顶部按钮手动切换。
 */
const props = defineProps<NodeViewProps>()

/** 首行即语法关键字才算图，避免把普通代码误判成图 */
const MERMAID_HEAD =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart(-beta)?|block-beta|sankey(-beta)?|gitGraph|C4Context|C4Container|C4Component|requirementDiagram|packet-beta|architecture-beta)\b/

const PLANTUML_HEAD = /^@start(uml|mindmap|gantt|wbs|json|yaml|salt|ditaa|dot|jcckit)\b/i

let inited = false
function ensureInit() {
  if (inited) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
  })
  inited = true
}

const code = computed(() => (props.node?.textContent || '').replace(/^\n+|\n+$/g, ''))
const declaredLang = computed(() => String(props.node?.attrs?.language || '').toLowerCase())

/** 图类型：先看语言标记，再看内容首行（兼容没有 language 的代码块） */
const kind = computed<'mermaid' | 'plantuml' | null>(() => {
  const src = code.value.trim()
  if (!src) return null
  if (declaredLang.value === 'mermaid') return 'mermaid'
  if (['plantuml', 'puml', 'uml'].includes(declaredLang.value)) return 'plantuml'
  if (PLANTUML_HEAD.test(src)) return 'plantuml'
  if (MERMAID_HEAD.test(src)) return 'mermaid'
  return null
})

/* ---------------- 源码 / 图 两种形态 ---------------- */

/** 手动切到源码态（点按钮），优先级高于光标位置 */
const manualSource = ref(false)
/** 光标是否在这个代码块内部 */
const cursorInside = ref(false)

const showSource = computed(() => manualSource.value || cursorInside.value)
const showDiagram = computed(() => !!kind.value && !showSource.value)

function syncCursor() {
  const ed = props.editor
  if (!ed || ed.isDestroyed) {
    cursorInside.value = false
    return
  }
  const pos = props.getPos?.()
  if (typeof pos !== 'number') {
    cursorInside.value = false
    return
  }
  const { from, to } = ed.state.selection
  const end = pos + props.node.nodeSize
  cursorInside.value = from > pos && to <= end && from < end
}

function editSource() {
  manualSource.value = true
  const pos = props.getPos?.()
  if (typeof pos === 'number') {
    nextTick(() => props.editor.chain().setTextSelection(pos + 1).focus().run())
  }
}

function showPreview() {
  manualSource.value = false
  props.editor.commands.blur()
}

/* ---------------- 渲染 ---------------- */

const svg = ref('')
const err = ref('')
const loading = ref(false)
const lightbox = ref(false)
let timer: number | undefined
let seq = 0

async function draw() {
  const k = kind.value
  const src = code.value
  if (!k || !src || !showDiagram.value) return

  const mine = ++seq
  loading.value = true
  err.value = ''
  try {
    if (k === 'mermaid') {
      ensureInit()
      const id = 'dcb-' + Math.random().toString(36).slice(2, 10)
      const res = await mermaid.render(id, src)
      if (mine !== seq) return
      svg.value = res.svg
    } else {
      const ctrl = new AbortController()
      const to = window.setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch('https://kroki.io/plantuml/svg/' + plantumlEncoder.encode(src), {
        signal: ctrl.signal,
      })
      window.clearTimeout(to)
      const text = await res.text()
      // kroki 渲染失败时返回纯文本错误而不是 svg
      if (!res.ok || !text.trim().startsWith('<svg')) {
        throw new Error(text.trim().slice(0, 160) || `kroki 返回 ${res.status}`)
      }
      if (mine !== seq) return
      svg.value = text
    }
  } catch (e: any) {
    if (mine !== seq) return
    err.value = e?.message || String(e)
    svg.value = ''
  } finally {
    if (mine === seq) loading.value = false
  }
}

/** 打字时不必每次都渲染，停手 260ms 再画 */
function scheduleDraw() {
  window.clearTimeout(timer)
  timer = window.setTimeout(draw, 260)
}

watch(
  [code, kind, showDiagram],
  () => {
    if (showDiagram.value) scheduleDraw()
    else {
      // 切回源码后清掉旧图，避免下次进来闪一下上一版
      window.clearTimeout(timer)
    }
  },
  { immediate: true },
)

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  const ed = props.editor
  ed.on('selectionUpdate', syncCursor)
  ed.on('focus', syncCursor)
  ed.on('blur', syncCursor)
  syncCursor()
})

onBeforeUnmount(() => {
  window.clearTimeout(timer)
  seq++
  const ed = props.editor
  ed.off('selectionUpdate', syncCursor)
  ed.off('focus', syncCursor)
  ed.off('blur', syncCursor)
})

function openLightbox() {
  if (svg.value) lightbox.value = true
}
</script>

<template>
  <NodeViewWrapper
    class="diagram-code"
    :class="{ 'as-diagram': showDiagram, 'as-source': !showDiagram }"
    :data-diagram="kind || ''"
  >
    <!-- 图态才有顶栏：来源标记 + 切回源码 -->
    <div v-if="kind && !showSource" class="dcb-head">
      <span class="dcb-lang">{{ kind === 'mermaid' ? 'Mermaid' : 'PlantUML' }}</span>
      <button class="dcb-btn" type="button" title="编辑源码" @click="editSource">编辑源码</button>
    </div>

    <!-- 源码态：真正可编辑的代码块 -->
    <pre v-show="showSource || !kind" class="dcb-src"><NodeViewContent as="code" /></pre>

    <!-- 图态 -->
    <div v-if="kind && !showSource" class="dcb-canvas">
      <div v-if="loading" class="dcb-tip">渲染中…</div>
      <div v-else-if="err" class="dcb-error">
        <b>⚠ 图渲染失败</b>
        <span>{{ err }}</span>
        <button class="dcb-btn" type="button" @click="editSource">查看源码</button>
      </div>
      <div
        v-else-if="svg"
        class="dcb-svg"
        :title="kind === 'mermaid' ? 'Mermaid 图 · 点击放大' : 'PlantUML 图 · 点击放大'"
        @click="openLightbox"
        v-html="svg"
      />
    </div>
    <div v-else-if="kind" class="dcb-head dcb-head-src">
      <span class="dcb-lang">{{ kind === 'mermaid' ? 'Mermaid' : 'PlantUML' }}</span>
      <button class="dcb-btn" type="button" title="渲染成图" @click="showPreview">预览图</button>
    </div>

    <DiagramLightbox
      v-if="lightbox"
      :svg="svg"
      :title="kind === 'mermaid' ? 'Mermaid 图' : 'PlantUML 图'"
      @close="lightbox = false"
    />
  </NodeViewWrapper>
</template>

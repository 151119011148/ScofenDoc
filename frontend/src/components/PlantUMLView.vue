<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import plantumlEncoder from 'plantuml-encoder'
import DiagramLightbox from './DiagramLightbox.vue'

/**
 * PlantUML 渲染视图：把源码 deflate+encode 成 kroki.io URL，请求 SVG 渲染。
 * 失败时降级为原始源码，方便用户看到问题。
 *
 * kroki 支持 plantuml（含时序/类/用例/活动图等）。若部署环境需要内网自建，
 * 把 KROKI_BASE 换成自建 plantuml-server 地址即可，其余逻辑不变。
 */
const KROKI_BASE = 'https://kroki.io/plantuml/svg/'

const props = defineProps<NodeViewProps>()
const svg = ref('')
const err = ref('')
const loading = ref(false)
const lightbox = ref(false)

function encode(src: string): string {
  return plantumlEncoder.encode(src)
}

async function draw(src?: string) {
  const code = (src || '').trim()
  err.value = ''
  svg.value = ''
  if (!code) return

  loading.value = true
  try {
    const url = KROKI_BASE + encode(code)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`kroki 返回 ${res.status}`)
    }
    const text = await res.text()
    // kroki 渲染失败时会返回纯文本错误，而不是 svg
    if (!text.trim().startsWith('<svg')) {
      throw new Error(text.trim().slice(0, 200))
    }
    svg.value = text
  } catch (e: any) {
    err.value = e?.message || String(e)
    svg.value = ''
  } finally {
    loading.value = false
  }
}

function openLightbox() {
  if (svg.value) lightbox.value = true
}

onMounted(() => draw(props.node?.attrs?.code))
watch(
  () => props.node?.attrs?.code,
  (v) => draw(v),
)
</script>

<template>
  <NodeViewWrapper class="plantuml-block" :data-code="node?.attrs?.code || ''">
    <div v-if="loading" class="plantuml-loading">渲染中…</div>
    <div
      v-else-if="svg"
      class="plantuml-svg"
      title="点击放大查看"
      @click="openLightbox"
      v-html="svg"
    />
    <pre v-else-if="err" class="plantuml-error"><code>{{ node?.attrs?.code }}

⚠ {{ err }}</code></pre>
    <pre v-else class="plantuml-source"><code>{{ node?.attrs?.code }}</code></pre>

    <DiagramLightbox
      v-if="lightbox"
      :svg="svg"
      title="PlantUML 图"
      @close="lightbox = false"
    />
  </NodeViewWrapper>
</template>

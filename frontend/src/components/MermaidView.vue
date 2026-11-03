<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import mermaid from 'mermaid'

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

const props = defineProps<NodeViewProps>()
const svg = ref('')
const err = ref('')

async function draw(src?: string) {
  ensureInit()
  const code = (src || '').trim()
  err.value = ''
  if (!code) {
    svg.value = ''
    return
  }
  const id = 'mmd-' + Math.random().toString(36).slice(2, 10)
  try {
    const res = await mermaid.render(id, code)
    svg.value = res.svg
  } catch (e: any) {
    err.value = e?.message || String(e)
    svg.value = ''
  }
}

onMounted(() => draw(props.node?.attrs?.code))
watch(
  () => props.node?.attrs?.code,
  (v) => draw(v),
)
</script>

<template>
  <NodeViewWrapper class="mermaid-block" :data-code="node?.attrs?.code || ''">
    <div v-if="svg" class="mermaid-svg" v-html="svg" />
    <pre v-else-if="err" class="mermaid-error"><code>{{ node?.attrs?.code }}

⚠ {{ err }}</code></pre>
    <pre v-else class="mermaid-source"><code>{{ node?.attrs?.code }}</code></pre>
  </NodeViewWrapper>
</template>

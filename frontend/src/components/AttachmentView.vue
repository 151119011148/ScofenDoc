<script setup lang="ts">
import { computed, ref } from 'vue'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3'
import { api } from '../api'

const props = defineProps<NodeViewProps>()

const downloading = ref(false)
const error = ref('')

const id = computed(() => Number(props.node.attrs.id) || 0)
const name = computed(() => String(props.node.attrs.name || '附件'))
const size = computed(() => Number(props.node.attrs.size) || 0)

/** 按扩展名给一个能表意的图标和配色，不用引入图标库 */
const kind = computed(() => {
  const ext = name.value.includes('.') ? name.value.split('.').pop()!.toLowerCase() : ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return { icon: '🖼', cls: 'img' }
  if (['pdf'].includes(ext)) return { icon: '📕', cls: 'pdf' }
  if (['doc', 'docx'].includes(ext)) return { icon: '📘', cls: 'word' }
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { icon: '📗', cls: 'excel' }
  if (['ppt', 'pptx'].includes(ext)) return { icon: '📙', cls: 'ppt' }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: '🗜', cls: 'zip' }
  if (['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml'].includes(ext)) return { icon: '📄', cls: 'text' }
  return { icon: '📎', cls: 'other' }
})

/** 人类可读大小 */
const sizeText = computed(() => {
  const n = size.value
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
})

async function download() {
  if (!id.value || downloading.value) return
  downloading.value = true
  error.value = ''
  try {
    await api.downloadAttachment(id.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '下载失败'
    window.setTimeout(() => (error.value = ''), 4000)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <NodeViewWrapper class="attachment-wrap" data-attachment-card>
    <div class="attachment-card" :class="`kind-${kind.cls}`">
      <span class="att-icon">{{ kind.icon }}</span>
      <div class="att-meta">
        <div class="att-name" :title="name">{{ name }}</div>
        <div class="att-sub">{{ sizeText || '附件' }}<span v-if="error" class="att-err"> · {{ error }}</span></div>
      </div>
      <button
        class="att-download"
        :disabled="downloading || !id"
        :title="downloading ? '下载中…' : '下载附件'"
        @click.stop="download"
      >{{ downloading ? '…' : '⭳ 下载' }}</button>
    </div>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { relativeTime } from '../format'
import type { DocHit } from '../api'

/**
 * 文档条目列表（主页「最近更新」与搜索共用）。
 * 搜索是跨空间的，所以每行都带上空间名 —— 否则同名文档根本分不清在哪。
 */
const props = defineProps<{
  hits: DocHit[]
  /** 关键词命中时高亮 */
  keyword?: string
}>()

const emit = defineEmits<{ (e: 'open', hit: DocHit): void }>()

/**
 * 把任意文本按关键词切成多段供 <mark> 高亮。
 * 标题和正文摘要共用：摘要里关键词可能出现多次，只切第一处会漏掉后面的命中。
 */
function parts(text: string): { text: string; hit: boolean }[] {
  const kw = (props.keyword ?? '').trim()
  if (!kw || !text) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const needle = kw.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let cursor = 0
  let at = lower.indexOf(needle)
  while (at >= 0) {
    if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false })
    out.push({ text: text.slice(at, at + kw.length), hit: true })
    cursor = at + kw.length
    at = lower.indexOf(needle, cursor)
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out.length ? out : [{ text, hit: false }]
}
</script>

<template>
  <div class="hit-list">
    <button v-for="hit in props.hits" :key="hit.id" class="hit-row" @click="emit('open', hit)">
      <span class="hit-icon">📄</span>
      <span class="hit-main">
        <span class="hit-title">
          <span v-if="hit.number" class="doc-no hit-no">{{ hit.number }}</span>
          <template v-for="(seg, i) in parts(hit.title)" :key="i">
            <mark v-if="seg.hit">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
        <span v-if="hit.snippet" class="hit-snippet">
          <template v-for="(seg, i) in parts(hit.snippet)" :key="i">
            <mark v-if="seg.hit">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
        <span class="hit-meta">
          {{ hit.workspaceName }}
          <span v-if="hit.snippet" class="hit-src">正文命中</span>
        </span>
      </span>
      <span class="hit-time">{{ relativeTime(hit.updatedAt) }}</span>
    </button>
  </div>
</template>

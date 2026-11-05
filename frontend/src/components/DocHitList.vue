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

/** 把标题按关键词切成 [前, 命中, 后] 三段用于高亮 */
function segments(title: string): { text: string; hit: boolean }[] {
  const kw = (props.keyword ?? '').trim()
  if (!kw) return [{ text: title, hit: false }]
  const at = title.toLowerCase().indexOf(kw.toLowerCase())
  if (at < 0) return [{ text: title, hit: false }]
  return [
    { text: title.slice(0, at), hit: false },
    { text: title.slice(at, at + kw.length), hit: true },
    { text: title.slice(at + kw.length), hit: false },
  ].filter((s) => s.text.length > 0)
}
</script>

<template>
  <div class="hit-list">
    <button v-for="hit in props.hits" :key="hit.id" class="hit-row" @click="emit('open', hit)">
      <span class="hit-icon">📄</span>
      <span class="hit-main">
        <span class="hit-title">
          <span v-if="hit.number" class="doc-no hit-no">{{ hit.number }}</span>
          <template v-for="(seg, i) in segments(hit.title)" :key="i">
            <mark v-if="seg.hit">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
        <span class="hit-meta">{{ hit.workspaceName }}</span>
      </span>
      <span class="hit-time">{{ relativeTime(hit.updatedAt) }}</span>
    </button>
  </div>
</template>

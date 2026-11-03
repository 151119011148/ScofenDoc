<script setup lang="ts">
import DocHitList from './DocHitList.vue'
import type { DocHit } from '../api'

/**
 * 搜索结果视图。搜索框在导航栏，结果显示在正文区 ——
 * 这样搜到一半还能继续看结果，不会被弹窗挡住。
 */
const props = defineProps<{
  keyword: string
  hits: DocHit[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'open', hit: DocHit): void
  (e: 'clear'): void
}>()
</script>

<template>
  <div class="search-view">
    <div class="search-head">
      <h2>搜索「{{ props.keyword }}」</h2>
      <span class="search-count">
        {{ props.loading ? '搜索中…' : `共 ${props.hits.length} 条结果` }}
      </span>
      <button class="search-clear" @click="emit('clear')">退出搜索</button>
    </div>

    <div v-if="props.loading" class="home-empty">搜索中…</div>
    <DocHitList v-else-if="props.hits.length" :hits="props.hits" :keyword="props.keyword" @open="emit('open', $event)" />
    <div v-else class="home-empty">没有匹配的文档，换个关键词试试</div>

    <p class="search-tip">只搜索文档标题（正文是协同编辑的二进制态，暂未建全文索引）</p>
  </div>
</template>

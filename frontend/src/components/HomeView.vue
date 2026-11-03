<script setup lang="ts">
import { computed } from 'vue'
import DocHitList from './DocHitList.vue'
import { greeting } from '../format'
import type { DocHit, User, Workspace } from '../api'

/**
 * 主页。信息密度刻意压得比较低：
 * 一句问候 + 三个数字 + 最近更新，不堆图表。
 * 这里的数据全部来自 /api/docs/search（q 为空 = 最近更新），不需要额外接口。
 */
const props = defineProps<{
  user: User
  workspaces: Workspace[]
  hits: DocHit[]
  loading: boolean
  /** 当前空间里的文档数（主页没有全局统计接口，用这个更诚实） */
  currentDocCount: number
}>()

const emit = defineEmits<{
  (e: 'open', hit: DocHit): void
  (e: 'new-space', kind: 'DOC' | 'KB'): void
}>()

const docSpaces = computed(() => props.workspaces.filter((w) => w.kind === 'DOC'))
const kbSpaces = computed(() => props.workspaces.filter((w) => w.kind === 'KB'))
</script>

<template>
  <div class="home">
    <div class="home-hero">
      <h1>{{ greeting() }}，{{ props.user.displayName }}</h1>
      <p>今天想写点什么？从左侧选一篇文档，或者在文档库里新建一篇。</p>
    </div>

    <div class="home-stats">
      <div class="stat-card">
        <span class="stat-num">{{ docSpaces.length }}</span>
        <span class="stat-label">个文档库</span>
      </div>
      <div class="stat-card">
        <span class="stat-num">{{ kbSpaces.length }}</span>
        <span class="stat-label">个知识库</span>
      </div>
      <div class="stat-card">
        <span class="stat-num">{{ props.currentDocCount }}</span>
        <span class="stat-label">篇文档（当前空间）</span>
      </div>
    </div>

    <section class="home-section">
      <div class="home-section-head">
        <h2>最近更新</h2>
        <span class="home-section-hint">按最后编辑时间排序</span>
      </div>
      <div v-if="props.loading" class="home-empty">加载中…</div>
      <DocHitList v-else-if="props.hits.length" :hits="props.hits" @open="emit('open', $event)" />
      <div v-else class="home-empty">还没有文档，先建一个文档库吧</div>
    </section>

    <section class="home-section">
      <div class="home-section-head">
        <h2>快速开始</h2>
      </div>
      <div class="home-actions">
        <button class="home-action" @click="emit('new-space', 'DOC')">
          <b>📚 新建文档库</b>
          <em>日常文档，按空间组织</em>
        </button>
        <button class="home-action" @click="emit('new-space', 'KB')">
          <b>🧠 新建知识库</b>
          <em>沉淀长期内容，独立入口</em>
        </button>
      </div>
    </section>
  </div>
</template>

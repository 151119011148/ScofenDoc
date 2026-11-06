<script setup lang="ts">
/**
 * 文档树折叠三角的本地冒烟页（只被 Vite dev 加载，不进生产产物、不连后端）。
 * 验收脚本：tools/verify-browser/tree-caret-check.mjs
 *
 * 要验的就是「和文章大纲一致」：蓝色三角、悬停才出现、收起后常驻、出现时不挤标题。
 */
import { ref } from 'vue'
import type { Doc } from './api'
import DocTree from './components/DocTree.vue'

const base = { workspaceId: 1, collabKey: 'k', updatedAt: '2026-01-01T00:00:00Z' }

const docs = ref<Doc[]>([
  { ...base, id: 1, parentId: null, title: '第一章 总览', number: '1', sortOrder: 1 },
  { ...base, id: 2, parentId: 1, title: '小节 A', number: '1.1', sortOrder: 1 },
  { ...base, id: 3, parentId: 2, title: '细节 a1', number: '1.1.1', sortOrder: 1 },
  { ...base, id: 4, parentId: 2, title: '细节 a2', number: '1.1.2', sortOrder: 2 },
  { ...base, id: 5, parentId: 1, title: '小节 B', number: '1.2', sortOrder: 2 },
  { ...base, id: 6, parentId: null, title: '第二章 设计', number: '2', sortOrder: 2 },
])

const currentId = ref<number | null>(1)

function onSelect(d: Doc) {
  currentId.value = d.id
}
</script>

<template>
  <div class="smoke-shell">
    <div class="smoke-side nav-tree">
      <DocTree :docs="docs" :current-id="currentId" @select="onSelect" />
    </div>
    <div class="smoke-main">
      <p>左侧是真实的 <code>DocTree</code> 组件（假数据）。悬停行看三角、点三角折叠。</p>
    </div>
  </div>
</template>

<style scoped>
.smoke-shell {
  display: flex;
  height: 100vh;
  background: #fff;
}
.smoke-side {
  width: 240px;
  flex: 0 0 240px;
  border-right: 1px solid var(--line);
  padding: 8px 0;
  overflow: auto;
}
.smoke-main {
  padding: 24px;
  font-size: 13px;
  color: var(--text-2);
}
</style>

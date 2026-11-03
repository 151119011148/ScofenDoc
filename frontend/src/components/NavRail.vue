<script setup lang="ts">
import { ref } from 'vue'
import type { User } from '../api'

/**
 * 最左侧导航栏。
 *
 * 定位是「产品级入口」：主页 / 文档库 / 知识库 + 全局搜索。
 * 具体的空间与文档树不在这一层 —— 那是中间那栏的事，
 * 分层清楚了，以后加"回收站""模板中心"这类入口才有地方放。
 */
const props = defineProps<{
  active: 'home' | 'docs' | 'kb'
  user: User
  /** 搜索框内容（受控，App 持有真实状态，便于跨组件清空） */
  search: string
  /** 文档库 / 知识库各有几个空间，右上角显示数字 */
  docCount: number
  kbCount: number
}>()

const emit = defineEmits<{
  (e: 'navigate', target: 'home' | 'docs' | 'kb'): void
  (e: 'search', value: string): void
  (e: 'change-password'): void
  (e: 'admin-users'): void
  (e: 'logout'): void
}>()

const searchEl = ref<HTMLInputElement>()

/** 供 App 在按下 Ctrl+K 时把焦点丢进搜索框 */
defineExpose({ focusSearch: () => searchEl.value?.focus() })

const NAV_ITEMS = [
  { key: 'home', label: '主页', icon: '🏠' },
  { key: 'docs', label: '文档库', icon: '📚' },
  { key: 'kb', label: '知识库', icon: '🧠' },
] as const
</script>

<template>
  <aside class="nav-rail">
    <div class="nav-brand">
      <span class="nav-logo">📄</span>
      <span class="nav-brand-name">scofenDoc</span>
    </div>

    <div class="nav-search">
      <span class="nav-search-icon">🔍</span>
      <input
        ref="searchEl"
        :value="props.search"
        placeholder="搜索文档"
        @input="emit('search', ($event.target as HTMLInputElement).value)"
        @keyup.esc="emit('search', '')"
      />
      <kbd v-if="!props.search" class="nav-kbd">Ctrl K</kbd>
      <button v-else class="nav-search-clear" title="清空" @click="emit('search', '')">✕</button>
    </div>

    <nav class="nav-menu">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.key"
        :class="['nav-item', { on: props.active === item.key }]"
        @click="emit('navigate', item.key)"
      >
        <span class="nav-item-icon">{{ item.icon }}</span>
        <span class="nav-item-label">{{ item.label }}</span>
        <span v-if="item.key === 'docs' && props.docCount" class="nav-count">{{ props.docCount }}</span>
        <span v-else-if="item.key === 'kb' && props.kbCount" class="nav-count">{{ props.kbCount }}</span>
      </button>
    </nav>

    <div class="nav-foot">
      <div class="nav-user">
        <span class="nav-avatar" :style="{ background: props.user.color }">
          {{ props.user.displayName.slice(0, 1) }}
        </span>
        <span class="nav-user-name">
          {{ props.user.displayName }}
          <em v-if="props.user.admin">管理员</em>
        </span>
      </div>
      <div class="nav-user-actions">
        <button v-if="props.user.admin" @click="emit('admin-users')">账号</button>
        <button @click="emit('change-password')">改密</button>
        <button @click="emit('logout')">退出</button>
      </div>
    </div>
  </aside>
</template>

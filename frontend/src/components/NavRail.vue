<script setup lang="ts">
import { computed, ref } from 'vue'
import type { User, Workspace } from '../api'

/**
 * 最左侧导航栏（对齐飞书文档的左侧栏）。
 *
 * 结构化分成两段：
 *   上段固定 —— 主页 / 文档库 / 知识库 三个入口，永远可见；
 *   下段滚动 —— 当前分类下的空间列表，当前空间再往下挂它的文档树。
 *
 * 这样即使某棵树的章节多到几十条，也不会把「知识库」顶出屏幕。
 * 文档树本身由 App 通过 #tree 插槽塞进来，本组件不关心树的实现。
 */
type NavKey = 'home' | 'docs' | 'kb'

const props = defineProps<{
  active: NavKey
  user: User
  /** 搜索框内容（受控，App 持有真实状态，便于跨组件清空） */
  search: string
  /** 全部空间，组件内部按 kind 分组 */
  spaces: Workspace[]
  currentSpaceId: number | null
  collapsed: boolean
  /** 移动端抽屉模式：收起按钮变成关闭，不再做「折叠成窄条」 */
  drawer?: boolean
}>()

const emit = defineEmits<{
  (e: 'navigate', target: NavKey): void
  (e: 'select-space', space: Workspace): void
  (e: 'new-space', kind: 'DOC' | 'KB'): void
  (e: 'open-members', space: Workspace): void
  (e: 'toggle-collapse'): void
  (e: 'search', value: string): void
  (e: 'change-password'): void
  (e: 'admin-users'): void
  (e: 'logout'): void
}>()

const searchEl = ref<HTMLInputElement>()

/** 供 App 在按下 Ctrl+K 时把焦点丢进搜索框 */
defineExpose({ focusSearch: () => searchEl.value?.focus() })

const docSpaces = computed(() => props.spaces.filter((w) => w.kind === 'DOC'))
const kbSpaces = computed(() => props.spaces.filter((w) => w.kind === 'KB'))

const NAV_ITEMS = computed(() => [
  { key: 'home' as const, label: '主页', icon: '🏠', count: 0, kind: null as null | 'DOC' | 'KB' },
  { key: 'docs' as const, label: '文档库', icon: '📚', count: docSpaces.value.length, kind: 'DOC' as const },
  { key: 'kb' as const, label: '知识库', icon: '🧠', count: kbSpaces.value.length, kind: 'KB' as const },
])

/**
 * 下段展示哪个分类的空间：主页时沿用「上次所在分类」，
 * 否则一回到主页侧栏就整块空掉，再点文档库又是另一套内容，来回闪。
 */
const shownKind = computed<'DOC' | 'KB'>(() => (props.active === 'kb' ? 'KB' : 'DOC'))
const shownLabel = computed(() => (shownKind.value === 'KB' ? '知识库' : '文档库'))
const shownSpaces = computed(() => (shownKind.value === 'KB' ? kbSpaces.value : docSpaces.value))
</script>

<template>
  <aside class="nav-rail" :class="{ collapsed: props.collapsed }">
    <div class="nav-brand">
      <span class="nav-logo">📄</span>
      <span class="nav-brand-name">scofenDoc</span>
      <button
        class="nav-collapse"
        :title="props.drawer ? '关闭菜单' : props.collapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="emit('toggle-collapse')"
      >
        {{ props.drawer ? '✕' : props.collapsed ? '»' : '«' }}
      </button>
    </div>

    <div v-show="!props.collapsed" class="nav-search">
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

    <!-- 上段：三个入口固定，不随文档树滚动 -->
    <nav class="nav-menu">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.key"
        :class="['nav-item', { on: props.active === item.key }]"
        :title="props.collapsed ? item.label : undefined"
        @click="emit('navigate', item.key)"
      >
        <span class="nav-item-icon">{{ item.icon }}</span>
        <span class="nav-item-label">{{ item.label }}</span>
        <span v-if="item.count" class="nav-count">{{ item.count }}</span>
        <!-- 按钮里不能再放按钮（HTML 不合法），这里用 span 承担点击 -->
        <span
          v-if="item.kind && !props.collapsed"
          class="nav-plus"
          role="button"
          :title="`新建${item.label}`"
          @click.stop="emit('new-space', item.kind)"
        >
          ＋
        </span>
      </button>
    </nav>

    <!-- 下段：空间列表 + 当前空间的文档树 -->
    <div v-show="!props.collapsed" class="nav-scroll">
      <div v-if="shownSpaces.length === 0" class="nav-empty">还没有{{ shownLabel }}</div>

      <div
        v-for="w in shownSpaces"
        :key="w.id"
        class="nav-space"
        :class="{ 'has-tree': w.id === props.currentSpaceId }"
      >
        <div
          class="space-item"
          :class="{ active: w.id === props.currentSpaceId }"
          @click="emit('select-space', w)"
        >
          <span class="space-icon">{{ w.type === 'PERSONAL' ? '👤' : '👥' }}</span>
          <span class="space-name">{{ w.name }}</span>

          <!-- 共享空间：直接露出人数，点进去管成员 -->
          <button
            v-if="w.type === 'TEAM'"
            class="space-members"
            :title="w.role === 'OWNER' ? '管理成员' : '查看成员'"
            @click.stop="emit('open-members', w)"
          >
            {{ w.memberCount }}
          </button>
          <span v-if="w.role === 'VIEWER'" class="space-role">只读</span>
        </div>

        <!-- 只给当前空间挂文档树：同时展开多个空间的树会挤成一团 -->
        <div v-if="w.id === props.currentSpaceId" class="nav-tree">
          <slot name="tree" />
        </div>
      </div>
    </div>

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

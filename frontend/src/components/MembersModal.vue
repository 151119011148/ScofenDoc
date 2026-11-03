<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, type Member, type Role, type Workspace } from '../api'

/**
 * 成员管理。
 *
 * 邀请是「按用户名」而不是发邮件/生成邀请链接：本实例注册是关闭的，
 * 账号由管理员创建，用户名是双方都知道的稳定标识，不需要再引入邮件通道。
 *
 * 成员列表所有成员都能看（协作时知道有谁在），但改角色/移除只对所有者开放，
 * 且「所有者」这一行永远不可改、不可移除 —— 否则空间会变成没人管的状态。
 */
const props = defineProps<{
  workspace: Workspace
  currentUserId: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 成员增减后通知外层刷新空间列表上的“共 N 人” */
  (e: 'changed'): void
}>()

const members = ref<Member[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')

const inviteName = ref('')
const inviteRole = ref<Exclude<Role, 'OWNER'>>('EDITOR')
const inviting = ref(false)

const canManage = computed(() => props.workspace.role === 'OWNER')

const ROLE_LABEL: Record<Role, string> = {
  OWNER: '所有者',
  EDITOR: '可编辑',
  VIEWER: '仅查看',
}

async function load() {
  loading.value = true
  try {
    members.value = await api.listMembers(props.workspace.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function invite() {
  const name = inviteName.value.trim()
  if (!name) {
    error.value = '请输入对方的用户名'
    return
  }
  inviting.value = true
  error.value = ''
  notice.value = ''
  try {
    await api.inviteMember(props.workspace.id, name, inviteRole.value)
    inviteName.value = ''
    notice.value = `已把 ${name} 加入空间`
    await load()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    inviting.value = false
  }
}

async function changeRole(member: Member, role: Exclude<Role, 'OWNER'>) {
  if (member.role === role) return
  try {
    await api.changeMemberRole(props.workspace.id, member.userId, role)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    await load()
  }
}

async function remove(member: Member) {
  if (!confirm(`把「${member.displayName}」移出空间？他将立即失去该空间内所有文档的访问权限。`)) {
    return
  }
  try {
    await api.removeMember(props.workspace.id, member.userId)
    notice.value = `已移除 ${member.displayName}`
    await load()
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)
</script>

<template>
  <ModalShell
    :title="`成员 · ${workspace.name}`"
    subtitle="成员按角色获得权限：可编辑能改文档，仅查看只能看"
    :width="520"
    @close="emit('close')"
  >
    <!-- 邀请：只有所有者能看到 -->
    <div v-if="canManage" class="invite">
      <input
        v-model="inviteName"
        placeholder="输入对方用户名"
        @keyup.enter="invite"
      />
      <select v-model="inviteRole">
        <option value="EDITOR">可编辑</option>
        <option value="VIEWER">仅查看</option>
      </select>
      <button class="btn primary small" type="button" :disabled="inviting" @click="invite">
        {{ inviting ? '邀请中…' : '邀请' }}
      </button>
    </div>
    <p v-else class="invite-tip">只有空间所有者可以邀请或移除成员。</p>

    <p v-if="error" class="form-error">{{ error }}</p>
    <p v-if="notice" class="form-notice">{{ notice }}</p>

    <div v-if="loading" class="member-empty">加载中…</div>
    <div v-else class="member-list">
      <div v-for="m in members" :key="m.userId" class="member-row">
        <span class="member-avatar" :style="{ background: m.color }">
          {{ m.displayName.slice(0, 1) }}
        </span>
        <div class="member-main">
          <div class="member-name">
            {{ m.displayName }}
            <span v-if="m.userId === currentUserId" class="tag-me">我</span>
          </div>
          <div class="member-username">@{{ m.username }}</div>
        </div>

        <template v-if="canManage && m.role !== 'OWNER'">
          <select
            :value="m.role"
            @change="changeRole(m, ($event.target as HTMLSelectElement).value as 'EDITOR' | 'VIEWER')"
          >
            <option value="EDITOR">可编辑</option>
            <option value="VIEWER">仅查看</option>
          </select>
          <button class="icon-btn danger" type="button" title="移出空间" @click="remove(m)">✕</button>
        </template>
        <span v-else :class="['role-badge', m.role.toLowerCase()]">{{ ROLE_LABEL[m.role] }}</span>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost" type="button" @click="emit('close')">关闭</button>
    </template>
  </ModalShell>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, type User } from '../api'

/**
 * 账号管理（仅管理员）。
 *
 * 注册关闭之后，这里是唯一的开号入口，所以它同时承担了
 * 「建号 + 重置密码 + 授予管理员」三件事。
 *
 * 自己那一行不允许取消管理员：后端也拦了，前端先禁用，
 * 免得好心点下去再收到 400。
 */
const props = defineProps<{ currentUserId: number }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const users = ref<User[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')

const username = ref('')
const displayName = ref('')
const password = ref('')
const makeAdmin = ref(false)
const creating = ref(false)

async function load() {
  loading.value = true
  try {
    users.value = await api.adminUsers()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function create() {
  error.value = ''
  notice.value = ''
  if (!username.value.trim()) {
    error.value = '请填写用户名'
    return
  }
  if (password.value.length < 6) {
    error.value = '初始密码至少 6 位'
    return
  }
  creating.value = true
  try {
    const u = await api.adminCreateUser({
      username: username.value.trim(),
      password: password.value,
      displayName: displayName.value.trim() || undefined,
      admin: makeAdmin.value,
    })
    notice.value = `已创建账号 ${u.username}，请把初始密码告知对方`
    username.value = ''
    displayName.value = ''
    password.value = ''
    makeAdmin.value = false
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

async function resetPassword(u: User) {
  const pwd = prompt(`给「${u.displayName}」设置新密码（至少 6 位）`)
  if (!pwd) return
  if (pwd.length < 6) {
    error.value = '密码至少 6 位'
    return
  }
  try {
    await api.adminResetPassword(u.id, pwd)
    notice.value = `已重置 ${u.displayName} 的密码，其当前登录已失效`
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function toggleAdmin(u: User) {
  const next = !u.admin
  if (!next && !confirm(`取消「${u.displayName}」的管理员权限？`)) return
  try {
    await api.adminSetAdmin(u.id, next)
    await load()
    notice.value = next ? `已授予 ${u.displayName} 管理员` : `已取消 ${u.displayName} 的管理员`
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(load)
</script>

<template>
  <ModalShell
    title="账号管理"
    subtitle="本实例已关闭自助注册，新成员请在这里创建"
    :width="560"
    @close="emit('close')"
  >
    <div class="admin-create">
      <div class="admin-create-title">创建账号</div>
      <div class="admin-create-row">
        <input v-model="username" placeholder="用户名（登录名）" />
        <input v-model="displayName" placeholder="昵称（可选）" />
      </div>
      <div class="admin-create-row">
        <input v-model="password" type="password" placeholder="初始密码（至少 6 位）" />
        <label class="checkbox">
          <input v-model="makeAdmin" type="checkbox" />
          <span>设为管理员</span>
        </label>
        <button class="btn primary small" type="button" :disabled="creating" @click="create">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="form-error">{{ error }}</p>
    <p v-if="notice" class="form-notice">{{ notice }}</p>

    <div v-if="loading" class="member-empty">加载中…</div>
    <div v-else class="member-list">
      <div v-for="u in users" :key="u.id" class="member-row">
        <span class="member-avatar" :style="{ background: u.color }">
          {{ u.displayName.slice(0, 1) }}
        </span>
        <div class="member-main">
          <div class="member-name">
            {{ u.displayName }}
            <span v-if="u.admin" class="role-badge owner">管理员</span>
            <span v-if="u.id === props.currentUserId" class="tag-me">我</span>
          </div>
          <div class="member-username">@{{ u.username }}</div>
        </div>
        <button class="btn ghost small" type="button" @click="resetPassword(u)">重置密码</button>
        <button
          class="btn ghost small"
          type="button"
          :disabled="u.id === props.currentUserId"
          :title="u.id === props.currentUserId ? '不能取消自己的管理员权限' : ''"
          @click="toggleAdmin(u)"
        >
          {{ u.admin ? '取消管理员' : '设为管理员' }}
        </button>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost" type="button" @click="emit('close')">关闭</button>
    </template>
  </ModalShell>
</template>

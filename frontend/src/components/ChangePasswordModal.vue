<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, saveSession, type Session } from '../api'

/**
 * 修改密码。
 *
 * 改完后端会把 tokenVersion +1，并返回一个新 token：
 *   - 当前设备用新 token 继续，不会把自己踢掉；
 *   - 其它设备上的旧 token 立刻失效 —— 这正是改密的实际意义。
 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated', session: Session): void
}>()

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  if (!oldPassword.value) {
    error.value = '请输入原密码'
    return
  }
  if (newPassword.value.length < 6) {
    error.value = '新密码至少 6 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  if (newPassword.value === oldPassword.value) {
    error.value = '新密码不能与原密码相同'
    return
  }

  busy.value = true
  try {
    const session = await api.changePassword(oldPassword.value, newPassword.value)
    saveSession(session)
    emit('updated', session)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ModalShell
    title="修改密码"
    subtitle="改完后其它设备上的登录会立即失效，需要重新登录"
    :width="420"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span>原密码</span>
        <input v-model="oldPassword" type="password" autocomplete="current-password" />
      </label>
      <label class="field">
        <span>新密码</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          placeholder="至少 6 位"
        />
      </label>
      <label class="field">
        <span>确认新密码</span>
        <input v-model="confirmPassword" type="password" autocomplete="new-password" />
      </label>
      <p v-if="error" class="form-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="btn ghost" type="button" @click="emit('close')">取消</button>
      <button class="btn primary" type="button" :disabled="busy" @click="submit">
        {{ busy ? '提交中…' : '确认修改' }}
      </button>
    </template>
  </ModalShell>
</template>

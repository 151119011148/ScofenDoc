<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, saveSession, type AuthConfig, type Session } from '../api'

const emit = defineEmits<{ (e: 'success', session: Session): void }>()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const displayName = ref('')
const busy = ref(false)
const error = ref('')

/**
 * 实例注册策略。
 *
 * 默认按「允许注册」渲染，等服务端结果回来再收口：
 * 如果反过来默认关闭，后端万一慢或请求失败，用户会以为这台实例不能注册。
 */
const config = ref<AuthConfig>({ registrationOpen: true, hasUsers: false, registrationMode: 'closed' })

const bootstrap = ref(false)

onMounted(async () => {
  try {
    const c = await api.authConfig()
    config.value = c
    bootstrap.value = c.registrationOpen && !c.hasUsers
    if (!c.registrationOpen) mode.value = 'login'
  } catch {
    /* 拿不到策略就保持允许注册，交给提交时的真实错误兜底 */
  }
})

function switchMode(next: 'login' | 'register') {
  if (next === 'register' && !config.value.registrationOpen) return
  mode.value = next
  error.value = ''
}

async function submit() {
  if (busy.value) return
  const u = username.value.trim()
  const p = password.value
  if (!u || !p) {
    error.value = '请填写用户名和密码'
    return
  }
  if (mode.value === 'register' && p.length < 6) {
    error.value = '密码至少 6 位'
    return
  }

  busy.value = true
  error.value = ''
  try {
    const session =
      mode.value === 'login'
        ? await api.login(u, p)
        : await api.register(u, p, displayName.value.trim() || undefined)
    saveSession(session)
    emit('success', session)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="auth">
    <div class="auth-card">
      <div class="auth-brand">
        <span class="auth-logo">📄</span>
        <h1>轻量协同文档</h1>
        <p class="auth-sub">自托管的多人实时协作文档</p>
      </div>

      <!-- 只有一个 tab 时整条隐藏：一个拉满宽度的"登录"按钮更像按钮，不像标签页 -->
      <div v-if="config.registrationOpen" class="auth-tabs">
        <button :class="{ on: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button :class="{ on: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <label>
          <span>用户名</span>
          <input v-model="username" autocomplete="username" placeholder="登录名" />
        </label>

        <label v-if="mode === 'register'">
          <span>昵称<em>（显示在协同光标上，可不填）</em></span>
          <input v-model="displayName" placeholder="例如：高锋" />
        </label>

        <label>
          <span>密码</span>
          <input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 6 位"
          />
        </label>

        <p v-if="error" class="auth-error">{{ error }}</p>

        <button class="auth-submit" type="submit" :disabled="busy">
          {{ busy ? '处理中…' : mode === 'login' ? '登录' : '注册并进入' }}
        </button>
      </form>

      <p class="auth-tip">
        <template v-if="bootstrap">
          这是本实例的第一个账号：注册后自动成为<strong>管理员</strong>，
          并接管已有的空间与文档。之后注册入口会自动关闭，新成员由管理员创建。
        </template>
        <template v-else-if="!config.registrationOpen">
          本实例已关闭自助注册，请使用管理员为你创建的账号登录。<br />
          忘记密码可联系管理员重置。
        </template>
        <template v-else>
          注册开放中：新注册的账号各自独立，互相看不到对方的空间。
        </template>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, type Workspace } from '../api'

/**
 * 新建空间。
 *
 * 「个人空间 / 团队空间」这个选择必须在建的时候就定——
 * 它决定这个空间能不能被共享（成员接口只对 TEAM 生效），
 * 建完再改类型会让"已经分享出去的文档"语义变得含糊。
 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', workspace: Workspace): void
}>()

const name = ref('')
const type = ref<'PERSONAL' | 'TEAM'>('PERSONAL')
const busy = ref(false)
const error = ref('')

async function submit() {
  const n = name.value.trim()
  if (!n) {
    error.value = '请填写空间名称'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const ws = await api.createWorkspace(n, type.value)
    emit('created', ws)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ModalShell title="新建空间" subtitle="个人空间只有你自己；团队空间可邀请成员共享" :width="460" @close="emit('close')">
    <div class="form">
      <label class="field">
        <span>空间名称</span>
        <input v-model="name" placeholder="例如：产品组 / 我的笔记" @keyup.enter="submit" />
      </label>

      <div class="field">
        <span>类型</span>
        <div class="type-options">
          <button
            type="button"
            :class="['type-card', { on: type === 'PERSONAL' }]"
            @click="type = 'PERSONAL'"
          >
            <b>👤 个人空间</b>
            <em>仅自己可见，不可共享</em>
          </button>
          <button
            type="button"
            :class="['type-card', { on: type === 'TEAM' }]"
            @click="type = 'TEAM'"
          >
            <b>👥 团队空间</b>
            <em>可邀请成员，按角色共享</em>
          </button>
        </div>
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="btn ghost" type="button" @click="emit('close')">取消</button>
      <button class="btn primary" type="button" :disabled="busy" @click="submit">
        {{ busy ? '创建中…' : '创建' }}
      </button>
    </template>
  </ModalShell>
</template>

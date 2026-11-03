<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, type Workspace } from '../api'

/**
 * 新建空间。
 *
 * 两个维度必须建的时候定死：
 *   kind —— 文档库 / 知识库，决定它出现在哪个导航入口下；
 *   type —— 个人 / 团队，决定能不能共享（成员接口只对 TEAM 生效）。
 * 建完再改会让"已经分享出去的文档"语义变含糊，所以不做事后修改。
 */
const props = withDefaults(defineProps<{ defaultKind?: 'DOC' | 'KB' }>(), {
  defaultKind: 'DOC',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', workspace: Workspace): void
}>()

const name = ref('')
const kind = ref<'DOC' | 'KB'>(props.defaultKind)
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
    const ws = await api.createWorkspace(n, type.value, kind.value)
    emit('created', ws)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ModalShell
    :title="kind === 'KB' ? '新建知识库' : '新建文档库'"
    :subtitle="kind === 'KB' ? '知识库用于沉淀长期内容，入口在「知识库」下' : '文档库放日常文档，入口在「文档库」下'"
    :width="480"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span>名称</span>
        <input v-model="name" placeholder="例如：产品组 / 我的笔记" @keyup.enter="submit" />
      </label>

      <div class="field">
        <span>分类</span>
        <div class="type-options">
          <button
            type="button"
            :class="['type-card', { on: kind === 'DOC' }]"
            @click="kind = 'DOC'"
          >
            <b>📚 文档库</b>
            <em>日常文档，按空间组织</em>
          </button>
          <button
            type="button"
            :class="['type-card', { on: kind === 'KB' }]"
            @click="kind = 'KB'"
          >
            <b>🧠 知识库</b>
            <em>沉淀性内容，独立入口</em>
          </button>
        </div>
      </div>

      <div class="field">
        <span>协作方式</span>
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

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { api, type DocSharing, type DocShareRole, type DocVersion, type SharedDoc, type TrashEntry } from '../api'

export type GovernanceMode = 'sharing' | 'versions' | 'trash' | 'shared' | 'redeem'

const props = defineProps<{
  mode: GovernanceMode
  docId?: number
  workspaceId?: number
  canManage?: boolean
  linkToken?: string
}>()
const emit = defineEmits<{
  close: []
  open: [id: number]
  changed: [id: number]
}>()

const titles = { sharing: '文档分享', versions: '版本历史', trash: '空间回收站', shared: '分享给我的文档', redeem: '打开分享文档' }
const labels = { VIEWER: '可阅读', EDITOR: '可编辑', MANAGER: '可管理', OWNER: '所有者' }
const sharing = ref<DocSharing>()
const versions = ref<DocVersion[]>([])
const trash = ref<TrashEntry[]>([])
const shared = ref<SharedDoc[]>([])
const username = ref('')
const role = ref<DocShareRole>('VIEWER')
const hours = ref(168)
const password = ref('')
const link = ref('')
const snapshotName = ref('')
const selected = ref<DocVersion>()
const preview = ref<{ text: string; truncated: boolean }>()
const error = ref('')
const busy = ref(false)

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function load() {
  if (props.mode === 'sharing') sharing.value = await api.docSharing(props.docId!)
  if (props.mode === 'versions') versions.value = await api.docVersions(props.docId!)
  if (props.mode === 'trash') trash.value = await api.trash(props.workspaceId!)
  if (props.mode === 'shared') shared.value = await api.sharedDocs()
}

async function redeem() {
  const { id } = await api.redeemDocLink(props.linkToken!, password.value)
  emit('open', id)
}

async function grant() {
  await api.grantDoc(props.docId!, username.value, role.value)
  username.value = ''
  await load()
}

async function createLink() {
  const { token } = await api.createDocLink(props.docId!, hours.value, password.value)
  const url = new URL(location.pathname, location.origin)
  url.hash = new URLSearchParams({ share: token }).toString()
  link.value = url.href
  password.value = ''
  await load()
}

async function inspect(version: DocVersion) {
  selected.value = undefined
  preview.value = undefined
  preview.value = await api.previewVersion(props.docId!, version.id)
  selected.value = version
}

function restoreVersion() {
  if (!selected.value || !window.confirm('恢复此版本？当前内容将保留为历史版本。')) return
  const version = selected.value.id
  void run(async () => {
    await api.restoreVersion(props.docId!, version)
    emit('changed', props.docId!)
    emit('close')
  })
}

function trashAction(entry: TrashEntry, purge: boolean) {
  if (purge && !entry.cleanupPending && !window.confirm('永久删除此文档及同批删除的子文档？此操作无法撤销。')) return
  void run(async () => {
    if (purge) await api.purgeDoc(entry.id)
    else {
      await api.restoreDoc(entry.id)
      emit('changed', entry.id)
    }
    await load()
  })
}

function date(value: string) { return new Date(value).toLocaleString() }
onMounted(() => run(load))
</script>

<template>
  <ModalShell :title="titles[mode]" :width="640" @close="emit('close')">
    <div class="governance">
      <p v-if="error" class="governance-error" role="alert">{{ error }}</p>

      <template v-if="mode === 'sharing'">
        <p>文档授权叠加在空间权限上。协作者只能访问获授权的文档。</p>
        <form @submit.prevent="run(grant)">
          <input v-model="username" required placeholder="账号用户名" aria-label="账号用户名" />
          <select v-model="role" aria-label="文档权限">
            <option value="VIEWER">可阅读</option><option value="EDITOR">可编辑</option>
            <option value="MANAGER">可管理</option>
          </select>
          <button :disabled="busy">添加或更新</button>
        </form>
        <div v-for="member in sharing?.collaborators" :key="member.userId" class="governance-row">
          <span>{{ member.username }} · {{ labels[member.role] }}</span>
          <button :disabled="busy" @click="run(async () => { await api.revokeDoc(docId!, member.userId); await load() })">移除</button>
        </div>
        <h4>只读链接</h4>
        <p>打开链接需要登录。链接到期或撤销后，通过它取得的阅读权限会失效。</p>
        <form @submit.prevent="run(createLink)">
          <label>有效小时 <input v-model.number="hours" required type="number" min="1" max="720" /></label>
          <input v-model="password" type="password" placeholder="可选密码" aria-label="链接密码" autocomplete="new-password" />
          <button :disabled="busy">生成链接</button>
        </form>
        <label v-if="link">请保存新链接 <input :value="link" readonly @focus="($event.target as HTMLInputElement).select()" /></label>
        <div v-for="item in sharing?.links" :key="item.id" class="governance-row">
          <span>{{ date(item.expiresAt) }} 到期{{ item.passwordRequired ? ' · 需要密码' : '' }}</span>
          <button :disabled="busy" @click="run(async () => { await api.revokeDocLink(docId!, item.id); link = ''; await load() })">撤销</button>
        </div>
      </template>

      <form v-else-if="mode === 'redeem'" @submit.prevent="run(redeem)">
        <input v-model="password" type="password" placeholder="链接密码（如有）" aria-label="链接密码" />
        <button :disabled="busy">打开文档</button>
      </form>

      <template v-else-if="mode === 'versions'">
        <form @submit.prevent="run(async () => { await api.snapshotDoc(docId!, snapshotName); snapshotName = ''; await load() })">
          <input v-model="snapshotName" placeholder="版本名称" aria-label="版本名称" maxlength="120" required />
          <button :disabled="busy">保存当前版本</button>
        </form>
        <p v-if="!busy && !versions.length">还没有版本。</p>
        <div v-for="version in versions" :key="version.id" class="governance-row">
          <span>{{ version.name }} · {{ date(version.createdAt) }}</span>
          <button :disabled="busy" @click="run(() => inspect(version))">预览</button>
        </div>
        <div v-if="selected && preview">
          <h4>{{ selected.name }} · 正文预览</h4>
          <pre>{{ preview.text || '此版本没有可预览的文字。' }}</pre>
          <p v-if="preview.truncated">预览已截断。</p>
          <button v-if="canManage" :disabled="busy" @click="restoreVersion">恢复此版本</button>
        </div>
      </template>

      <template v-else-if="mode === 'trash'">
        <p v-if="!busy && !trash.length">回收站为空。</p>
        <div v-for="entry in trash" :key="entry.id" class="governance-row">
          <span>{{ entry.title }} · {{ date(entry.deletedAt) }}</span>
          <button v-if="!entry.cleanupPending" :disabled="busy" @click="trashAction(entry, false)">恢复</button>
          <button v-if="canManage" :disabled="busy" @click="trashAction(entry, true)">
            {{ entry.cleanupPending ? '重试清理' : '永久删除' }}
          </button>
        </div>
      </template>

      <template v-else>
        <p v-if="!busy && !shared.length">还没有直接分享给你的文档。</p>
        <div v-for="item in shared" :key="item.id" class="governance-row">
          <span>{{ item.title }} · {{ labels[item.role] }}</span>
          <button @click="emit('open', item.id)">打开</button>
        </div>
      </template>
    </div>
  </ModalShell>
</template>

<style scoped>
.governance { display: grid; gap: 10px; max-height: 65vh; overflow: auto; }
.governance form, .governance-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.governance-row { justify-content: space-between; }
.governance-row span { flex: 1 1 180px; overflow-wrap: anywhere; }
.governance input { max-width: 100%; }
.governance pre { white-space: pre-wrap; max-height: 20rem; overflow: auto; }
.governance-error { color: #bf2828; }
</style>

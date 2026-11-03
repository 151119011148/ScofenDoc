<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import CollabEditor from './components/CollabEditor.vue'
import DocTree from './components/DocTree.vue'
import OutlinePanel from './components/OutlinePanel.vue'
import LoginView from './components/LoginView.vue'
import AdminUsersModal from './components/AdminUsersModal.vue'
import ChangePasswordModal from './components/ChangePasswordModal.vue'
import CreateSpaceModal from './components/CreateSpaceModal.vue'
import MembersModal from './components/MembersModal.vue'
import {
  api,
  clearSession,
  loadSession,
  setUnauthorizedHandler,
  type Doc,
  type Session,
  type Workspace,
} from './api'

/* ---------- 会话 ---------- */
const session = ref<Session | null>(loadSession())
const loading = ref(false)
const error = ref('')

/* token 过期 / 失效时由 api 层回调，直接退回登录页 */
setUnauthorizedHandler(() => {
  session.value = null
  resetState()
})

/* ---------- 业务状态 ---------- */
const workspaces = ref<Workspace[]>([])
const currentSpaceId = ref<number | null>(null)
const docs = ref<Doc[]>([])
const currentDocId = ref<number | null>(null)
const titleDraft = ref('')
const moving = ref(false)

/** 协同 token：每次切文档重新申请，只对当前这篇有效 */
const collabToken = ref('')
const collabKeyOfToken = ref('')

/* 弹窗 */
const showCreateSpace = ref(false)
const showMembers = ref(false)
const showChangePwd = ref(false)
const showAdminUsers = ref(false)

/* 侧边栏折叠 */
const sidebarCollapsed = ref(false)

/* 大纲面板：需要拿到正文编辑器实例与滚动容器（.main），标题变化时重扫 */
const mainScroller = ref<HTMLElement | null>(null)
const outlineEditor = ref<{ view?: { dom?: HTMLElement } } | null>(null)
const outlineRefresh = ref(0)

function onEditorReady(ed: unknown) {
  outlineEditor.value = ed as { view?: { dom?: HTMLElement } } | null
  // 正文是 Yjs 协同、Tiptap 渲染，Vue 无法感知其标题变化；挂一个轻量 observer
  const dom = (ed as { view?: { dom?: HTMLElement } } | null)?.view?.dom
  if (dom) {
    const mo = new MutationObserver(() => {
      outlineRefresh.value++
    })
    mo.observe(dom, { childList: true, subtree: true, characterData: true })
  }
}

const currentDoc = computed(() => docs.value.find((d) => d.id === currentDocId.value) ?? null)
const currentSpace = computed(() => workspaces.value.find((w) => w.id === currentSpaceId.value) ?? null)

/**
 * 权限来自「我在这个空间里的角色」：
 *   VIEWER 只能看 —— 隐藏所有写入口、编辑器设为只读、禁用拖拽；
 *   OWNER / EDITOR 可写；只有 OWNER 能管成员。
 * 前端只做体验层的收敛，真正的拦截在后端 Service 层。
 */
const canWrite = computed(() => currentSpace.value?.role !== 'VIEWER')
const canManageMembers = computed(() => currentSpace.value?.role === 'OWNER')
const isTeam = computed(() => currentSpace.value?.type === 'TEAM')

const collabReady = computed(
  () => !!currentDoc.value && collabKeyOfToken.value === currentDoc.value.collabKey && !!collabToken.value,
)

/** 面包屑：从当前文档一路向上找到根，体现父子层级 */
const breadcrumb = computed(() => {
  const path: Doc[] = []
  let node = currentDoc.value
  const byId = new Map(docs.value.map((d) => [d.id, d]))
  let guard = 0
  while (node && guard++ < 50) {
    path.unshift(node)
    node = node.parentId !== null ? byId.get(node.parentId) ?? null : null
  }
  return path
})

function resetState() {
  workspaces.value = []
  docs.value = []
  currentSpaceId.value = null
  currentDocId.value = null
  titleDraft.value = ''
  collabToken.value = ''
  collabKeyOfToken.value = ''
}

/* ---------- 数据加载 ---------- */
async function loadWorkspaces() {
  workspaces.value = await api.listWorkspaces()
  if (workspaces.value.length === 0) {
    currentSpaceId.value = null
    return
  }
  const fromUrl = Number(new URLSearchParams(location.search).get('space'))
  const exists = workspaces.value.some((w) => w.id === fromUrl)
  // 被移出当前空间后，原 id 会失效，这里回落到第一个可见空间
  const stillHasCurrent = workspaces.value.some((w) => w.id === currentSpaceId.value)
  if (!stillHasCurrent) {
    currentSpaceId.value = exists ? fromUrl : workspaces.value[0].id
  }
}

async function loadDocs(spaceId: number, preferDocId?: number | null) {
  docs.value = await api.listDocs(spaceId)
  const fromUrl = Number(new URLSearchParams(location.search).get('doc'))
  const candidates = [preferDocId, fromUrl, currentDocId.value]
  let next: Doc | undefined
  for (const c of candidates) {
    if (c && docs.value.some((d) => d.id === c)) {
      next = docs.value.find((d) => d.id === c)
      break
    }
  }
  // 优先选根文档，避免一进来就停在某个深层子文档
  currentDocId.value = next?.id ?? docs.value.find((d) => d.parentId === null)?.id ?? null
  titleDraft.value = currentDoc.value?.title ?? ''
  syncUrl()
}

/* ---------- URL 同步（可分享、可刷新） ---------- */
function syncUrl() {
  const params = new URLSearchParams()
  if (currentSpaceId.value) params.set('space', String(currentSpaceId.value))
  if (currentDocId.value) params.set('doc', String(currentDocId.value))
  const qs = params.toString()
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

/* ---------- 协同 token ---------- */
async function ensureCollabToken(doc: Doc | null) {
  if (!doc) {
    collabToken.value = ''
    collabKeyOfToken.value = ''
    return
  }
  if (collabKeyOfToken.value === doc.collabKey && collabToken.value) return
  try {
    const res = await api.collabToken(doc.id)
    // 期间可能已切到别的文档，丢弃过期结果
    if (currentDoc.value?.id !== doc.id) return
    collabToken.value = res.token
    collabKeyOfToken.value = doc.collabKey
  } catch (e) {
    showError(e)
  }
}

/* ---------- 交互 ---------- */
function selectSpace(id: number) {
  if (id === currentSpaceId.value) return
  currentSpaceId.value = id
  currentDocId.value = null
  collabToken.value = ''
  collabKeyOfToken.value = ''
  loadDocs(id)
}

function selectDoc(doc: Doc) {
  currentDocId.value = doc.id
  titleDraft.value = doc.title
  syncUrl()
}

function onSpaceCreated(space: Workspace) {
  showCreateSpace.value = false
  workspaces.value = [...workspaces.value, space]
  selectSpace(space.id)
}

/** 成员变动后刷新空间列表：角色和"共 N 人"都可能变 */
async function onMembersChanged() {
  await loadWorkspaces()
  // 自己被移出当前空间时，上面的 loadWorkspaces 会回落，但文档列表要重拉
  if (currentSpaceId.value) await loadDocs(currentSpaceId.value, currentDocId.value)
}

function openMembers(space: Workspace) {
  currentSpaceId.value = space.id
  showMembers.value = true
}

async function createDoc(parentId: number | null) {
  if (!currentSpaceId.value || !canWrite.value) return
  try {
    const doc = await api.createDoc({
      workspaceId: currentSpaceId.value,
      parentId,
      title: parentId === null ? '无标题文档' : '无标题子文档',
    })
    await loadDocs(currentSpaceId.value, doc.id)
    titleDraft.value = doc.title
  } catch (e) {
    showError(e)
  }
}

async function renameDoc(doc: Doc, title: string) {
  try {
    const updated = await api.renameDoc(doc.id, title)
    docs.value = docs.value.map((d) => (d.id === updated.id ? updated : d))
    if (currentDocId.value === updated.id) titleDraft.value = updated.title
  } catch (e) {
    showError(e)
  }
}

async function saveTitle() {
  const doc = currentDoc.value
  const title = titleDraft.value.trim()
  if (!doc || !canWrite.value || !title || title === doc.title) {
    titleDraft.value = doc?.title ?? ''
    return
  }
  await renameDoc(doc, title)
}

async function removeDoc(doc: Doc) {
  if (!canWrite.value) return
  const hasChildren = docs.value.some((d) => d.parentId === doc.id)
  const tip = hasChildren
    ? `删除「${doc.title}」会连同其子文档一起删除，确定吗？`
    : `确定删除「${doc.title}」吗？`
  if (!confirm(tip)) return
  try {
    await api.deleteDoc(doc.id)
    const wasCurrent = currentDocId.value === doc.id
    await loadDocs(currentSpaceId.value!, wasCurrent ? null : currentDocId.value)
  } catch (e) {
    showError(e)
  }
}

/** 批量删除：逐篇调用删除接口，失败即中止并提示 */
async function removeManyDocs(list: Doc[]) {
  if (!canWrite.value || list.length === 0) return
  const names = list.slice(0, 8).map((d) => d.title).join('、')
  const suffix = list.length > 8 ? ` 等 ${list.length} 篇` : ''
  if (!confirm(`确定删除选中的 ${list.length} 篇文档吗？（${names}${suffix}）\n其中含子文档的会连同子文档一起删除，此操作不可恢复。`)) return
  moving.value = true
  try {
    for (const doc of list) {
      await api.deleteDoc(doc.id)
    }
    await loadDocs(currentSpaceId.value!, null)
  } catch (e) {
    showError(e)
    await loadDocs(currentSpaceId.value!, null)
  } finally {
    moving.value = false
  }
}

/** 拖拽改层级 / 改顺序 */
async function moveDoc(payload: { doc: Doc; parentId: number | null; index: number | null }) {
  if (!currentSpaceId.value || !canWrite.value) return
  moving.value = true
  try {
    await api.moveDoc(payload.doc.id, payload.parentId, payload.index)
    await loadDocs(currentSpaceId.value, currentDocId.value)
  } catch (e) {
    showError(e)
    // 失败后重新拉一次，避免界面上留着"看起来已经移动"的假象
    await loadDocs(currentSpaceId.value, currentDocId.value)
  } finally {
    moving.value = false
  }
}

function showError(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e)
}

/* ---------- 会话动作 ---------- */
function onLoggedIn(next: Session) {
  session.value = next
  boot()
}

function onPasswordChanged(next: Session) {
  session.value = next
  showChangePwd.value = false
  error.value = '密码已修改，其它设备需要重新登录'
}

function logout() {
  clearSession()
  session.value = null
  resetState()
}

/* ---------- 启动 ---------- */
async function boot() {
  if (!session.value) return
  try {
    loading.value = true
    // 校验本地 token 是否还有效，同时拿到最新用户信息（含 admin 标识）
    session.value = { ...session.value, user: await api.me() }
    await loadWorkspaces()
    if (currentSpaceId.value) await loadDocs(currentSpaceId.value)
  } catch (e) {
    if (session.value) showError(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => currentDoc.value,
  (doc) => ensureCollabToken(doc),
  { immediate: true },
)

watch(error, (v) => {
  if (v) setTimeout(() => (error.value = ''), 6000)
})

boot()
</script>

<template>
  <!-- 未登录：只显示登录页 -->
  <LoginView v-if="!session" @success="onLoggedIn" />

  <div v-else class="app">
    <header class="topbar">
      <span class="logo">📄 轻量协同文档</span>
      <span class="spacer" />

      <button v-if="session.user.admin" class="top-action" @click="showAdminUsers = true">
        账号管理
      </button>
      <button class="top-action" @click="showChangePwd = true">修改密码</button>

      <span class="avatar" :style="{ background: session.user.color }">
        {{ session.user.displayName.slice(0, 1) }}
      </span>
      <span class="user">
        {{ session.user.displayName }}
        <em v-if="session.user.admin">管理员</em>
      </span>
      <button class="logout" @click="logout">退出</button>
    </header>

    <div class="layout">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <button
          class="sidebar-collapse"
          :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          {{ sidebarCollapsed ? '»' : '«' }}
        </button>

        <div class="section-label">
          <span>空间</span>
          <button class="mini" title="新建空间" @click="showCreateSpace = true">＋</button>
        </div>

        <div
          v-for="w in workspaces"
          :key="w.id"
          :class="['space-item', { active: w.id === currentSpaceId }]"
          @click="selectSpace(w.id)"
        >
          <span class="space-icon">{{ w.type === 'PERSONAL' ? '👤' : '👥' }}</span>
          <span class="space-name">{{ w.name }}</span>

          <!-- 共享空间：直接露出人数，点进去管成员 -->
          <button
            v-if="w.type === 'TEAM'"
            class="space-members"
            :title="w.role === 'OWNER' ? '管理成员' : '查看成员'"
            @click.stop="openMembers(w)"
          >
            {{ w.memberCount }}
          </button>
          <span v-if="w.role === 'VIEWER'" class="space-role">只读</span>
        </div>

        <div v-if="workspaces.length === 0" class="tree-empty">
          还没有空间，点右上角「＋」新建一个
        </div>

        <div class="section-label docs-label">
          <span>文档</span>
          <button v-if="canWrite" class="mini" title="新建根文档" @click="createDoc(null)">＋</button>
        </div>

        <div class="tree-wrap">
          <DocTree
            :docs="docs"
            :current-id="currentDocId"
            :disabled="moving"
            :readonly="!canWrite"
            @select="selectDoc"
            @create-child="createDoc($event.id)"
            @rename="renameDoc"
            @remove="removeDoc"
            @remove-many="removeManyDocs"
            @move="moveDoc"
          />
        </div>

        <div class="sidebar-foot">
          <template v-if="canWrite">拖动文档可调整层级与顺序</template>
          <template v-else>你在此空间只有查看权限</template>
        </div>
      </aside>

      <main ref="mainScroller" class="main">
        <div v-if="loading" class="hint">加载中…</div>

        <template v-else-if="currentDoc">
          <div class="doc-head">
            <div class="crumb">
              <button class="crumb-link" :class="{ last: !breadcrumb.length }" @click="breadcrumb.length ? selectDoc(breadcrumb[0]) : null">
                {{ currentSpace?.name }}
              </button>
              <template v-for="node in breadcrumb" :key="node.id">
                <span class="sep">/</span>
                <button
                  class="crumb-link"
                  :class="{ last: node.id === currentDoc.id }"
                  :disabled="node.id === currentDoc.id"
                  @click="selectDoc(node)"
                >
                  {{ node.title }}
                </button>
              </template>
              <span v-if="!canWrite" class="crumb-ro">仅查看</span>
            </div>
            <input
              v-model="titleDraft"
              class="title-input"
              placeholder="无标题文档"
              :disabled="!canWrite"
              @blur="saveTitle"
              @keyup.enter="($event.target as HTMLInputElement).blur()"
            />
            <div class="doc-actions">
              <button
                v-if="isTeam"
                class="ghost-btn"
                :title="canManageMembers ? '管理成员' : '查看成员'"
                @click="showMembers = true"
              >
                👥 成员 {{ currentSpace?.memberCount ?? 0 }}
              </button>
              <button v-if="canWrite" @click="createDoc(currentDoc.id)">＋ 子文档</button>
            </div>
          </div>

          <!-- 拿到协同 token 后才挂载编辑器：provider 需要它完成握手 -->
          <div v-if="!collabReady" class="collab-skeleton">正在申请协同权限…</div>
          <!-- key 用 collabKey：切文档时销毁旧 provider，接入新房间 -->
          <CollabEditor
            v-else
            :key="currentDoc.collabKey"
            :doc-name="currentDoc.collabKey"
            :collab-token="collabToken"
            :user-name="session.user.displayName"
            :user-color="session.user.color"
            :editable="canWrite"
            @editor-ready="onEditorReady"
          />
        </template>

        <OutlinePanel
          v-if="currentDoc"
          :scroller="mainScroller"
          :editor="outlineEditor"
          :refresh="outlineRefresh"
        />

        <div v-else class="hint">
          左侧选择一篇文档，或点「＋」新建。<br />
          同一篇文档的链接复制给他人，即可实时同编。
        </div>
      </main>
    </div>

    <!-- 弹窗 -->
    <CreateSpaceModal v-if="showCreateSpace" @close="showCreateSpace = false" @created="onSpaceCreated" />

    <MembersModal
      v-if="showMembers && currentSpace"
      :workspace="currentSpace"
      :current-user-id="session.user.id"
      @close="showMembers = false"
      @changed="onMembersChanged"
    />

    <ChangePasswordModal
      v-if="showChangePwd"
      @close="showChangePwd = false"
      @updated="onPasswordChanged"
    />

    <AdminUsersModal
      v-if="showAdminUsers"
      :current-user-id="session.user.id"
      @close="showAdminUsers = false"
    />

    <div v-if="error" class="toast error">{{ error }}</div>
  </div>
</template>

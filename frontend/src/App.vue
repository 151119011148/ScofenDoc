<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CollabEditor from './components/CollabEditor.vue'
import DocTree from './components/DocTree.vue'
import OutlinePanel from './components/OutlinePanel.vue'
import LoginView from './components/LoginView.vue'
import NavRail from './components/NavRail.vue'
import HomeView from './components/HomeView.vue'
import SearchView from './components/SearchView.vue'
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
  type DocHit,
  type Session,
  type Workspace,
} from './api'
import { clearUndo, pushUndo, redoOnce, undoOnce, undoState } from './undo'

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

/* ---------- 导航 / 视图 ---------- */

/**
 * 三个产品入口：主页、文档库、知识库。
 * 文档库与知识库的差别只在 space.kind（入口归组），底层仍是同一套空间/文档/权限模型。
 */
type NavKey = 'home' | 'docs' | 'kb'
/** home=主页，doc=文档编辑，search=搜索结果 */
type View = 'home' | 'doc' | 'search'

const view = ref<View>('home')
const searchQuery = ref('')
const searchResults = ref<DocHit[]>([])
const recentDocs = ref<DocHit[]>([])
const hitsLoading = ref(false)
/** 新建空间弹窗默认落在哪个分类：从知识库入口点进来就是 KB */
const spaceKindDraft = ref<'DOC' | 'KB'>('DOC')
let searchTimer: number | undefined

const docSpaces = computed(() => workspaces.value.filter((w) => w.kind === 'DOC'))
const kbSpaces = computed(() => workspaces.value.filter((w) => w.kind === 'KB'))

/** 当前所在分类：主页时按当前空间的分类归属，避免高亮跳来跳去 */
const nav = computed<NavKey>(() => {
  if (view.value === 'home') return 'home'
  return currentSpace.value?.kind === 'KB' ? 'kb' : 'docs'
})

/** 中间栏展示的空间列表：跟着导航分类走 */
const visibleSpaces = computed(() => (nav.value === 'kb' ? kbSpaces.value : docSpaces.value))

const emptySpaceHint = computed(() =>
  nav.value === 'kb' ? '还没有知识库，点右上角「＋」新建一个' : '还没有文档库，点右上角「＋」新建一个',
)

/* ---------- 分栏宽度（可拖拽，记住上次的） ---------- */

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 560
const SIDEBAR_DEFAULT = 264
const SIDEBAR_KEY = 'scofendoc.sidebarWidth'

const sidebarWidth = ref(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT)
const resizing = ref(false)

/** 导航栏实例，用于 Ctrl+K 把焦点丢进搜索框 */
const navRailEl = ref<{ focusSearch: () => void }>()

const sidebarStyle = computed(() =>
  sidebarCollapsed.value
    ? undefined
    : { width: `${sidebarWidth.value}px`, flexBasis: `${sidebarWidth.value}px` },
)

/**
 * 拖动目录树右边界调整宽度。
 * mousemove/mouseup 挂在 window 上而不是元素上：鼠标一快就会拖出元素范围，
 * 只在元素上监听会「拖着拖着断掉」。
 */
function startResize(e: MouseEvent) {
  if (sidebarCollapsed.value) return
  e.preventDefault()
  resizing.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value
  const prevCursor = document.body.style.cursor
  const prevSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  const onMove = (ev: MouseEvent) => {
    const next = startW + ev.clientX - startX
    sidebarWidth.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next))
  }
  const onUp = () => {
    resizing.value = false
    document.body.style.cursor = prevCursor
    document.body.style.userSelect = prevSelect
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 双击分隔条复位 */
function resetSidebarWidth() {
  sidebarWidth.value = SIDEBAR_DEFAULT
  localStorage.setItem(SIDEBAR_KEY, String(SIDEBAR_DEFAULT))
}

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

/* ---------- 站内跳转：链接 → 切文档 → 滚到锚点 ---------- */

/**
 * 待定位的锚点文字。
 *
 * Markdown 里的 `#g-语言细节与常用工具（散篇）` 这类锚点，在导出 HTML 时是加在
 * 「整段加粗」上的 id，正文进 Yjs 后并没有 id 属性。所以这里不做 id 查找，
 * 而是按**文字**匹配落点：去掉生成器的 g- 前缀和标点空白后做包含比较。
 * 好处是文档被改写、标题前后加字都不影响跳转。
 */
const pendingAnchor = ref('')

function normAnchor(s: string) {
  return s
    .replace(/^g-/, '')
    .replace(/[\s\u00a0]/g, '')
    .replace(/[·：:，,。.、；;！!？?（）()【】\[\]「」“”"'’‘—\-_/\\|*`~#]/g, '')
}

/** 按文字找落点：标题优先，其次「整段加粗」的分组行 */
function findAnchorNode(dom: HTMLElement, want: string): HTMLElement | null {
  const heads = Array.from(dom.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[]
  const byHead = heads.find((h) => normAnchor(h.textContent || '').includes(want))
  if (byHead) return byHead
  // 分组锚点落在「整段加粗」的段落上，用等值匹配避免命中正文里顺带提到的那一句
  const blocks = Array.from(dom.querySelectorAll('p,li')) as HTMLElement[]
  return (
    blocks.find((b) => normAnchor(b.textContent || '') === want) ??
    blocks.find((b) => {
      const t = normAnchor(b.textContent || '')
      return t.includes(want) && t.length <= want.length + 12
    }) ??
    null
  )
}

/** 高亮落点：协同同步会重渲染节点，class 会掉，所以隔一会儿补一次 */
function markAnchor(want: string, rounds = 3) {
  const dom = outlineEditor.value?.view?.dom ?? null
  if (!dom) return
  const node = findAnchorNode(dom, want)
  if (!node) return
  node.classList.add('anchor-hit')
  setTimeout(() => node.classList.remove('anchor-hit'), 3400)
  if (rounds > 1) setTimeout(() => markAnchor(want, rounds - 1), 1200)
}

/**
 * 二次对齐。
 * 正文里有 mermaid 图、表格，渲染完成会明显改变高度：一次性算好的位置在
 * 图渲染完之后就偏了。这里在图/表格陆续渲染完的时间窗里再校几次，偏差大才动。
 */
function alignAnchor(want: string, rounds = 4) {
  const scroller = mainScroller.value
  const dom = outlineEditor.value?.view?.dom ?? null
  if (!scroller || !dom) return
  const node = findAnchorNode(dom, want)
  if (node) {
    const delta = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
    if (Math.abs(delta) > 40) scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: 'auto' })
  }
  if (rounds > 1) setTimeout(() => alignAnchor(want, rounds - 1), 700)
}

/** 滚动到锚点；协同正文是异步到达的，没命中就重试（最多约 5 秒） */
function scrollToAnchor(anchor: string, tries = 0) {
  const want = normAnchor(anchor)
  if (!want) return
  const scroller = mainScroller.value
  const dom = outlineEditor.value?.view?.dom ?? null
  if (scroller && dom) {
    const hit = findAnchorNode(dom, want)
    if (hit) {
      const top = scroller.scrollTop + hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      markAnchor(want)
      alignAnchor(want)
      return
    }
  }
  if (tries < 25) setTimeout(() => scrollToAnchor(anchor, tries + 1), 200)
}

/**
 * 编辑器里点了站内链接。
 * spaceId 与当前不同就先切空间，再按 docId 选文档；同空间直接选，不整页刷新。
 */
async function onNavigate(payload: { spaceId: number; docId: number; anchor: string }) {
  const anchor = payload.anchor || ''
  view.value = 'doc'
  searchQuery.value = ''
  searchResults.value = []
  closeNav()

  if (payload.spaceId && payload.spaceId !== currentSpaceId.value) {
    currentSpaceId.value = payload.spaceId
    currentDocId.value = payload.docId > 0 ? payload.docId : null
    collabToken.value = ''
    collabKeyOfToken.value = ''
    clearUndo()
    await loadDocs(payload.spaceId, payload.docId || null)
  } else if (payload.docId > 0 && payload.docId !== currentDocId.value) {
    const target = docs.value.find((d) => d.id === payload.docId)
    if (target) selectDoc(target)
    else if (currentSpaceId.value) await loadDocs(currentSpaceId.value, payload.docId)
  }

  // selectDoc 会清掉锚点（用户手动选文档时不该带着旧锚点），所以放在它之后设置
  pendingAnchor.value = anchor
  syncUrl()
  if (anchor) scrollToAnchor(anchor)
}

/* ---------- 移动端：左栏改为滑出抽屉 ---------- */

/**
 * 768px 以下走手机布局：左栏不再是常驻分栏，而是从左侧滑出的抽屉。
 * 用 matchMedia 而非纯 CSS，是因为「什么时候关抽屉」需要 JS 参与
 * （选完空间/文档、切导航、点遮罩都要关）。
 */
const isMobile = ref(false)
const navOpen = ref(false)
/**
 * 手机上的大纲面板是否展开（桌面忽略）。
 * 桌面是常驻左中栏；手机宽度放不下，改成顶栏「目录」按钮唤起的底部面板，
 * 点条目 / 点遮罩 / 再点按钮收起。
 */
const outlineOpen = ref(false)
let viewportMq: MediaQueryList | undefined

function syncViewport(e?: MediaQueryListEvent) {
  isMobile.value = e ? e.matches : !!viewportMq?.matches
  // 回到桌面宽度时收掉抽屉与大纲面板，避免下次变窄时莫名其妙是开着的
  if (!isMobile.value) {
    navOpen.value = false
    outlineOpen.value = false
  }
}

/** 手机上没有「折叠成窄条」这回事，永远是完整抽屉 */
const railCollapsed = computed(() => sidebarCollapsed.value && !isMobile.value)

/** 手机顶栏标题：优先当前文档，其次空间名 */
const mobileTitle = computed(() => currentDoc.value?.title || currentSpace.value?.name || 'scofenDoc')

function closeNav() {
  if (isMobile.value) {
    navOpen.value = false
    // 切文档/切空间后，旧的纲面板不该还挂着（内容已经换了）
    outlineOpen.value = false
  }
}

function onToggleCollapse() {
  if (isMobile.value) navOpen.value = false
  else sidebarCollapsed.value = !sidebarCollapsed.value
}

/** 抽屉/大纲面板打开时锁住背景滚动，否则手指滑的是背后的正文 */
watch([navOpen, outlineOpen], ([n, o]) => {
  document.body.style.overflow = n || o ? 'hidden' : ''
})

/* ---------- 中间栏：文章大纲（宽度可拖） ---------- */

const OUTLINE_MIN = 170
const OUTLINE_MAX = 420
const OUTLINE_DEFAULT = 216
const OUTLINE_KEY = 'scofendoc.outlineWidth'

const outlineWidth = ref(Number(localStorage.getItem(OUTLINE_KEY)) || OUTLINE_DEFAULT)
const outlineCollapsed = ref(false)
const outlineResizing = ref(false)

/** 只有打开某篇文档时才需要大纲；主页/搜索/空态都不占这一栏 */
const hasOutline = computed(() => view.value === 'doc' && !!currentDoc.value)

const outlineStyle = computed(() =>
  outlineCollapsed.value
    ? { width: '32px', flexBasis: '32px' }
    : { width: `${outlineWidth.value}px`, flexBasis: `${outlineWidth.value}px` },
)

function startOutlineResize(e: MouseEvent) {
  if (outlineCollapsed.value) return
  e.preventDefault()
  outlineResizing.value = true
  const startX = e.clientX
  const startW = outlineWidth.value
  const prevCursor = document.body.style.cursor
  const prevSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  const onMove = (ev: MouseEvent) => {
    const next = startW + ev.clientX - startX
    outlineWidth.value = Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, next))
  }
  const onUp = () => {
    outlineResizing.value = false
    document.body.style.cursor = prevCursor
    document.body.style.userSelect = prevSelect
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    localStorage.setItem(OUTLINE_KEY, String(outlineWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function resetOutlineWidth() {
  outlineWidth.value = OUTLINE_DEFAULT
  localStorage.setItem(OUTLINE_KEY, String(OUTLINE_DEFAULT))
}

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
  // 撤销栈里存的是上个空间的文档 id，跨空间没有任何意义
  clearUndo()
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
  // 被移出当前空间后，原 id 会失效，这里回落到「当前分类下的第一个空间」
  const stillHasCurrent = workspaces.value.some((w) => w.id === currentSpaceId.value)
  if (!stillHasCurrent) {
    const wantKind = nav.value === 'kb' ? 'KB' : 'DOC'
    const fallback = workspaces.value.find((w) => w.kind === wantKind) ?? workspaces.value[0]
    currentSpaceId.value = exists ? fromUrl : fallback.id
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
  // 主页不带 doc 参数：否则刷新一下就又跳回某篇文档，回不到主页
  if (currentDocId.value && view.value !== 'home') params.set('doc', String(currentDocId.value))
  // 锚点只在「从别处跳进来」时带上，方便把定位结果整条链接发出去
  if (pendingAnchor.value && view.value !== 'home') params.set('h', pendingAnchor.value)
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
  closeNav()
  view.value = 'doc'
  searchQuery.value = ''
  searchResults.value = []
  if (id === currentSpaceId.value) return
  currentSpaceId.value = id
  currentDocId.value = null
  collabToken.value = ''
  collabKeyOfToken.value = ''
  clearUndo()
  loadDocs(id)
}

function selectDoc(doc: Doc) {
  closeNav()
  currentDocId.value = doc.id
  titleDraft.value = doc.title
  // 手动点树选文档时不该带着上一跳的锚点
  pendingAnchor.value = ''
  // 从搜索/主页点进来时，要回到文档视图
  view.value = 'doc'
  searchQuery.value = ''
  searchResults.value = []
  syncUrl()
}

/* ---------- 导航切换 ---------- */

function goNav(target: NavKey) {
  closeNav()
  searchQuery.value = ''
  searchResults.value = []
  if (target === 'home') {
    view.value = 'home'
    loadRecent()
    syncUrl()
    return
  }
  const wantKind: 'DOC' | 'KB' = target === 'kb' ? 'KB' : 'DOC'
  spaceKindDraft.value = wantKind
  view.value = 'doc'
  const list = wantKind === 'KB' ? kbSpaces.value : docSpaces.value
  if (list.length === 0) {
    // 该分类下还没有空间：清空中间栏，主区给引导文案
    currentSpaceId.value = null
    currentDocId.value = null
    docs.value = []
    return
  }
  if (currentSpace.value?.kind !== wantKind) selectSpace(list[0].id)
  else syncUrl()
}

/* ---------- 搜索 ---------- */

/**
 * 输入即搜（220ms 防抖）。
 * 关键词一清空就退回文档视图 —— 空搜索框还停在结果页会让人以为卡住了。
 */
function onSearchInput(value: string) {
  searchQuery.value = value
  window.clearTimeout(searchTimer)
  const kw = value.trim()
  if (!kw) {
    searchResults.value = []
    if (view.value === 'search') view.value = 'doc'
    return
  }
  view.value = 'search'
  hitsLoading.value = true
  searchTimer = window.setTimeout(async () => {
    const res = await api.searchDocs(kw, 30).catch((e) => {
      showError(e)
      return [] as DocHit[]
    })
    // 期间可能又输入了新词，丢弃过期结果
    if (searchQuery.value.trim() === kw) {
      searchResults.value = res
      hitsLoading.value = false
    }
  }, 220)
}

/* ---------- 主页 ---------- */

async function loadRecent() {
  hitsLoading.value = true
  try {
    recentDocs.value = await api.searchDocs('', 12)
  } catch (e) {
    showError(e)
  } finally {
    hitsLoading.value = false
  }
}

/** 从搜索结果 / 最近更新打开一篇文档 */
async function openHit(hit: DocHit) {
  closeNav()
  view.value = 'doc'
  searchQuery.value = ''
  searchResults.value = []
  if (currentSpaceId.value !== hit.workspaceId) {
    currentSpaceId.value = hit.workspaceId
    collabToken.value = ''
    collabKeyOfToken.value = ''
    clearUndo()
  }
  await loadDocs(hit.workspaceId, hit.id)
}

/** 新建空间：带上当前导航分类，知识库入口建出来的就是知识库 */
function newSpace(kind: 'DOC' | 'KB') {
  spaceKindDraft.value = kind
  showCreateSpace.value = true
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
  const oldTitle = doc.title
  try {
    await applyRename(doc.id, title)
    pushUndo({
      label: `重命名「${oldTitle}」→「${title}」`,
      undo: () => applyRename(doc.id, oldTitle),
      redo: () => applyRename(doc.id, title),
    })
  } catch (e) {
    showError(e)
  }
}

/** 落库改标题并同步本地状态（撤销/重做复用） */
async function applyRename(id: number, title: string) {
  const updated = await api.renameDoc(id, title)
  docs.value = docs.value.map((d) => (d.id === updated.id ? updated : d))
  if (currentDocId.value === updated.id) titleDraft.value = updated.title
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
    // 后端是软删除，撤销就是把 deleted 标记翻回去，正文原样保留
    pushUndo({
      label: `删除「${doc.title}」`,
      undo: () => restoreDocs([doc.id]),
      redo: () => deleteDocs([doc.id]),
    })
  } catch (e) {
    showError(e)
  }
}

/** 批量删除：逐篇调用删除接口，失败即中止并提示 */
async function removeManyDocs(list: Doc[]) {
  if (!canWrite.value || list.length === 0) return
  const names = list.slice(0, 8).map((d) => d.title).join('、')
  const suffix = list.length > 8 ? ` 等 ${list.length} 篇` : ''
  if (!confirm(`确定删除选中的 ${list.length} 篇文档吗？（${names}${suffix}）\n其中含子文档的会连同子文档一起删除。删错了可以按 Ctrl+Z 撤销。`)) return
  moving.value = true
  const ids = list.map((d) => d.id)
  try {
    for (const id of ids) {
      await api.deleteDoc(id)
    }
    await loadDocs(currentSpaceId.value!, null)
    pushUndo({
      label: `删除 ${ids.length} 篇文档`,
      undo: () => restoreDocs(ids),
      redo: () => deleteDocs(ids),
    })
  } catch (e) {
    showError(e)
    await loadDocs(currentSpaceId.value!, null)
  } finally {
    moving.value = false
  }
}

/* ---------- 撤销 / 重做 ---------- */

/** 撤销/重做的即时反馈（和错误提示分开，颜色不同） */
const notice = ref('')
let noticeTimer: number | undefined

function flash(msg: string) {
  notice.value = msg
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 2600)
}

async function reloadDocs() {
  if (currentSpaceId.value) await loadDocs(currentSpaceId.value, currentDocId.value)
}

/** 文档在「当前父级下」排第几 —— 撤销移动时要原样放回去 */
function siblingIndexOf(doc: Doc): number {
  const sibs = docs.value.filter((d) => d.parentId === doc.parentId)
  const at = sibs.findIndex((d) => d.id === doc.id)
  return at < 0 ? 0 : at
}

/**
 * 按计划逐条落库。
 * 同一个父级下要按 index 升序插入：拖 3 篇到第 2 位，就是 2、3、4，
 * 顺序反了会把整批的先后倒过来。
 */
async function applyMovePlan(plan: { id: number; parentId: number | null; index: number }[]) {
  const sorted = [...plan].sort((a, b) => a.index - b.index)
  for (const step of sorted) {
    await api.moveDoc(step.id, step.parentId, step.index)
  }
  await reloadDocs()
}

async function restoreDocs(ids: number[]) {
  for (const id of ids) await api.restoreDoc(id)
  await reloadDocs()
}

async function deleteDocs(ids: number[]) {
  for (const id of ids) await api.deleteDoc(id)
  await reloadDocs()
}

/** 拖拽改层级 / 改顺序，支持整批（多选后直接拖） */
async function moveDocs(payload: { docs: Doc[]; parentId: number | null; index: number | null }) {
  if (!currentSpaceId.value || !canWrite.value || payload.docs.length === 0) return
  // 撤销用：记下每篇原来的父级与位置（必须在请求前取，请求后 docs 就变了）
  const before = payload.docs.map((d) => ({
    id: d.id,
    parentId: d.parentId,
    index: siblingIndexOf(d),
  }))
  // 目标位置：index 为 null 表示放到末尾
  const movingIds = new Set(payload.docs.map((d) => d.id))
  const restCount = docs.value.filter(
    (d) => d.parentId === payload.parentId && !movingIds.has(d.id),
  ).length
  const base = payload.index ?? restCount
  const after = payload.docs.map((d, i) => ({
    id: d.id,
    parentId: payload.parentId,
    index: base + i,
  }))

  moving.value = true
  try {
    await applyMovePlan(after)
    pushUndo({
      label:
        payload.docs.length > 1
          ? `移动 ${payload.docs.length} 篇文档`
          : `移动「${payload.docs[0].title}」`,
      undo: () => applyMovePlan(before),
      redo: () => applyMovePlan(after),
    })
  } catch (e) {
    showError(e)
    // 失败后重新拉一次，避免界面上留着"看起来已经移动"的假象
    await reloadDocs()
  } finally {
    moving.value = false
  }
}

/** 焦点在正文编辑器或输入框里时，Ctrl+Z 交给它们自己处理 */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || !node.tagName) return false
  if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') return true
  if (node.isContentEditable) return true
  return !!node.closest?.('.ProseMirror')
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()

  // Ctrl/Cmd+K 聚焦搜索框（业界惯例，用户会本能去按）
  if (key === 'k') {
    e.preventDefault()
    navRailEl.value?.focusSearch()
    return
  }

  if (key !== 'z' && key !== 'y') return
  // 正文有 Yjs 自己的撤销栈（按文档、跨端一致），这里只管文档树这类元数据操作
  if (isTypingTarget(e.target)) return
  if (undoState.busy) return

  e.preventDefault()
  const wantRedo = key === 'y' || e.shiftKey
  const run = wantRedo ? redoOnce() : undoOnce()
  run
    .then((label) => {
      if (label) flash(`${wantRedo ? '已重做' : '已撤销'}：${label}`)
      else flash(wantRedo ? '没有可重做的操作' : '没有可撤销的操作')
    })
    .catch((err) => {
      showError(err)
      reloadDocs()
    })
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  viewportMq = window.matchMedia('(max-width: 768px)')
  syncViewport()
  viewportMq.addEventListener('change', syncViewport)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  viewportMq?.removeEventListener('change', syncViewport)
  window.clearTimeout(noticeTimer)
  // 抽屉锁滚动是直接写 body 上的，卸载时得还回去，否则整页再也滚不动
  document.body.style.overflow = ''
})

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
  // 先按 URL 定视图，再加载数据：loadDocs 里的 syncUrl 会看当前 view 决定是否保留 doc 参数，
  // 顺序反了会把 ?doc= 冲掉，分享链接就退回主页了
  const wantsDoc = !!new URLSearchParams(location.search).get('doc')
  view.value = wantsDoc ? 'doc' : 'home'
  try {
    loading.value = true
    // 校验本地 token 是否还有效，同时拿到最新用户信息（含 admin 标识）
    session.value = { ...session.value, user: await api.me() }
    await loadWorkspaces()
    if (currentSpaceId.value) await loadDocs(currentSpaceId.value)
    if (!wantsDoc) {
      syncUrl()
      loadRecent()
    } else {
      // 分享链接里带了锚点：等编辑器把协同正文拉回来再定位（scrollToAnchor 内部会重试）
      const anchor = new URLSearchParams(location.search).get('h') || ''
      if (anchor) {
        pendingAnchor.value = anchor
        scrollToAnchor(anchor)
      }
    }
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
    <!-- 手机顶栏：只在 768px 以下出现，桌面端由 CSS 隐藏 -->
    <header class="m-topbar">
      <button class="m-menu" title="打开菜单" @click="navOpen = true">☰</button>
      <span class="m-title">{{ mobileTitle }}</span>
      <!-- 手机上大纲不常驻，靠这个按钮唤出底部面板 -->
      <button
        v-if="hasOutline"
        :class="['m-outline', { on: outlineOpen }]"
        :title="outlineOpen ? '收起大纲' : '文章大纲'"
        @click="outlineOpen = !outlineOpen"
      >
        目录
      </button>
      <button
        v-if="canWrite && view === 'doc' && currentSpace"
        class="m-new"
        title="新建根文档"
        @click="createDoc(null)"
      >
        ＋
      </button>
    </header>

    <div class="layout">
      <!-- 抽屉遮罩：点一下收菜单 -->
      <div v-if="navOpen" class="nav-mask" @click="navOpen = false" />

      <!-- 最左：导航 + 空间 + 当前空间的文档树（飞书式的单栏导航） -->
      <NavRail
        ref="navRailEl"
        :class="{ resizing, 'drawer-open': navOpen }"
        :style="isMobile ? undefined : sidebarStyle"
        :active="nav"
        :user="session.user"
        :search="searchQuery"
        :spaces="workspaces"
        :current-space-id="currentSpaceId"
        :collapsed="railCollapsed"
        :drawer="isMobile"
        @navigate="goNav"
        @select-space="selectSpace($event.id)"
        @new-space="newSpace"
        @open-members="openMembers"
        @toggle-collapse="onToggleCollapse"
        @search="onSearchInput"
        @change-password="showChangePwd = true"
        @admin-users="showAdminUsers = true"
        @logout="logout"
      >
        <template #tree>
          <div class="tree-head">
            <span>文档</span>
            <button
              v-if="canWrite && currentSpace"
              class="mini"
              title="新建根文档"
              @click="createDoc(null)"
            >
              ＋
            </button>
          </div>
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
            @move="moveDocs"
          />
          <div class="tree-tip">
            <template v-if="canWrite">拖动调整层级 · 右键文档可新建/重命名/删除 · Ctrl+Z 撤销</template>
            <template v-else>你在此空间只有查看权限</template>
          </div>
        </template>
      </NavRail>

      <!-- 左栏右边界：hover 变双向箭头，拖动调宽，双击复位 -->
      <div
        v-if="!sidebarCollapsed && !isMobile"
        :class="['resize-handle', { active: resizing }]"
        title="拖动调整宽度，双击复位"
        @mousedown="startResize"
        @dblclick="resetSidebarWidth"
      />

      <!-- 手机大纲面板的遮罩：点空白处收起 -->
      <div v-if="outlineOpen" class="outline-mask" @click="outlineOpen = false" />

      <!-- 中间：当前文档的文章大纲（桌面常驻；手机是顶栏「目录」唤出的底部面板） -->
      <aside
        v-if="hasOutline"
        :class="['outline-col', { mini: outlineCollapsed, resizing: outlineResizing, 'm-open': outlineOpen }]"
        :style="isMobile ? undefined : outlineStyle"
      >
        <div class="outline-col-head">
          <span v-if="!outlineCollapsed || isMobile" class="outline-col-title">文章大纲</span>
          <button
            v-if="!isMobile"
            class="outline-toggle"
            :title="outlineCollapsed ? '展开大纲' : '收起大纲'"
            @click="outlineCollapsed = !outlineCollapsed"
          >
            {{ outlineCollapsed ? '»' : '«' }}
          </button>
          <button v-else class="outline-toggle" title="收起大纲" @click="outlineOpen = false">✕</button>
        </div>
        <div v-if="outlineCollapsed && !isMobile" class="outline-mini-label">大纲</div>
        <OutlinePanel
          v-else
          :scroller="mainScroller"
          :editor="outlineEditor"
          :refresh="outlineRefresh"
          @select="outlineOpen = false"
        />
      </aside>

      <div
        v-if="hasOutline && !outlineCollapsed && !isMobile"
        :class="['resize-handle', { active: outlineResizing }]"
        title="拖动调整大纲宽度，双击复位"
        @mousedown="startOutlineResize"
        @dblclick="resetOutlineWidth"
      />

      <main ref="mainScroller" class="main">
        <!-- 主页 -->
        <HomeView
          v-if="view === 'home'"
          :user="session.user"
          :workspaces="workspaces"
          :hits="recentDocs"
          :loading="hitsLoading"
          :current-doc-count="docs.length"
          @open="openHit"
          @new-space="newSpace"
        />

        <!-- 搜索结果 -->
        <SearchView
          v-else-if="view === 'search'"
          :keyword="searchQuery"
          :hits="searchResults"
          :loading="hitsLoading"
          @open="openHit"
          @clear="onSearchInput('')"
        />

        <!-- 文档编辑 -->
        <template v-else>
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
              :space-id="currentSpaceId ?? 0"
              @editor-ready="onEditorReady"
              @navigate="onNavigate"
            />
          </template>

          <div v-else class="hint">
            <template v-if="visibleSpaces.length === 0">
              {{ emptySpaceHint }}<br />
              建好空间后，就能在里面写第一篇文档了。
            </template>
            <template v-else>
              左侧选择一篇文档，或点「＋」新建。<br />
              同一篇文档的链接复制给他人，即可实时同编。
            </template>
          </div>
        </template>
      </main>
    </div>

    <!-- 弹窗 -->
    <CreateSpaceModal
      v-if="showCreateSpace"
      :default-kind="spaceKindDraft"
      @close="showCreateSpace = false"
      @created="onSpaceCreated"
    />

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
    <div v-if="notice" class="toast notice">{{ notice }}</div>
  </div>
</template>

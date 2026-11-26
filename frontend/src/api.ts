import { API_BASE } from './config'

export type Role = 'OWNER' | 'EDITOR' | 'VIEWER'

export interface Workspace {
  id: number
  name: string
  type: 'PERSONAL' | 'TEAM'
  /** 文档库（DOC）/ 知识库（KB） */
  kind: 'DOC' | 'KB'
  ownerName: string | null
  /** 我在这个空间里的角色 */
  role: Role | null
  memberCount: number
}

export interface Doc {
  id: number
  workspaceId: number
  parentId: number | null
  title: string
  /** 派生章节号（1 / 1.1 / 1.1.1），后端按树结构实时算，不落库；拖动后自动变 */
  number?: string
  collabKey: string
  sortOrder: number
  updatedAt: string
}

export type DocShareRole = 'VIEWER' | 'EDITOR' | 'MANAGER'
export interface DocPermissions { canWrite: boolean; canManage: boolean }
export interface DocVersion { id: string; name: string; kind: string; createdAt: string }
export interface SharedDoc { id: number; title: string; role: DocShareRole | 'OWNER' }
export interface TrashEntry { id: number; parentId: number | null; title: string; deletedAt: string; cleanupPending: boolean }
export interface DocSharing {
  collaborators: { userId: number; username: string; role: DocShareRole }[]
  links: { id: number; expiresAt: string; passwordRequired: boolean }[]
}

/** 搜索结果 / 最近文档条目：比 Doc 多带空间名，方便跨空间展示 */
export interface DocHit {
  id: number
  title: string
  /** 同 Doc.number，跨空间时按各自空间单独编号 */
  number?: string
  workspaceId: number
  workspaceName: string
  parentId: number | null
  updatedAt: string
  /** 正文命中的上下文片段；标题命中或「最近更新」时为空 */
  snippet?: string | null
}

export interface User {
  id: number
  username: string
  displayName: string
  color: string
  admin: boolean
}

export interface Member {
  userId: number
  username: string
  displayName: string
  color: string
  role: Role
  joinedAt: string | null
}

export interface AuthConfig {
  registrationOpen: boolean
  hasUsers: boolean
  registrationMode: string
}

export interface Session {
  token: string
  user: User
}

/* ---------------- 会话存储 ---------------- */

const TOKEN_KEY = 'scofendoc.token'
const USER_KEY = 'scofendoc.user'

export function loadSession(): Session | null {
  const token = localStorage.getItem(TOKEN_KEY)
  const raw = localStorage.getItem(USER_KEY)
  if (!token || !raw) return null
  try {
    return { token, user: JSON.parse(raw) as User }
  } catch {
    return null
  }
}

export function saveSession(session: Session) {
  localStorage.setItem(TOKEN_KEY, session.token)
  localStorage.setItem(USER_KEY, JSON.stringify(session.user))
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

/** 401 时通知 App 回到登录页（避免 api.ts 反向依赖组件） */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

/* ---------------- 请求封装 ---------------- */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) }
  // FormData 必须由浏览器自己带 boundary，手设 Content-Type 会导致上传解析失败；
  // Blob/File（裸二进制上传）则要用文件自己的 MIME，后端靠它 + 文件头识别格式
  if (init?.body && !(init.body instanceof FormData)) {
    const isBlob = init.body instanceof Blob
    headers['Content-Type'] = isBlob
      ? ((init.body as Blob).type || 'application/octet-stream')
      : 'application/json'
  }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (!res.ok) {
    let msg = `请求失败（${res.status}）`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* 响应体不是 JSON 时忽略 */
    }
    // 413 常来自 Nginx / Tomcat 的纯 HTML 错误页，解析不出 error 字段，这里兜一句人话
    if (res.status === 413) msg = '文件太大，超过服务器允许的上传上限'
    // 登录接口的 401 是"账号密码错"，不能当成会话过期处理，否则会误清空并跳转
    if (res.status === 401 && !path.startsWith('/auth/')) {
      clearSession()
      onUnauthorized?.()
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  /* 账号 */
  authConfig: () => request<AuthConfig>('/auth/config'),

  login: (username: string, password: string) =>
    request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, password: string, displayName?: string) =>
    request<Session>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, displayName }),
    }),

  me: () => request<User>('/auth/me'),

  /** 改密：后端返回新 token，当前设备继续有效，其它设备的旧 token 立刻失效 */
  changePassword: (oldPassword: string, newPassword: string) =>
    request<Session>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  /* 管理员 */
  adminUsers: () => request<User[]>('/admin/users'),

  adminCreateUser: (payload: {
    username: string
    password: string
    displayName?: string
    admin?: boolean
  }) => request<User>('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),

  adminResetPassword: (userId: number, password: string) =>
    request<{ reset: boolean }>(`/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  adminSetAdmin: (userId: number, admin: boolean) =>
    request<User>(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ admin }),
    }),

  /* 空间 */
  listWorkspaces: () => request<Workspace[]>('/workspaces'),

  createWorkspace: (name: string, type: 'PERSONAL' | 'TEAM' = 'PERSONAL', kind: 'DOC' | 'KB' = 'DOC') =>
    request<Workspace>('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, type, kind }),
    }),

  /* 成员 */
  listMembers: (workspaceId: number) => request<Member[]>(`/workspaces/${workspaceId}/members`),

  inviteMember: (workspaceId: number, username: string, role: Exclude<Role, 'OWNER'>) =>
    request<Member>(`/workspaces/${workspaceId}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, role }),
    }),

  changeMemberRole: (workspaceId: number, userId: number, role: Exclude<Role, 'OWNER'>) =>
    request<Member>(`/workspaces/${workspaceId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),

  removeMember: (workspaceId: number, userId: number) =>
    request<{ removed: boolean }>(`/workspaces/${workspaceId}/members/${userId}`, {
      method: 'DELETE',
    }),

  /* 文档 */
  listDocs: (workspaceId: number) => request<Doc[]>(`/workspaces/${workspaceId}/docs`),

  /** 跨空间搜索文档标题；q 为空即「最近更新」，主页直接用它 */
  searchDocs: (q: string, limit = 20) =>
    request<DocHit[]>(`/docs/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  getDoc: (id: number) => request<Doc>(`/docs/${id}`),

  createDoc: (payload: { workspaceId: number; parentId?: number | null; title?: string }) =>
    request<Doc>('/docs', { method: 'POST', body: JSON.stringify(payload) }),

  renameDoc: (id: number, title: string) =>
    request<Doc>(`/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  /** 移动：parentId 为新父级（null=根），index 为同级落点下标（null=末尾） */
  moveDoc: (id: number, parentId: number | null, index: number | null) =>
    request<Doc>(`/docs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ moveParent: true, parentId, index }),
    }),

  deleteDoc: (id: number) =>
    request<{ deleted: number }>(`/docs/${id}`, { method: 'DELETE' }),

  /** 撤销删除：把软删掉的文档（含子树）恢复回来 */
  restoreDoc: (id: number) =>
    request<{ restored: number }>(`/docs/${id}/restore`, { method: 'POST' }),

  /** 协同 token：只对这篇文档有效，前端连 WebSocket 时带上 */
  collabToken: (docId: number) =>
    request<{ token: string; expiresIn: number; canWrite: boolean }>(`/docs/${docId}/collab-token`, { cache: 'no-store' }),

  docPermissions: (id: number) => request<DocPermissions>(`/docs/${id}/permissions`),
  sharedDocs: () => request<SharedDoc[]>('/docs/shared'),
  docSharing: (id: number) => request<DocSharing>(`/docs/${id}/sharing`),
  grantDoc: (id: number, username: string, role: DocShareRole) =>
    request<void>(`/docs/${id}/collaborators`, { method: 'POST', body: JSON.stringify({ username, role }) }),
  revokeDoc: (id: number, user: number) =>
    request<void>(`/docs/${id}/collaborators/${user}`, { method: 'DELETE' }),
  createDocLink: (id: number, hours: number, password: string) =>
    request<{ token: string }>(`/docs/${id}/share-links`, { method: 'POST', body: JSON.stringify({ hours, password }) }),
  revokeDocLink: (id: number, link: number) =>
    request<void>(`/docs/${id}/share-links/${link}`, { method: 'DELETE' }),
  redeemDocLink: (token: string, password: string) =>
    request<{ id: number }>('/docs/redeem-share', { method: 'POST', body: JSON.stringify({ token, password }) }),
  docVersions: (id: number) => request<DocVersion[]>(`/docs/${id}/versions`),
  snapshotDoc: (id: number, name: string) =>
    request<DocVersion>(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({ name }) }),
  previewVersion: (id: number, version: string) =>
    request<{ text: string; truncated: boolean }>(`/docs/${id}/versions/${version}`),
  restoreVersion: (id: number, version: string) =>
    request<{ collabKey: string }>(`/docs/${id}/versions/${version}/restore`, { method: 'POST' }),
  trash: (space: number) => request<TrashEntry[]>(`/workspaces/${space}/trash`),
  purgeDoc: (id: number) => request<{ purged: number }>(`/docs/${id}/purge`, { method: 'DELETE' }),

  /**
   * 正文配图：粘贴/拖入的图片先上传，再把返回的 URL 写成 image 节点（避免 base64 撑爆 Yjs）。
   *
   * 走裸二进制而不是 multipart：部分客户端网络环境（企业安全软件 / DLP / 出口设备）
   * 会把 multipart 的文件分段 RST 掉，浏览器只看到 ERR_CONNECTION_RESET。裸 body 无此问题。
   */
  uploadImage: (file: File) =>
    request<{ url: string }>('/images/raw', { method: 'POST', body: file }),

  /** 图文粘贴里的外链图片：由服务端抓回转存成本站地址（浏览器直抓会撞 CORS / 防盗链） */
  importImageByUrl: (url: string) =>
    request<{ url: string }>('/images/from-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  /**
   * 正文附件：上传到指定文档，返回 id / 原始文件名 / 大小（正文节点只存这些，不存字节）。
   * 同样走裸二进制：multipart 在部分网络环境下会被中途 RST。文件名放 query（encodeURIComponent）。
   */
  uploadAttachment: (file: File, docId: number) =>
    request<{ id: number; name: string; size: number; url: string }>(
      `/attachments/raw?docId=${docId}&name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    ),

  /**
   * 下载附件：下载接口要带 Bearer token，不能用普通 <a href>（不带 header 会被 401）。
   * 用 fetch 取 blob 再触发浏览器下载，并从 Content-Disposition 里取回服务端给的原始文件名。
   */
  downloadAttachment: async (id: number): Promise<void> => {
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${API_BASE}/attachments/${id}/download`, { headers })
    if (!res.ok) {
      let message = `下载失败（HTTP ${res.status}）`
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch { /* 非 JSON 响应就用默认提示 */ }
      if (res.status === 401) {
        clearSession()
        onUnauthorized?.()
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    // filename*=UTF-8''xxx（服务端 URLEncoder 编码，+ 已被替换成 %20）
    const cd = res.headers.get('Content-Disposition') || ''
    let name = `attachment-${id}`
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
    if (m?.[1]) {
      try { name = decodeURIComponent(m[1]) } catch { /* 坏编码就退回默认名 */ }
    }
    const objectUrl = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      // 立刻 revoke 在部分浏览器会让下载中断，延迟一拍
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
    }
  },
}

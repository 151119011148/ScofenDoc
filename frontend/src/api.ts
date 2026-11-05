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
  if (init?.body) headers['Content-Type'] = 'application/json'
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
    request<{ token: string; expiresIn: number }>(`/docs/${docId}/collab-token`),
}

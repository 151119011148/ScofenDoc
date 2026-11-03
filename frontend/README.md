# frontend · 轻量协同文档 · 前端

> 本文档面向**前端维护者**。它描述 `frontend/` 这个 Vue 应用的需求设计、功能设计、数据实体设计、表结构（本地存储）组织、包结构组织与接口设计。
> 业务后端接口、协同链路与部署说明见仓库根目录 `README.md` 与各应用 README。

---

## 1. 需求设计

`frontend` 是「轻量协同文档」的 Web 客户端，目标是一个**类飞书文档的轻量自托管**体验：

| 需求域 | 说明 |
|---|---|
| 账号 | 登录 / 注册（受后端注册开关约束）、退出、自助改密 |
| 权限收敛 | 按「我在空间里的角色」决定能否写、能否管成员；`VIEWER` 隐藏所有写入口、编辑器只读、禁用拖拽 |
| 空间 | 个人空间 / 团队空间切换；团队空间按成员共享 |
| 文档树 | 三栏布局（顶栏 + 侧栏空间/文档树 + 正文）；任意层级父子文档、同级排序、折叠、行内重命名、拖拽改层级（带防环） |
| 块编辑器 | Tiptap 块编辑器：输入 `/` 弹块菜单（标题/列表/待办/引用/代码/表格/分割线），支持方向键与拼音搜索；表格可增删行列 |
| 实时协同 | Yjs + Hocuspocus 同步；彩色光标（真实昵称 + 专属颜色）、在线人数、断线重连 |
| 协同鉴权 | 切文档前向 `/api/docs/{id}/collab-token` 申请单文档 2h token，连接 WebSocket 时携带 |
| 可分享 | URL 携带 `?space=&doc=`，刷新 / 分享可还原当前视图 |

**技术决策（已确认）**：Vue 3.4 + Vite 5 + TypeScript；编辑器 Tiptap 2（`@tiptap/vue-3`）+ Yjs 13 + `@hocuspocus/provider`；`naive-ui` 在依赖中但当前未真正使用（如需引入请谨慎，避免与手写样式冲突）。

---

## 2. 功能设计

入口 `src/main.ts` → `App.vue` 作为唯一根组件，承载全部业务状态，按需挂载各子组件：

```
App.vue（顶层状态机）
├─ 会话层：loadSession / saveSession / 401 回调 / boot（校验 token + 拉空间 + 拉文档）
├─ 视图层
│  ├─ LoginView.vue            未登录时独占
│  └─ 已登录布局
│     ├─ 顶栏：账号管理(管理员) / 修改密码 / 头像 / 退出
│     ├─ 侧栏：空间列表 + 文档树(DocTree) + 新建入口
│     ├─ 正文区：面包屑 + 标题 + 文档操作 + CollabEditor
│     └─ 弹窗：CreateSpaceModal / MembersModal / AdminUsersModal / ChangePasswordModal
└─ 协同层：ensureCollabToken（切文档重申请）+ CollabEditor（挂载 Yjs/HocuspocusProvider）
```

关键交互逻辑（集中在 `App.vue`）：

1. **权限驱动 UI**：`canWrite = role !== 'VIEWER'`、`canManageMembers = role === 'OWNER'`、`isTeam = type === 'TEAM'`。前端只做**体验层收敛**，真正的拦截在后端 Service 层。
2. **协同 token 跟随文档**：`watch(currentDoc)` → `ensureCollabToken`，切文档即重申请；`collabReady` 为 false 时显示「正在申请协同权限…」，拿到后才挂载 `CollabEditor`（`:key=collabKey` 确保切文档销毁旧 provider 换新房间）。
3. **URL 同步**：`space` / `doc` 写入 query（`history.replaceState`），刷新或分享可还原；被移出当前空间时回落到首个可见空间。
4. **拖拽改层级**：`DocTree` 计算落点区域（上/中/下 → 前插/成为子文档/后插），根部虚线框=提到根目录；后端 `moveDoc` 算法一致（同级重编号 1..n）。
5. **会话失效回调**：`api.ts` 在非登录类接口收到 401 时调用 `onUnauthorized` 清空会话回登录页，避免越权被误踢。

---

## 3. 数据实体设计（前端类型模型）

前端不持有数据库，数据来自后端 REST + 协同服务；本地仅用 `localStorage` 保存会话。核心类型定义在 `src/api.ts`：

| 类型 | 字段 | 说明 |
|---|---|---|
| `Session` | `{ token: string, user: User }` | 登录态 |
| `User` | `{ id, username, displayName, color, admin }` | 当前用户（无密码字段） |
| `Workspace` | `{ id, name, type:'PERSONAL'\|'TEAM', ownerName, role:Role\|null, memberCount }` | 空间视图（`role`=当前用户在此空间的角色） |
| `Doc` | `{ id, workspaceId, parentId, title, collabKey, sortOrder, updatedAt }` | 文档扁平结构（前端组树） |
| `Member` | `{ userId, username, displayName, color, role, joinedAt }` | 成员视图 |
| `AuthConfig` | `{ registrationOpen, hasUsers, registrationMode }` | 实例注册策略 |
| `Role` | `'OWNER' \| 'EDITOR' \| 'VIEWER'` | 角色联合类型 |

> 这些类型与后端 DTO 一一对应；`collabKey` 同时是 Yjs 房间名与协同服务落盘文件名。

---

## 4. 表结构设计（本地存储 / 状态模型）

**前端无关系型表结构**。数据持久化分两类：

### 4.1 `localStorage`（会话）
| Key | 内容 | 说明 |
|---|---|---|
| `lightdoc.token` | JWT 字符串 | 登录态，每次请求放 `Authorization: Bearer` |
| `lightdoc.user` | `User` 的 JSON | 登录用户信息（含 `admin`、`color`） |

会话读写封装在 `api.ts` 的 `loadSession / saveSession / clearSession`。

### 4.2 内存状态（`App.vue` 的 `ref`）
| 状态 | 类型 | 含义 |
|---|---|---|
| `session` | `Session \| null` | 当前登录态 |
| `workspaces` | `Workspace[]` | 我的空间列表 |
| `currentSpaceId` | `number \| null` | 当前空间 |
| `docs` | `Doc[]` | 当前空间文档（扁平） |
| `currentDocId` | `number \| null` | 当前文档 |
| `collabToken` / `collabKeyOfToken` | `string` | 当前文档协同 token 及绑定房间 |

### 4.3 协同数据（来自 Node 服务，非前端存储）
文档正文是 Yjs `Y.Doc` 二进制态，由协同服务落盘在服务器 `collab/data/{collabKey}.bin`，前端仅在内存中持有 `Y.Doc` 实例，不持久化。

---

## 5. 包结构组织

```
frontend/
├─ index.html                   SPA 入口
├─ package.json                Vue3 + Vite + Tiptap + Yjs + Hocuspocus
├─ vite.config.ts              base=VITE_BASE；dev 代理 /api→:8080
├─ tsconfig.json
├─ scripts/
│  └─ verify-collab.mjs        协同链路自检（双客户端验证实时同步，退出码 0/1）
└─ src/
   ├─ main.ts                  创建应用，挂载 App
   ├─ App.vue                  ★ 顶层状态机 + 布局 + 全部业务逻辑
   ├─ api.ts                   ★ 类型定义 + fetch 封装 + 所有 REST 调用
   ├─ config.ts                COLLAB_URL / API_BASE 环境解析
   ├─ style.css                全局样式 + 设计变量（含 Tiptap/ProseMirror 样式）
   └─ components/
      ├─ LoginView.vue         登录/注册页（拉取注册策略后收口 UI）
      ├─ DocTree.vue           文档树：组树/重命名/拖拽改层级/防环
      ├─ CollabEditor.vue      ★ Yjs+Hocuspocus 编辑器 + 斜杠菜单 + 协同光标
      ├─ CreateSpaceModal.vue  新建空间（个人/团队二选一）
      ├─ MembersModal.vue      成员管理（邀请/改角色/移除）
      ├─ AdminUsersModal.vue   账号管理（建号/重置密码/改管理员）
      ├─ ChangePasswordModal.vue 改密（返回新 token 续用）
      └─ ModalShell.vue        通用弹窗外壳（遮罩/标题/插槽）
```

设计要点：
- **`api.ts` 是唯一网络边界**：所有 REST 调用集中于此，统一注入 token、解析错误、处理 401；`setUnauthorizedHandler` 回调避免 api 层反向依赖组件。
- **`CollabEditor.vue` 是协同核心**：扩展集（StarterKit/Task/Table/Collaboration/CollaborationCursor）必须与 `tools/md-to-collab` 转换器**逐项一致**，否则导入的表格等内容会被客户端 schema 静默丢弃。
- **`DocTree.vue` 拍平渲染**：把扁平 `Doc[]` 按 `parentId` 组成 `childMap` 再递归拍平成带 `depth` 的行，比递归组件更可控；拖拽防环用 `subtreeIds` 排除后代。

---

## 6. 接口设计

前端通过 `api.ts` 调用后端 REST（基础前缀 `API_BASE`，默认 `/api`，生产为 `/lightdoc/api`）。WebSocket 协同地址 `COLLAB_URL`（开发 `ws://localhost:1234`，生产 `/lightdoc/collab`）。

### 6.1 REST 调用清单
| api.ts 方法 | 方法 | 路径 | 说明 |
|---|---|---|---|
| `authConfig()` | GET | `/auth/config` | 实例注册策略（公开） |
| `login(u,p)` | POST | `/auth/login` | `{username,password}` |
| `register(u,p,dn?)` | POST | `/auth/register` | 注册（受开关约束） |
| `me()` | GET | `/auth/me` | 当前用户 |
| `changePassword(o,n)` | POST | `/auth/change-password` | 返回新 token |
| `adminUsers()` | GET | `/admin/users` | 账号列表（管理员） |
| `adminCreateUser(p)` | POST | `/admin/users` | 建号（管理员） |
| `adminResetPassword(id,p)` | POST | `/admin/users/{id}/reset-password` | 重置密码 |
| `adminSetAdmin(id,admin)` | PATCH | `/admin/users/{id}` | 改管理员 |
| `listWorkspaces()` | GET | `/workspaces` | 我的空间 |
| `createWorkspace(n,t)` | POST | `/workspaces` | 建空间 |
| `listMembers(wsId)` | GET | `/workspaces/{id}/members` | 成员列表 |
| `inviteMember(wsId,u,r)` | POST | `/workspaces/{id}/members` | 邀请 |
| `changeMemberRole(wsId,uid,r)` | PATCH | `/workspaces/{id}/members/{userId}` | 改角色 |
| `removeMember(wsId,uid)` | DELETE | `/workspaces/{id}/members/{userId}` | 移除 |
| `listDocs(wsId)` | GET | `/workspaces/{id}/docs` | 文档树（扁平） |
| `getDoc(id)` | GET | `/docs/{id}` | 单篇元数据 |
| `createDoc(p)` | POST | `/docs` | 新建（可带 parentId） |
| `renameDoc(id,title)` | PATCH | `/docs/{id}` | 重命名 |
| `moveDoc(id,parentId,index)` | PATCH | `/docs/{id}` | 移动（`{moveParent:true,...}`） |
| `deleteDoc(id)` | DELETE | `/docs/{id}` | 软删除（返回 deleted 数） |
| `collabToken(docId)` | GET | `/docs/{id}/collab-token` | 单文档协同 token |

### 6.2 协同 WebSocket 契约
- **地址**：`COLLAB_URL` 固定端点（生产 `/lightdoc/collab`），文档名（房间）由 `HocuspocusProvider` 的 `name` 传入（= `collabKey`），走协议消息而非 URL 路径。
- **握手 token**：连接时携带 `collabToken(docId)` 返回的 token（声明 `typ=collab`、`doc=<collabKey>`）。鉴权失败 → `onAuthenticationFailed` → 提示刷新重登。
- **在线人数**：`onAwarenessChange` 的 `states.length - 1`（减去自己）。
- **发布校验**：`scripts/verify-collab.mjs` 用同一 token 起两个客户端，验证一端写入被另一端收到（退出码 0=通过），可用于发版后自动化校验。

---

## 7. 运行与构建

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173，/api 代理到 :8080

# 生产构建（挂在 /lightdoc/ 前缀）
VITE_BASE=/lightdoc/ npm run build   # 产物 frontend/dist/

# 协同链路自检
COLLAB_URL=ws://47.117.110.143/lightdoc/collab \
COLLAB_TOKEN=$TOKEN DOC_NAME=<collabKey> node scripts/verify-collab.mjs
```

环境变量：`VITE_BASE`（部署前缀）、`VITE_API_BASE`（可选覆盖 API 前缀）、`VITE_COLLAB_URL`（可选覆盖协同地址）；未设置时按 `import.meta.env.DEV` 自动判断开发与生产地址。

---

## 8. 已知边界（前端侧）

- 只读依赖 `collabKey` 一致的扩展集与后端成员角色；彻底服务端隔离需 Node 协同服务配合（见 backend README）。
- 撤销是「下一次连接生效」：被移除成员后已建立的 WebSocket 不会被立即踢，最长 2 小时。
- `naive-ui` 已被列入依赖但当前未使用；若启用需统一设计语言，避免与 `style.css` 手写样式冲突。

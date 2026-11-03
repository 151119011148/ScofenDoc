# backend · 轻量协同文档 · 业务后端

> 本文档面向**后端维护者**。它描述 `backend/` 这个 Spring Boot 应用的需求设计、功能设计、数据实体设计、表结构设计、包结构组织与接口设计。
> 协同链路（WebSocket / Yjs）、前端、部署与密钥管理的整体说明见仓库根目录 `README.md`。

---

## 1. 需求设计

`backend` 是「轻量协同文档（light-doc）」的业务中枢，承担**除正文实时同步之外的一切**：账号、空间、文档树、权限判定与协同身份签发。正文本身由前端经 Node 协同服务（Hocuspocus）走 Yjs CRDT 同步，后端不存储正文。

核心需求拆解：

| 需求域 | 说明 |
|---|---|
| 账号体系 | 注册 / 登录（BCrypt 密码哈希）、JWT 登录态、退出登录、自助改密 |
| 注册策略 | 默认 `closed`（仅管理员开号）；库里零账号时开放引导注册，第一个注册者自动成为管理员，避免闭环死锁 |
| 管理员 | 创建账号、重置他人密码、授予 / 取消管理员；不允许取消自己，避免锁死 |
| 空间与协作 | 个人空间 / 团队空间两类；团队空间含成员表与三种角色 `OWNER / EDITOR / VIEWER` |
| 权限隔离 | 权限一律查 `workspace_member`；非成员一律 403；文档继承所属空间的角色 |
| 文档树 | 任意层级父子文档、同级排序、行内重命名、级联软删除、拖拽改层级（带防环） |
| 协同身份 | 每切一篇文档签发一个 2 小时有效的单文档协同 token；无效 / 越权 token 直接被协同服务拒绝 |
| 只读体验 | `VIEWER` 在前端被收敛为不可编辑；服务端协同时长约束见「已知边界」 |

**技术决策（已确认）**：Spring Boot 3.3.4 + Java 17；MySQL 8；数据访问用 JPA（Spring Data）；鉴权用 JWT（HS256），区分 auth / collab 两类 token。

---

## 2. 功能设计

按分层职责，对外能力收口在 6 个 Controller，对内逻辑落在 3 个 Service，权限判定统一在 `MembershipService`。

```
Controller 层（HTTP 边界）
├─ HealthController      健康检查
├─ AuthController       登录 / 注册 / me / 改密
├─ AdminController      管理员：账号列表 / 创建 / 重置密码 / 改管理员
├─ WorkspaceMemberController  空间成员：列表 / 邀请 / 改角色 / 移除
└─ DocController        空间列表 / 文档树 / 新建 / 重命名 / 移动 / 删除 / 协同 token

Service 层（业务规则）
├─ AuthService          注册开关、首个用户认领历史空间、改密失效、管理员建号
├─ DocumentService      空间与文档元数据、拖拽算法、协同 token 签发
└─ MembershipService    ★ 权限真相源：requireView / requireWrite / requireManage

Repository 层（JPA）
└─ UserRepository / WorkspaceRepository / WorkspaceMemberRepository / DocRepository

安全层（security）
└─ JwtService 签发校验 / JwtAuthFilter 解析并比对 tokenVersion / CurrentUser 取当前用户

配置层（config）
└─ SecurityConfig 无状态 JWT 安全链 / DataSeeder 种子与成员表回填
```

关键业务规则：

1. **权限只看成员表**：`workspace.owner_id` 只表示「谁建的」，真正的访问控制查 `workspace_member`。任何 Service 都不自行比对 `ownerId`，避免漏判。
2. **查不到即 403**：业务异常统一抛 `ForbiddenException`，不区分「不存在」和「不是你的」，防止被探测文档存在性。
3. **改密即时失效**：`User.tokenVersion` 在改密 / 被重置密码时 `+1`，`JwtAuthFilter` 每次请求比对 token 里的 `pv`，不一致即按未登录处理——旧设备立刻掉线，当前设备拿到新 token 继续。
4. **首个用户认领**：库里无账号时注册开放；注册后接管 `owner_id` 为空的遗留空间并补 OWNER 成员行（`AuthService.adoptOrphanWorkspaces`）。
5. **防环移动**：`DocumentService.moveDoc` 在落库前校验目标不可是自己的后代；落库时对同级兄弟整体重编号 1..n，避免排序值膨胀。

---

## 3. 数据实体设计

四个 JPA 实体，包路径 `com.lightdoc.entity`：

### 3.1 `User` — 账号
- 表名 `app_user`（`user` 是 MySQL 8 保留字，刻意避开）。
- `passwordHash` 仅存 BCrypt 哈希（长度 60，留 100 余量）。
- `color`：协同光标颜色，登录时随 `UserDto` 下发，保证同一人跨文档颜色稳定。
- `admin`：是否管理员；第一个注册者自动 `true`。
- `tokenVersion`：改密 / 被重置时 `+1`，用于使旧 token 失效。

### 3.2 `Workspace` — 空间
- 文档的顶层容器，也是权限边界。
- `type`：枚举 `PERSONAL / TEAM`。个人空间接口层拒绝共享。
- `ownerId` 为 `null` 表示升级前无登录版本的遗留空间，待首个注册用户认领。

### 3.3 `WorkspaceMember` — 空间成员（权限真相源）
- `(workspace_id, user_id)` 唯一约束，避免同一人重复加入导致角色歧义。
- `role`：枚举 `OWNER / EDITOR / VIEWER`，含 `canWrite()`、`canManage()` 判定。
- 一个空间有且仅有一个 `OWNER`，其角色不可被修改或移除。

### 3.4 `Doc` — 文档元数据
- **正文不在 MySQL**（正文是 Yjs 二进制态，由协同服务落盘到 `collab/data/{collabKey}.bin`）。
- `parentId` 为 `null` 即根文档；非 null 构成任意深度父子树。
- `collabKey`：UUID，即 Yjs 房间名（协同服务落盘文件名），全局唯一。
- `deleted`：软删除，保留协同二进制文件以便恢复。
- `@PreUpdate` 在每次更新时刷新 `updatedAt`。

---

## 4. 表结构设计

> 引擎 InnoDB，字符集 `utf8mb4`。以下为 JPA（`ddl-auto: update`）自动落地的等效结构，可直接作为建表参考。

### 4.1 `app_user`
| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | BIGINT | PK, AUTO_INCREMENT | 主键 |
| `username` | VARCHAR(64) | NOT NULL, UNIQUE | 登录名 |
| `password_hash` | VARCHAR(100) | NOT NULL | BCrypt 哈希 |
| `display_name` | VARCHAR(64) | NOT NULL | 昵称（协同光标显示） |
| `color` | VARCHAR(16) | NOT NULL, DEFAULT '#3370ff' | 协同光标颜色 |
| `is_admin` | TINYINT(1) | NOT NULL, DEFAULT 0 | 是否管理员 |
| `token_version` | INT | NOT NULL, DEFAULT 0 | 改密失效计数器 |
| `created_at` | DATETIME | NOT NULL | 创建时间 |

唯一索引：`uk_user_username(username)`。

### 4.2 `workspace`
| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | BIGINT | PK, AUTO_INCREMENT | 主键 |
| `name` | VARCHAR(100) | NOT NULL | 空间名 |
| `type` | VARCHAR(20) | NOT NULL | `PERSONAL` / `TEAM` |
| `owner_name` | VARCHAR(64) | NULL | 创建者昵称（展示用） |
| `owner_id` | BIGINT | NULL | 归属用户 id（null=遗留空间待认领） |
| `sort_order` | INT | NOT NULL, DEFAULT 0 | 空间排序 |
| `created_at` | DATETIME | NOT NULL | 创建时间 |

索引：`idx_workspace_owner(owner_id)`。

### 4.3 `workspace_member`（权限真相源）
| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | BIGINT | PK, AUTO_INCREMENT | 主键 |
| `workspace_id` | BIGINT | NOT NULL | 空间 id |
| `user_id` | BIGINT | NOT NULL | 用户 id |
| `role` | VARCHAR(16) | NOT NULL | `OWNER` / `EDITOR` / `VIEWER` |
| `created_at` | DATETIME | NOT NULL | 加入时间 |

唯一约束：`uk_member_workspace_user(workspace_id, user_id)`。
索引：`idx_member_user(user_id)`、`idx_member_workspace(workspace_id)`。

### 4.4 `doc`
| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | BIGINT | PK, AUTO_INCREMENT | 主键 |
| `workspace_id` | BIGINT | NOT NULL | 所属空间 |
| `parent_id` | BIGINT | NULL | 父文档 id（null=根） |
| `title` | VARCHAR(200) | NOT NULL | 文档标题 |
| `collab_key` | VARCHAR(64) | NOT NULL, UNIQUE | Yjs 房间名 / 落盘文件名 |
| `sort_order` | INT | NOT NULL, DEFAULT 0 | 同级排序 |
| `deleted` | TINYINT(1) | NOT NULL, DEFAULT 0 | 软删除标记 |
| `created_at` | DATETIME | NOT NULL | 创建时间 |
| `updated_at` | DATETIME | NOT NULL | 更新时间 |

索引：`idx_doc_workspace(workspace_id)`、`idx_doc_parent(parent_id)`、`uk_doc_collab_key(collab_key)`（唯一）。

---

## 5. 包结构组织

```
com.lightdoc
├─ LightDocApplication.java       启动类
├─ config
│  ├─ SecurityConfig.java         无状态 JWT 安全链 + JSON 401/403
│  └─ DataSeeder.java             种子空间/文档 + 幂等回填成员行
├─ controller
│  ├─ HealthController.java
│  ├─ AuthController.java
│  ├─ AdminController.java
│  ├─ WorkspaceMemberController.java
│  ├─ DocController.java
│  └─ ApiExceptionHandler.java    @RestControllerAdvice 统一异常→JSON
├─ service
│  ├─ AuthService.java
│  ├─ DocumentService.java
│  └─ MembershipService.java      ★ 权限唯一入口
├─ repository
│  ├─ UserRepository.java
│  ├─ WorkspaceRepository.java
│  ├─ WorkspaceMemberRepository.java
│  └─ DocRepository.java
├─ entity
│  ├─ User.java  Workspace.java  WorkspaceMember.java  Doc.java
├─ dto
│  ├─ AuthConfigDto.java  AuthResponse.java  UserDto.java
│  ├─ WorkspaceDto.java   DocDto.java        MemberDto.java  CollabTokenDto.java
└─ security
   ├─ JwtService.java            HS256 签发/校验（auth/collab 两类）
   ├─ JwtAuthFilter.java         解析 Bearer，比对 tokenVersion
   ├─ AuthUser.java              登录态 principal（不可变 record）
   ├─ CurrentUser.java           取当前用户（取不到即 401）
   ├─ UnauthorizedException.java 401
   └─ ForbiddenException.java    403
```

> 注：Controller 内联的 `record`（如 `Credentials`、`CreateDocRequest`）是请求体载体，未单列到 `dto`。

---

## 6. 接口设计

基础前缀：`/api`。生产经 Nginx 挂在 `/lightdoc/api/`（见根 README 部署章节）。

**鉴权约定**：除 `/api/health`、`/api/auth/config`、登录注册接口外，所有接口需 `Authorization: Bearer <token>`。缺失 / 过期 → **401**；越权（非成员 / 角色不足 / 非管理员）→ **403**。注意 401 与 403 必须区分——前端 `api.ts` 仅在非登录类 401 时才清空会话跳登录，否则越权操作会被误踢下线。

| 方法 | 路径 | 鉴权 | 说明 / 请求体 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 返回 `{status:"ok", service:"light-doc-backend"}` |
| GET | `/api/auth/config` | 公开 | 实例注册策略 `{registrationOpen, hasUsers, registrationMode}` |
| POST | `/api/auth/register` | 公开（受开关约束） | `{username, password, displayName?}` → `{token, user}` |
| POST | `/api/auth/login` | 公开 | `{username, password}` → `{token, user}` |
| GET | `/api/auth/me` | 登录 | 返回当前用户信息（含 `admin`） |
| POST | `/api/auth/change-password` | 登录 | `{oldPassword, newPassword}` → 新 `{token, user}` |
| GET | `/api/admin/users` | 管理员 | 账号列表 |
| POST | `/api/admin/users` | 管理员 | `{username, password, displayName?, admin?}` → 新账号 |
| POST | `/api/admin/users/{id}/reset-password` | 管理员 | `{password}` → `{reset:true}` |
| PATCH | `/api/admin/users/{id}` | 管理员 | `{admin}` → 更新后账号（不可取消自己） |
| GET | `/api/workspaces` | 登录 | 我的空间列表（含 `role`、`memberCount`） |
| POST | `/api/workspaces` | 登录 | `{name, type}` → 新空间（`PERSONAL`/`TEAM`） |
| GET | `/api/workspaces/{id}/members` | 成员 | 成员列表（所有成员可见，无敏感字段） |
| POST | `/api/workspaces/{id}/members` | 仅 OWNER | `{username, role}` 邀请（仅 TEAM） |
| PATCH | `/api/workspaces/{id}/members/{userId}` | 仅 OWNER | `{role}` 改角色（不能改 OWNER） |
| DELETE | `/api/workspaces/{id}/members/{userId}` | 仅 OWNER | 移除成员（不能移除 OWNER） |
| GET | `/api/workspaces/{id}/docs` | 成员 | 该空间文档（扁平 + `parentId`） |
| POST | `/api/docs` | 写权限 | `{workspaceId, parentId?, title?}` 新建 |
| GET | `/api/docs/{id}` | 成员 | 单篇元数据 |
| PATCH | `/api/docs/{id}` | 写权限 | 重命名 `{title}` 或 移动 `{moveParent:true, parentId, index}` |
| DELETE | `/api/docs/{id}` | 写权限 | 软删除（级联子树）→ `{deleted:n}` |
| GET | `/api/docs/{id}/collab-token` | 成员 | 签发本篇协同 token（2h）→ `{token, expiresIn}` |

### 6.1 关键请求/响应结构（DTO）

- **AuthResponse** `{ token: string, user: UserDto }`
- **UserDto** `{ id, username, displayName, color, admin }`（不含任何密码字段）
- **WorkspaceDto** `{ id, name, type, ownerName, role, memberCount }`（`role` = 当前用户在空间的角色）
- **DocDto** `{ id, workspaceId, parentId, title, collabKey, sortOrder, updatedAt }`（扁平，前端自行组树）
- **MemberDto** `{ userId, username, displayName, color, role, joinedAt }`
- **CollabTokenDto** `{ token, expiresIn }`
- **AuthConfigDto** `{ registrationOpen, hasUsers, registrationMode }`

### 6.2 协同 token 契约（与 Node 协同服务共享）

`JwtService.issueCollabToken` 签发，声明 `typ=collab` 并绑定 `doc=<collabKey>`，仅对本篇文档房间有效、默认 2 小时过期。协同服务 `collab/server.js` 校验 `typ` 与 `doc` 双重匹配，任一不符即断开。密钥由 `JWT_SECRET` 经 SHA-256 派生（与 Node 端一致的派生方式），两端必须相同。

---

## 7. 配置项（application.yml / 环境变量）

| 配置 / 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_PORT` | `8080` | 生产由 systemd 传 `8081`（8080 被同机另一服务占用） |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | 本地 MySQL `light_doc` | 生产在 `backend.env` 注入 |
| `DB_POOL_SIZE` | `5` | 小内存机器限制连接数 |
| `REGISTRATION_MODE` | `closed` | `closed`(默认) / `open` |
| `JWT_SECRET` | dev 占位串 | 与 Node 协同服务共享，SHA-256 派生 HS256 密钥 |
| `JWT_TTL_SECONDS` | `604800` | 登录态 7 天 |
| `JWT_COLLAB_TTL_SECONDS` | `7200` | 协同 token 2 小时 |

---

## 8. 运行与构建

```bash
# 本地（需 MySQL；无 MySQL 可在 application.yml 注释放 H2）
cd backend
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-DJWT_SECRET=dev-secret"

# 生产打包
mvn -B -DskipTests clean package   # 产出 target/light-doc-backend-0.1.0.jar
```

依赖见 `pom.xml`：Spring Boot Starter Web / Data JPA / Security + MySQL Connector/J + JJWT 0.12.6（HS256）。

---

## 9. 已知边界（接口侧）

- 只读是前端约束，服务端协同未做硬隔离（VIEWER 拿到的 token 与编辑者同构）。彻底隔离需在 Node 侧解析 Yjs 更新按角色丢弃，或加「只读房间」机制。
- 账号不可删除，只能停用式处理（移出所有空间 + 重置密码）。
- 撤销是「下一次连接生效」：移除成员后其已建立的 WebSocket 不会被立即踢，协同 token 最长 2 小时有效（有意的取舍）。

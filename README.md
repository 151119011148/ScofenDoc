# scofenDoc · 轻量协同文档

类飞书文档的**轻量自托管**实现（Demo 阶段）。前端 Vue3 + Tiptap + Yjs，实时协同走 Node(Hocuspocus)，业务后端 Java(Spring Boot) + JPA + MySQL。

**线上地址：http://47.117.110.143/scofendoc/**

> 实例当前是「0 账号」状态：**第一个打开并注册的人就是管理员**，并接管已有的「我的空间 / 团队空间」。
> 注册完成后入口自动关闭，后续成员由管理员在「账号管理」里创建，建号后再按用户名邀请进团队空间。

## 当前已实现

| 能力 | 说明 |
|---|---|
| 账号体系 | 注册/登录（BCrypt 存密码）、JWT 登录态、退出登录、**自助改密** |
| 注册开关 | **默认关闭**（`closed`），账号由管理员创建；库中无账号时开放引导注册，首个账号自动成为管理员 |
| 管理员 | 创建账号、重置他人密码、授予/取消管理员；不能取消自己，避免把自己锁在门外 |
| 团队协作 | 空间成员表 + 三种角色：`OWNER` 所有者 / `EDITOR` 可编辑 / `VIEWER` 仅查看 |
| 权限隔离 | 权限一律查 `workspace_member`；非成员一律 403，文档继承所属空间角色 |
| 只读体验 | `VIEWER` 进空间时：工具栏换成「仅查看」提示、编辑器不可编辑、隐藏新建/改名/删除、禁用拖拽 |
| 个人空间 / 团队空间 | 建空间时选类型；个人空间不可共享（接口层面拒绝），团队空间按成员共享 |
| 文档列表 | 侧栏文档树，按同级 sortOrder 排序 |
| 父子文档 | 任意层级嵌套；树内可折叠、可「＋」建子文档；面包屑展示层级路径 |
| 拖拽改层级 | 拖到行上/下边缘=同级调序，拖到行中间=变成子文档，拖到底部虚线框=提到根目录；自带防环 |
| 文档操作 | 新建（根/子）、行内重命名、双击重命名、删除（级联子树软删，删完自动定位到相邻文档） |
| 块编辑器 | 输入 `/` 弹出块菜单（标题/列表/待办/引用/代码块/**表格**/分割线），支持方向键、拼音搜索 |
| 表格 | 单元格可编辑、表头行、光标在表格内时出现「+行/+列/-行/-列/删表」 |
| 选区工具条 | 选中文字弹出浮动格式条：标题/列表下拉、段落排版、加粗、删除线、斜体、下划线、链接、行内代码、字体颜色、更多、评论 |
| 跨多行格式 | 选中多段文字一次统一设置对齐 / 行高 / 字号（浮动条段落面板或顶部 ¶ 下拉）；混合格式有第三态；清除格式同时清段落属性 |
| 标题折叠 | hover 标题出三角，点一下折起该标题到下个同级/更高级标题之间的整段内容（段落、**配图**、表格、代码块一起收），折叠态写在文档里跟着协同同步，大纲里被折起的条目同步隐藏 |
| 内容搜索 | 标题 + 章节号 + 正文全文；正文命中显示带关键词高亮的上下文片段（协同进程内索引，不引入 ES） |
| 批注 | 选中文字写评论；锚点在正文、内容在 `ydoc.getMap('comments')`，支持回复、标记已解决、删除，刷新与多人同步都不丢 |
| Markdown 导入 | `tools/publish-md.sh` 单篇、`publish-dir.sh` 整目录批量，支持挂父节点（见「导入已有 Markdown 文档」） |
| 文档互引 | 正文里的 `<a>` 可点：站内链接写成 `?space=&doc=`，点击在站内切文档（不整页刷新），带 `&h=` 的还会滚到对应标题/分组；外链新标签打开 |
| 多文档协同 | 每篇文档独立 `collabKey`（Yjs 房间），切文档自动换房间，内容互不串档 |
| 实时协同 | 多人同编、彩色光标（显示真实昵称+专属颜色）、在线人数、断线重连 |
| 协同鉴权 | 每次切文档向后端申请 2 小时有效的单文档协同 token；无效/越权 token 直接断开 |
| 持久化 | 元数据（MySQL）+ 正文（Yjs 二进制落盘） |

## 账号与权限

### 注册策略

`scofendoc.auth.registration-mode`（环境变量 `REGISTRATION_MODE`）控制：

| 值 | 行为 |
|---|---|
| `closed`（默认） | 只有管理员能开号；**例外**：库里一个账号都没有时允许注册（引导） |
| `open` | 允许自助注册 |

引导口子是必须的——否则新实例把注册关了，就没人能创建第一个账号。
第一个注册的账号 `is_admin = true`，并自动接管 `owner_id` 为空的历史空间。

### 角色与权限边界

| 角色 | 看文档 | 建/改/移/删文档 | 管成员 | 连协同 |
|---|---|---|---|---|
| `OWNER` 所有者 | ✅ | ✅ | ✅ | ✅ |
| `EDITOR` 可编辑 | ✅ | ✅ | ❌ | ✅ |
| `VIEWER` 仅查看 | ✅ | ❌（403） | ❌ | ✅（客户端只读） |

- 一个空间有且仅有一个 `OWNER`，其角色不可被修改、不可被移除。
- 邀请按**用户名**（注册关闭后用户名是双方都确定的标识），不需要邮件通道。
- 成员列表所有成员可见（协作时需要知道有谁），但不含密码等敏感字段。

### 改密与失效

- 自助改密：`POST /api/auth/change-password`，需校验原密码。
- 改密后 `token_version + 1`，**JwtAuthFilter 每次请求比对 token 里的 `pv`**：
  其它设备上的旧 token 立刻失效，当前设备拿返回的新 token 继续，不会被自己踢下线。
- 管理员重置密码同理，也会让该用户已签发的 token 全部失效。

## 密钥管理

后端与 Node 协同服务共用同一个 `JWT_SECRET`，两边都对它做一次 SHA-256 得到 HS256 密钥。
**任意长度的字符串都可以，但两端必须完全相同**，否则协同连接会全部被判为签名无效。

- 生产由 `deploy/prod/deploy.sh` 的 `ensure_env` 首次生成后写入 `/opt/scofendoc/app/jwt.secret`（600 权限），
  再同步写入 `/opt/scofendoc/app/backend.env` 与 `/opt/scofendoc/collab/collab.env`，**不会每次发布重生成**。
- 主动更换密钥的后果：所有人被强制重新登录、已签发的协同 token 立即失效（客户端刷新即可恢复）。
  操作方式：删掉 `jwt.secret` 后重跑一次发布脚本，并重启两个服务。

## 已确认的技术决策

| 项 | 选择 |
|---|---|
| 数据库 | MySQL 8 |
| 协同层 | Java 主后端 + Node 轻量协同服务（Hocuspocus） |
| 鉴权 | JWT（HS256），区分 auth / collab 两类 token |
| 数据访问 | JPA（Spring Data） |
| 迁移 | Flyway（`db/migration/*.sql`，随后端启动自动执行，不再手动改库） |
| 部署 | systemd 直跑 + Nginx 路径挂载（服务器无 Docker，见下文） |
| 访问方式 | IP 直连（生产再补域名 + HTTPS） |
| 全文检索 | 不引入 Elasticsearch：协同进程内纯文本索引 + 后端代理查询（见下） |

### 为什么内容搜索不引入 Elasticsearch

正文是 Yjs CRDT 二进制（`collab/data/{collabKey}.bin`），Java 后端没有 `y-prosemirror`、
也不挂载该目录，**唯一能解析正文的是协同进程**。所以真正要解决的不是「换一个检索引擎」，
而是把正文从二进制里抽成可检索文本：

- `collab/search-index.js` 遍历 `Y.XmlFragment` 的 `toDelta()` 抽纯文本。不能用
  `XmlText.toString()`，它会把 mark 渲染成 `<bold>…</bold>`，既污染文本又切碎关键词。
  索引只存内存，启动时按文件 mtime 全量重建 —— 这样「停服务 → `scp` 覆盖 `.bin` → 启动」
  的导入旁路也能被覆盖，不需要第二份要和正文保持一致的持久化副本。
- 协同服务在 `127.0.0.1:1235` 暴露 `/internal/search`（用 JWT_SECRET 派生的共享 token，
  只绑回环、不走 Nginx）。Java 后端只把「当前用户可见且未软删的 collabKey」传过去，
  权限边界在入口就收住；协同服务不可用时自动降级成标题搜索，不会 500。
- `onStoreDocument` 落盘后顺手更新单篇索引；`tools/publish-md.sh` 发布末尾再调一次
  `/internal/reindex`，兜住 `NO_RESTART=1` 这种不停服务直接覆盖 `.bin` 的旁路。

**规模依据**：线上 556 篇文档（381 有效）、正文 16MB / 抽文本约 468 万字，全量重建约 3 秒、
进程常驻约 80MB；服务器 2C1.8G（后端 JVM 限 320M、协同 Node 限 512M）。标准 ES 光 JVM heap
就要 1G，在这台机器上不现实。等文档量上万、或确实需要中文分词 / 同义词 / 拼音 / 相关度排序 /
聚合时，再评估 Meilisearch、Typesense 或升配后的 ES。

### 标题折叠的隐藏规则为什么要写成 `.ProseMirror .fold-hidden`

折叠是 ProseMirror 装饰：给被折起小节里的每个顶层块加 `fold-hidden` 类，靠 CSS 收起来。
类选择器 `.fold-hidden`（权重 0,1,0）压不住 `.ProseMirror img { display: block }`（0,1,1）——
正文配图是顶层 `image` 节点，于是折起小节后文字都收进去了、图片还留在页面上。
写成 `.ProseMirror .fold-hidden`（0,2,0）才稳。别再把它简化回单个类。
回归脚本：`node tools/verify-browser/fold-image-check.mjs`（本地冒烟页
`frontend/fold-image-smoke.html`，需要先起 vite dev）。

## 目录结构

```
轻量文档/
├─ frontend/      # Vue3 + Vite + Tiptap + Yjs + HocuspocusProvider
│  └─ scripts/    # verify-collab.mjs 协同链路自检
├─ collab/        # Node Hocuspocus 协同服务（Yjs 实时同步 + 落盘 + JWT 校验）
├─ backend/       # Java / Spring Boot（账号、空间、文档树、协同 token）
│  ├─ security/   # JwtService / JwtAuthFilter / AuthUser / 401·403 异常
│  └─ src/main/resources/db/migration/  # Flyway 版本化迁移（V1 基线 + 后续修复）
├─ deploy/        # docker-compose（备用）+ prod/ 生产部署脚本与 systemd 单元
├─ tools/         # publish-md.sh / publish-dir.sh / relink-all.sh 发布脚本
│  ├─ md-to-collab/    # md→Yjs 转换器、对照表生成、批量结构校验
│  └─ verify-browser/  # 无头浏览器核对（渲染、跳转、读写链路）
└─ README.md
```

## 数据模型与接口

**表**：
- `app_user`（id/username/password_hash/display_name/color/is_admin/token_version/created_at）
- `workspace`（id/name/type/owner_name/owner_id/sort_order）
- `workspace_member`（id/workspace_id/user_id/role/created_at，`(workspace_id,user_id)` 唯一）
- `doc`（id/workspace_id/parent_id/title/collab_key/sort_order/deleted/时间戳）

`parent_id` 为 null 即根文档，非 null 构成父子树；`collab_key` 就是 Yjs 房间名，也是协同服务落盘文件名；
`workspace.owner_id` 为 null 表示历史遗留空间，等首个用户注册时认领。

**权限真相源是 `workspace_member`，不是 `workspace.owner_id`**：
`owner_id` 只表示"谁建的"，共享能力全靠成员表。启动时 `DataSeeder` 会幂等回填
「有 owner 但缺成员行」的空间，避免升级后连所有者自己都进不去。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/config` | **公开**：实例注册策略 `{registrationOpen,hasUsers,registrationMode}` |
| POST | `/api/auth/register` | 注册（受注册开关约束），返回 `{token, user}` |
| POST | `/api/auth/login` | 登录，返回 `{token, user}` |
| GET | `/api/auth/me` | 校验当前 token 并返回用户信息（含 `admin`） |
| POST | `/api/auth/change-password` | 改密 `{oldPassword,newPassword}`，返回新 token |
| GET | `/api/admin/users` | 管理员：账号列表 |
| POST | `/api/admin/users` | 管理员：创建账号 `{username,password,displayName,admin}` |
| POST | `/api/admin/users/{id}/reset-password` | 管理员：重置密码 `{password}` |
| PATCH | `/api/admin/users/{id}` | 管理员：授予/取消管理员 `{admin}` |
| GET | `/api/workspaces` | 我的空间列表（含 `role`、`memberCount`） |
| POST | `/api/workspaces` | 新建空间 `{name,type}`，`type` = `PERSONAL` \| `TEAM` |
| GET | `/api/workspaces/{id}/members` | 成员列表（成员可见） |
| POST | `/api/workspaces/{id}/members` | 邀请 `{username,role}`（仅 OWNER，仅 TEAM） |
| PATCH | `/api/workspaces/{id}/members/{userId}` | 改角色 `{role}`（仅 OWNER） |
| DELETE | `/api/workspaces/{id}/members/{userId}` | 移除成员（仅 OWNER，不能移除所有者） |
| GET | `/api/workspaces/{id}/docs` | 该空间文档（扁平 + parentId，前端组树） |
| POST | `/api/docs` | 新建文档，带 `parentId` 即子文档 |
| GET | `/api/docs/{id}` | 单篇元数据 |
| PATCH | `/api/docs/{id}` | 重命名 `{title}`；或移动 `{moveParent:true,parentId,index}` |
| DELETE | `/api/docs/{id}` | 软删除（级联子树） |
| GET | `/api/docs/{id}/collab-token` | 签发本篇文档的协同 token（2h） |

除 `/api/health`、`/api/auth/config` 与登录注册外，所有接口都要求 `Authorization: Bearer <token>`；
缺失或过期返回 401，越权（非成员 / 角色不够 / 非管理员）返回 403。

## 本地运行（Demo 最小验证）

> 目标：跑通"单文档多人实时协同 + 彩色光标"。

### 1) 启动协同服务
```bash
cd collab
npm install
JWT_SECRET=dev-secret npm start    # 监听 ws://localhost:1234
```
> 本地必须显式给 `JWT_SECRET`，且要和后端启动时用的值一致，否则协同连接会因签名不匹配被拒绝。

### 2) 启动后端
```bash
cd backend
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-DJWT_SECRET=dev-secret"
# 需本地 MySQL；无 MySQL 见 application.yml 内 H2 注释
```

### 3) 启动前端
```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```
> 开发态前端默认请求 `localhost:8080/scofendoc/api`，若端口不同请设 `VITE_API_BASE` / `VITE_COLLAB_URL`。

### 4) 验证
- 打开 http://localhost:5173，**先注册**（首个账号会接管已有空间）
- 复制 URL，在另一个浏览器窗口（或隐身窗口）注册第二个账号 → 两边内容互相不可见（权限隔离生效）
- 用同一账号打开同一篇文档 → 输入会**实时同步**，并显示对方**彩色光标**与"在线协作者 N 人"
- 在正文输入 `/` 试块菜单；拖动左侧文档试改层级
- 关闭页面再打开，内容仍在（collab/data 下已落盘）

## 生产环境（已部署）

**访问地址：http://47.117.110.143/scofendoc/**

服务器实际情况：阿里云 Linux 3 / 2C1.8G，已有 MySQL 8、Redis、Nginx 和另一个 Java 服务（占 8080）。
因此**没有走 Docker Compose**（服务器未装 Docker，1.8G 内存也不适合再叠一层），改为 systemd 直跑 + Nginx 路径挂载：

| 组件 | 位置 | 运行方式 | 端口 |
|---|---|---|---|
| 前端静态 | `/var/www/scofendoc` | Nginx 直接托管，挂在 `/scofendoc/` | 80 |
| Java 后端 | `/opt/scofendoc/app/scofen-doc-backend.jar` | `scofendoc-backend.service`（JVM 上限 320M） | 127.0.0.1:8081 |
| 协同服务 | `/opt/scofendoc/collab` | `scofendoc-collab.service`（Node 20） | 127.0.0.1:1234 |
| 文档持久化 | `/opt/scofendoc/collab/data/*.bin` | ydoc 全量态落盘 | — |
| 数据库 | MySQL 8 `scofen_doc`（账号 `scofendoc`） | 复用服务器现有 MySQL | 3306 |

关键设计：**不新增监听端口、不改现有站点根路径**——只在 `emotion-web.conf` 的 server 块里 include 一个
`/etc/nginx/conf.d/scofendoc.locations`，提供 `/scofendoc/`、`/scofendoc/api/`、`/scofendoc/collab` 三个 location。
所以现有 emotion 站点完全不受影响，也不需要动云服务器安全组。

### 发布 / 回滚

```bash
./deploy/prod/deploy.sh            # 全量发布（前端+协同+后端）
./deploy/prod/deploy.sh frontend   # 只发前端
./deploy/prod/deploy.sh backend    # 只发后端
./deploy/prod/deploy.sh collab     # 只发协同服务
```

脚本做的事：写入/校验 JWT 密钥与数据库环境变量 → 本地构前端（`VITE_BASE=/scofendoc/`）→ rsync 产物 →
服务器上 Maven 打包 → 强制覆盖 systemd 单元 → 重启服务 → `nginx -t` 后 reload → 健康检查。

回滚：`git checkout <上一个提交> && ./deploy/prod/deploy.sh`。
Nginx 配置备份在 `/etc/nginx/conf.d/emotion-web.conf.bak-scofendoc-*`，回滚只需还原该文件并删掉 include 行。

### 数据库迁移（Flyway）

表结构已从 JPA `ddl-auto: update` 切换为 `validate`，完全交给 Flyway 版本化管理。
`backend/src/main/resources/db/migration/` 下的 `V<n>__*.sql` 随后端启动自动执行：

- `V1__baseline.sql`：固化四张表结构（app_user / workspace / workspace_member / doc）。
- `V2__fix_doc_hierarchy.sql`：修复导入拍平导致的父子关系（X.Y.Z 挂回 X.Y）。
- `V3__doc_chapter_hierarchy.sql`：按「第一~六章」在导入根（技术栈）下新建一级章，把拍平的编号子文档按章重挂；幂等可重复执行（2026-11-03 已对线上执行，执行前备份在服务器 `/opt/scofendoc/backup/doc_20261103_hierarchy.sql.gz`）。

线上已有库的接入方式：`spring.flyway.baseline-on-migrate: true` + `baseline-version: 1`，
后端首次升级启动时会自动把非空 schema baseline 到 V1（跳过 V1 建表），再执行 V1 之后的迁移。
全新空库则从 V1 开始建表。**无需手动连库跑任何 SQL**。

新增 DDL/DML 一律写成 `V<n>__描述.sql` 放进 `db/migration/`，随下一次发布自动生效；
不要再用 `tools/sql/` 下的手写脚本（已移除）。

### 运维命令

```bash
systemctl status  scofendoc-backend scofendoc-collab
journalctl -u scofendoc-collab -f          # 协同日志
tail -f /opt/scofendoc/logs/backend.log    # 后端日志
```

### 可选：Docker Compose 方式

`deploy/docker-compose.yml` 仍然保留，适用于**有 Docker 的新机器**（本机已是 systemd 部署，不要重复跑）：

```bash
docker compose -f deploy/docker-compose.yml up --build
```

## 导入已有 Markdown 文档

正文不在 MySQL 里（见上文），所以「发布一篇 md」= 造出与前端编辑器同构的 Yjs 初始状态，
再投放到对应房间。`tools/` 下两个脚本把这件事串起来：

```bash
# 新建一篇（默认进 1 号空间「我的空间」）
./tools/publish-md.sh "../个人履历详解.md" "个人履历详解（2014.07 — 2026.10）"

# 挂到某个父文档下（父文档所属空间优先，避免父子跨空间）
./tools/publish-md.sh "../技术栈/2.4-ZooKeeper分布式协调.md" "2.4-ZooKeeper分布式协调" --parent 17

# 整个目录批量发布到某个父文档下（同级顺序＝文件名排序）
./tools/publish-dir.sh "../技术栈" --parent 17

# 覆盖某一篇的正文（标题可省略，默认沿用线上标题）
./tools/publish-md.sh "../个人履历详解.md" "" --doc-id 13

# 整批重发：给所有已发布的 md 补站内跳转链接（标题沿用线上，正文覆盖）
./tools/relink-all.sh
```

脚本做四件事：`marked` 转 HTML → `generateJSON`（与前端同一套扩展）→ 写入 Yjs 状态
（已有文档走 `--merge-into` 就地替换）→ 建/改 doc 记录 + 上传 `{collabKey}.bin` → 回读校验。
单独用转换器也可以：

```bash
cd tools/md-to-collab && npm i
node md-to-ydoc.mjs a.md /tmp/a.bin --drop-first-h1   # 转换 + 结构统计
node read-ydoc.mjs /tmp/a.bin                          # 回读校验
node rebuild-doc.mjs a.bin a.md /tmp/a.new.bin --numbered  # 按新 md 整体重建（补回标题自动编号属性）
node build-link-manifest.mjs map.tsv link-manifest.json ../技术栈 ../ai学习   # 生成「md → 文档」对照表
node gen-chapter-index.mjs 00-总索引.md ../技术栈                       # 从总索引切出每章索引页（发布到章节点）
node verify-links.mjs link-manifest.json <bin目录>      # 逐篇比对表格/标题/图/代码/链接数
```

## 文档互引与站内跳转

站内链接统一写成 `?space=2&doc=20`（带锚点时追加 `&h=分组标题`），不写死域名——
换域名、换机器都不用重发；外链 http(s) 原样保留，点击时新标签打开。

- **改写**：导入时按 md 文件的**相对路径**解析目标，命中 `link-manifest.json` 就换成深链；
  未发布的本地文件（`CSDN存档/xxx.html` 等）仍去壳留字，点开必 404 的链接不给。
- **点击**：编辑器拦截正文里的 `<a>` 点击，解析 `doc` 参数后交给 App 在站内切文档
  （`selectDoc`，不整页刷新）；跨空间会先切空间。macOS/Windows 下按住 ⌘/Ctrl 点链接不拦截，
  方便把光标放进链接里改字。
- **锚点**：Yjs 正文里没有 heading id（导出 HTML 时的 `id="g-…"` 没有一起搬过来），
  所以按**文字**匹配落点：去掉 `g-` 前缀与标点空白后比较标题或「整段加粗」的分组行。
  文档改写、标题前后加字都不影响。落点会二次对齐（mermaid 图与表格渲染完会改高度）。
- **对照表不是手写的**：`build-link-manifest.mjs` 用「md 文件名 == 线上标题」匹配，
  改过名的文档在脚本里的 `TITLE_ALIAS` 补一行（例：`00-总索引.md` → 站内「总索引」）。

七条踩过的坑：

1. **扩展集必须与 `CollabEditor.vue` 逐项一致**。少一个节点类型（比如 table、link），
   客户端会静默丢掉那类内容——它不会报错，只是表格/链接变没了。
2. **先发前端，再投数据**。旧版编辑器不认识新节点，一打开一保存就把内容洗掉。
3. **中文加粗贴着标点不满足 CommonMark 规则**：`**"记账服务＝分录模板"**，` 里开头的 `**`
   后面紧跟引号、前面是汉字，既不算 left-flanking 也不算 right-flanking，解析器只能输出裸星号。
   转换器先把这类 `**…**` 改写成 `<strong>…</strong>` 再解析（代码块/行内代码里的星号不动）。
   校验时也别把代码块里的 `1024**3`、`**kwargs` 当成残留。
4. **覆盖正文必须「先停服务，再写文件」**。房间一旦被加载（有人正开着、或上次发布后服务读过），
   进程退出时会用内存里的旧状态覆盖磁盘 —— 直接 `restart` 会把刚上传的新正文冲掉。
   批量脚本因此是「停一次 → 逐篇写 → 启动一次」。
5. **覆盖正文还要「就地替换」而不是换一份新历史**。`prosemirrorJSONToYDoc` 造的是全新 CRDT 历史，
   还开着的客户端重连时会把旧历史推回来，合并后旧内容赢（实测：链接整段消失）。
   所以默认 `--merge-into <旧 bin>`：读入旧状态，在同一份历史上删掉全部子节点再插入新内容，
   删除成为 tombstone，任何在线端都会跟着删。真要另起一份历史用 `--fresh`。
6. **表格是编辑器新增能力**：StarterKit 本身不含 table，`/` 菜单可插入表格，
   光标落在表格内时工具栏会多出「+行 / +列 / -行 / -列 / 删表」。
7. **shell 里 `$VAR` 后面紧跟中文标点会被当成变量名的一部分**（macOS bash 3.2 直接报
   `unbound variable`）。脚本里一律写 `${VAR}`；另外 `set -e` 下别用 `[ cond ] && cmd` 的短路写法，
   `while read` 里调子脚本要加 `< /dev/null`，否则子脚本吃掉 stdin，循环只跑第一轮。
8. **加粗不要包着行内代码**。`**` 与反引号挨在一起时会被切成几段 mark：页面上看着是粗的，
   回读出来的 md 却成了 `` - **`await` 会释放锁，`signal` 不会。** `` 以外的断点形式
   （`` `await`** 会释放锁，**`signal`** ``），校对时得多花一轮。要么整句不加粗，要么把
   行内代码挪到加粗范围外面。`rebuild-doc.mjs` 建文档时顺带做过这个检查。

## 选中文字浮动工具条与批注

选中任意文字，正文旁会弹出格式条（对标飞书）：标题下拉、列表下拉、加粗、删除线、斜体、
下划线、链接、行内代码、字体颜色、更多（引用 / 代码块 / 分割线 / 插入表格 / 清除格式）、评论。

- **定位没走 tippy**：`@tiptap/extension-bubble-menu` 在跨行选区、贴近视口边缘、正文里嵌
  图块时位置会飘。这里直接读 `getSelection().getRangeAt(0).getBoundingClientRect()` 做
  `position: fixed`，上方放不下就翻到选区下方；下拉面板默认向上展开，避免盖住刚选中的字。
- **点按钮不丢选区**：工具条按钮全部 `mousedown` + `preventDefault`；链接/评论面板里的
  输入框例外（要真正拿到焦点，靠「面板打开时不因 blur 收起」兜住）。
- **评论的数据分层**：正文只写一个 `mark[data-comment-id]` 锚点，评论正文、作者、时间、
  回复、已解决状态都存在 `ydoc.getMap('comments')` 里。它跟正文同一个 ydoc，一起增量同步、
  一起落进 `{collabKey}.bin`，**后端与表结构都不用改**。
- 已解决的批注显示为灰色虚线下划线，点开可「重新打开」；删除评论会连同正文锚点一起移除。
- 只读成员看不到格式条，但点批注仍能看内容（不能回复/解决/删除）。
- 验收脚本：`node tools/verify-browser/bubble-check.mjs <JWT_SECRET>`，在临时文档里跑完
  加粗/颜色/下划线/链接/标题/评论/刷新持久化/回复/解决/删除全链路，跑完自动删文档。

两条坑：

1. **同类型 mark 改属性必须 `removeMark` + `addMark`**。mark 的 `excludes` 为空时新旧两个
   不会互相替换，直接 `addMark({resolved:true})` 会和旧 mark 并存，DOM 里取到的是先出现的
   那个——表现就是「标记已解决」点了没反应（实测踩到）。
2. **批注锚点是正文节点的一部分**，仍然遵守「先发前端，再投数据」：旧版编辑器不认识
   `comment` mark，会把锚点洗掉（评论 Map 还在，正文里却再也点不到）。

## 已知边界 / 下一步

1. **只读是前端约束，不是服务端硬隔离**：`VIEWER` 拿到的协同 token 与编辑者同构，
   Hocuspocus（OSS 版）没有文档级 readOnly，理论上知道 token 的人可以自己造 Yjs 更新发上去。
   UI 层已经拦住正常路径，但要真隔离，需要在 Node 侧解析 Yjs 更新消息并按角色丢弃，
   或给协同服务加「Java 回调校验 + 只读房间」两套机制。
2. **撤销是"下一次连接生效"**：从空间移除成员后，他**新**的连接/接口调用立即 403，
   但已经建立着的 WebSocket 不会被踢；协同 token 最长 2 小时，这是有意的取舍（换取不引入回调解耦）。
3. **账号不能删**：目前只能停用式处理（移出所有空间 + 重置密码）。
   真要删除要考虑其作为 OWNER 的空间如何转移，属独立议题。
4. 前端：评论侧栏（现在只能点正文里的批注看）、评论通知、历史版本 UI、`@` 提及、图片块。
5. 协同：增量持久化 + 定时快照（当前为全量覆盖）、断线重连后的冲突提示。
6. 部署：域名 + HTTPS（Let's Encrypt）、定期备份 MySQL 与 `collab/data`。

> 注：依赖版本号（Vue/Tiptap/Hocuspocus/Spring Boot）为示例稳定区间，安装时以各包实际最新稳定版为准。

# collab · 轻量协同文档 · 实时协同服务

> 本文档面向**协同服务维护者**。它描述 `collab/` 这个 Node 应用的需求设计、功能设计、数据实体设计、表结构（落盘文件模型）组织、包结构组织与接口设计。
> 业务后端、前端与部署说明见仓库根目录 `README.md` 与各应用 README。

---

## 1. 需求设计

`collab` 是「轻量协同文档」的**实时协同同步层**，填补了「后端只管元数据、不存正文」留下的空白：

| 需求域 | 说明 |
|---|---|
| 实时同步 | 基于 Yjs CRDT，多客户端编辑同一篇文档时自动合并冲突，无需中央锁 |
| 房间隔离 | 每篇文档一个 Yjs 房间（= `collabKey`）；切文档即换房间，内容互不串档 |
| 持久化 | 文档全量态落盘为 `{collabKey}.bin`；重启后从磁盘恢复，内容不丢 |
| 协同鉴权 | 每个连接必须携带后端签发的单文档协同 token（`typ=collab`、`doc=房间名`），无效 / 越权 / 过期立即断开 |
| 在线状态 | 广播 awareness（光标位置、昵称、颜色），前端据此展示彩色光标与在线人数 |
| 轻量部署 | 默认只绑 127.0.0.1，由 Nginx 反代，端口不直接暴露公网 |

**技术决策（已确认）**：Node 20 + `@hocuspocus/server` 2.15（Hocuspocus，Yjs 的 WebSocket 服务端实现）+ `yjs` 13 + `jsonwebtoken` 9。协同层与 Java 后端**共享同一个 JWT 密钥**（双方都做一次 SHA-256 派生 HS256 密钥），两端必须完全相同。

---

## 2. 功能设计

整个服务只有一个文件 `server.js`，通过 Hocuspocus 的钩子（hooks）实现全部逻辑：

```
Hocuspocus Server（Server.configure）
├─ onAuthenticate({token, documentName})   连接鉴权：校验协同 token，返回用户身份
├─ onLoadDocument({document, documentName}) 加载：存在则读 .bin 合并，否则新建空文档
├─ onStoreDocument({document, documentName}) 保存：Y.encodeStateAsUpdate 写回 .bin
├─ onConnect / onDisconnect                连接生命周期日志
└─ listen()                                监听 COLLAB_PORT（默认 1234）
```

关键行为：

1. **鉴权先行**：`onAuthenticate` 调用 `verifyCollabToken`，校验失败直接 `throw`，连接被拒、**文档内容不下发**。三重校验：签名有效 → `typ === 'collab'` → `payload.doc === documentName`。任一不符即断开（token 泄漏也只局限于单篇文档、且 2 小时过期）。
2. **落盘策略**：`onStoreDocument` 用 `Y.encodeStateAsUpdate(document)` 写全量态到 `data/{documentName}.bin`（当前为全量覆盖；增量 + 定时快照为待办）。
3. **用户身份回传**：鉴权通过后在 `user` 里回填 `{ id, name, color }`，前端 `CollaborationCursor` 据此渲染彩色光标。
4. **本地优先加载**：`onLoadDocument` 若磁盘已有 `.bin` 则 `Y.applyUpdate` 合并进内存文档；否则视为新文档。首篇 Demo 文档 `demo-doc.bin` 即由后端 DataSeeder 固定 `collabKey=demo-doc` 延续旧内容。

---

## 3. 数据实体设计

协同服务**没有关系型数据库**，数据实体只有两类：

### 3.1 Yjs 文档（房间）
- 标识：`documentName`（= 前端传的 `collabKey`，= 后端 `doc.collabKey`，= 落盘文件名）。
- 内容：`Y.Doc` 实例，CRDT 二进制态，包含正文（ProseMirror 文档的 Yjs 映射）、以及 awareness（在线光标，瞬态不落盘）。
- 生命周期：连接时 `onLoadDocument` 装载 → 多端实时 `applyUpdate` 合并 → `onStoreDocument` 落盘。

### 3.2 协同 token 载荷（由后端签发，本服务仅校验）
| Claim | 含义 | 校验要求 |
|---|---|---|
| `typ` | 固定 `collab` | 必须等于 `collab`（登录 token 不可用于协同） |
| `sub` | 用户 id | 回填为 awareness 的 `user.id` |
| `doc` | 房间名（collabKey） | 必须等于 `documentName` |
| `dn` | 昵称 displayName | 回填为光标标签 |
| `color` | 光标颜色 | 回填为光标颜色 |
| `exp` | 过期时间 | 默认 2 小时（后端 `JWT_COLLAB_TTL_SECONDS`） |

> 注意：`auth` 类 token（登录态）**不能**拿来临连协同房间——本服务显式拒绝 `typ !== 'collab'`。

---

## 4. 表结构设计（落盘文件模型）

协同服务**无关系型表**。持久化模型是**文件系统**：

```
collab/
└─ data/
   ├─ <collabKey-1>.bin    某篇文档的 Yjs 全量态（ProseMirror 正文 + 结构）
   ├─ <collabKey-2>.bin
   └─ demo-doc.bin         首篇 Demo 文档（collabKey 固定，兼容旧内容）
```

| 项 | 说明 |
|---|---|
| 文件名 | `{documentName}.bin`，`documentName` = `collabKey`（UUID，全局唯一） |
| 内容格式 | `Y.encodeStateAsUpdate(ydoc)` 产出的二进制（Yjs 状态向量 + 更新） |
| 写时机 | 每次文档变更后由 Hocuspocus 触发 `onStoreDocument` |
| 读时机 | 连接建立时 `onLoadDocument`，存在则 `Y.applyUpdate` 恢复 |
| 软删 | 后端删除文档仅置 `doc.deleted=1`，`.bin` 文件保留，便于恢复 |
| 备份 | 运维需定期备份 `collab/data/*.bin` 与 MySQL（见根 README） |

> 若需「导入已有 Markdown 为协同文档」，正文二进制由 `tools/md-to-collab/md-to-ydoc.mjs` 生成后投放到对应 `{collabKey}.bin`（扩展集必须与前端 `CollabEditor.vue` 一致）。

---

## 5. 包结构组织

```
collab/
├─ server.js        ★ 全部逻辑：Hocuspocus 配置 + 钩子 + 鉴权 + 落盘
├─ package.json     @hocuspocus/server + yjs + jsonwebtoken (type: module)
├─ data/            运行时生成：{collabKey}.bin（落盘目录，启动时自动 mkdir）
└─ node_modules/
```

`server.js` 内部结构：

```
常量：DATA_DIR / PORT(1234) / HOST(127.0.0.1) / JWT_SECRET / JWT_KEY(SHA-256 派生)
函数：verifyCollabToken(token, documentName)   —— 三重校验
配置：Server.configure({ port, address, onAuthenticate, onLoadDocument, onStoreDocument, onConnect, onDisconnect })
启动：server.listen()
```

设计要点：
- **密钥派生与后端一致**：`JWT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest()`，与 Java 端 `JwtService` 的 `sha256(secret)` 同算法同输入，保证 HS256 密钥一致。
- **默认回环绑定**：`COLLAB_HOST` 默认 `127.0.0.1`，仅允许本机/Nginx 反代访问，协同端口不直曝公网。
- **单文件服务**：逻辑紧凑、无额外分层，适合小内存机器（systemd `MemoryMax=512M`）。

---

## 6. 接口设计

协同服务**不提供 REST**，只暴露一个 **WebSocket 端点**（Hocuspocus 协议）：

### 6.1 WebSocket 端点
- 开发：`ws://localhost:1234`
- 生产（经 Nginx 反代）：`ws(s)://<host>/lightdoc/collab`
- 文档房间（房间名）由 Hocuspocus 协议消息携带 `name = collabKey`，**不走 URL 路径**。因此 Nginx 需同时精确匹配 `/lightdoc/collab`（无尾斜杠）与 `/lightdoc/collab/`，否则客户端不跟随 301 导致连接失败（见 `deploy/prod/lightdoc.locations`）。

### 6.2 连接握手（鉴权）
客户端（`HocuspocusProvider`）在建立连接时携带 `token`（即后端 `GET /api/docs/{id}/collab-token` 返回）。服务端 `onAuthenticate` 校验流程：

```
收到连接(token, documentName)
  └─ verifyCollabToken
       ├─ jwt.verify(token, JWT_KEY, {algorithms:['HS256']})  签名校验
       ├─ payload.typ === 'collab' ?                        类型校验
       └─ payload.doc === documentName ?                    房间绑定校验
            └─ 通过 → 返回 { user: { id, name, color } }
            └─ 任一失败 → throw → 连接被拒，文档不外发
```

### 6.3 同步协议（Hocuspocus/Yjs）
- 连接建立后，多端通过 Yjs 的 `update` 消息实时同步 CRDT；断线后重连自动合并。
- awareness 通道广播光标位置 / 昵称 / 颜色；服务端透传，不做持久化。
- 文档变更触发 `onStoreDocument` 落盘；连接时 `onLoadDocument` 装载。

### 6.4 与前后端的对接
| 角色 | 职责 | 关键契约 |
|---|---|---|
| 后端 | 签发协同 token（`typ=collab`、`doc=collabKey`、2h） | `JwtService.issueCollabToken` |
| 前端 | 切文档申请 token → 带 token 连 WebSocket | `api.collabToken` + `HocuspocusProvider` |
| collab | 校验 token + 同步 + 落盘 | 本服务 `server.js` |

---

## 7. 运行与部署

```bash
cd collab
npm install
JWT_SECRET=dev-secret npm start        # 监听 ws://localhost:1234（与后端 JWT_SECRET 一致）

# 生产（systemd 单例，见 deploy/prod/lightdoc-collab.service）
COLLAB_PORT=1234 COLLAB_HOST=127.0.0.1 NODE_ENV=production \
  JWT_SECRET=<与后端相同> node server.js
```

依赖见 `package.json`：`@hocuspocus/server@^2.15`、`yjs@^13.6`、`jsonwebtoken@^9.0.2`。

---

## 8. 已知边界

- **只读非服务端硬隔离**：OSS 版 Hocuspocus 无文档级 readOnly。VIEWER 拿到的 token 与编辑者同构，理论上知道 token 者可自造 Yjs 更新发上来；UI 层已拦正常路径，彻底隔离需在 Node 侧解析 Yjs 更新按角色丢弃，或引入「只读房间」。
- **全量落盘**：当前 `onStoreDocument` 覆盖写整篇全量态；增量持久化 + 定时快照为待办。
- **账号删除 ≠ 协同清理**：用户被删除后其已建立的 WebSocket 不会被立即踢，协同 token 最长 2 小时有效（有意的取舍，换取不引入回调解耦）。

import { IncomingMessage, MessageType, Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import http from 'http'
import { fileURLToPath } from 'url'
import jwt from 'jsonwebtoken'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import * as searchIndex from './search-index.js'
import { createCollabFiles } from './versions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.COLLAB_DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const PORT = process.env.COLLAB_PORT || 1234
// 生产由 Nginx 反代到 127.0.0.1，因此默认只绑回环，避免协同端口直接暴露公网
const HOST = process.env.COLLAB_HOST || '127.0.0.1'

// 与 Java 后端共享的 JWT 密钥。
// Java 侧对 JWT_SECRET 做一次 SHA-256 得到 HS256 密钥，这里必须用同样方式派生，
// 否则两边算出的密钥不同，所有协同连接都会被判为签名无效。
const JWT_SECRET = process.env.JWT_SECRET || 'scofendoc-dev-only-secret-change-me'
const JWT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest()

/**
 * 正文检索的内网端口。只绑回环、Nginx 不代理，后端用同一个 JWT_SECRET 派生 token 调用。
 * 单独开一个端口而不挂进 WebSocket 服务，是因为 Hocuspocus 的 onRequest 钩子
 * 与它自己的 upgrade 处理搅在一起不好控；一个极小的 http.Server 更可预测。
 */
const SEARCH_PORT = Number(process.env.COLLAB_SEARCH_PORT || 1235)
const SEARCH_HOST = process.env.COLLAB_SEARCH_HOST || '127.0.0.1'
const SEARCH_TOKEN = crypto.createHash('sha256').update(JWT_SECRET + ':search').digest('hex')
const ACCESS_URL = process.env.COLLAB_ACCESS_URL || 'http://127.0.0.1:8080/internal/collab-access'
const ACCESS_TOKEN = crypto.createHash('sha256').update(JWT_SECRET + ':collab-access').digest('hex')
const LEASE_MS = 10_000
const connections = new Map()

class AccessDenied extends Error {}

async function checkAccess(token, room) {
  const response = await fetch(ACCESS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': ACCESS_TOKEN },
    body: JSON.stringify({ token, room }),
    signal: AbortSignal.timeout(2500),
  })
  if (response.status === 401 || response.status === 403) throw new AccessDenied('协同授权已失效')
  if (!response.ok) throw new Error('协同授权服务不可用')
  const lease = await response.json()
  if (!/^[1-9][0-9]*$/.test(lease.docId) || typeof lease.canWrite !== 'boolean') {
    throw new Error('协同授权响应无效')
  }
  return lease
}

function stopSession(connection, session, reason, code = 4403) {
  if (session.closed) return
  session.closed = true
  connections.delete(connection)
  connection.readOnly = true
  console.info('[access closed]', session.docId, session.userId, reason)
  connection.close({ code, reason })
}

async function renew(connection, session) {
  if (session.closed) throw new Error('协同连接已关闭')
  if (Date.now() >= session.expiry || files.isBlocked(session.room)) {
    stopSession(connection, session, 'room-or-token-expired')
    throw new Error('协同连接已失效')
  }
  if (Date.now() < session.checkAfter) return
  session.pending ??= checkAccess(session.token, session.room)
    .then(lease => {
      if (lease.canWrite !== session.canWrite) throw new AccessDenied('权限已变化')
      session.checkAfter = Date.now() + LEASE_MS
    })
    .catch(error => {
      if (error instanceof AccessDenied) stopSession(connection, session, 'access-changed')
      else stopSession(connection, session, 'access-unavailable', 1013)
      throw error
    })
    .finally(() => { session.pending = null })
  await session.pending
}

function auditReadonlyWrite(document, packet, session) {
  const now = Date.now()
  if (session.canWrite || now < (session.auditAfter ?? 0)) return
  const message = new IncomingMessage(packet)
  message.readVarString()
  const type = message.readVarUint()
  if (type !== MessageType.Sync && type !== MessageType.SyncReply) return
  const step = message.readVarUint()
  const changed = step === messageYjsUpdate || (step === messageYjsSyncStep2
    && !Y.snapshotContainsUpdate(Y.snapshot(document), message.readVarUint8Array()))
  if (changed) {
    session.auditAfter = now + 30_000
    console.warn('[readonly write rejected]', session.docId, session.userId)
  }
}

/**
 * 校验协同 token。
 *
 * token 由 Java 后端 /api/docs/{id}/collab-token 签发，里面带：
 *   typ = collab       —— 只允许协同场景使用（登录 token 不能拿来连房间）
 *   doc = <collabKey>  —— 只允许连这一个文档房间
 * 这样即使 token 泄漏，攻击面也只有单篇文档、且 2 小时后自动失效，
 * 而不是拿到一次就能读遍全站。
 */
function verifyCollabToken(token, documentName) {
  let payload
  try {
    payload = jwt.verify(token, JWT_KEY, { algorithms: ['HS256'] })
  } catch (e) {
    throw new Error(`token 校验失败：${e.message}`)
  }
  if (payload.typ !== 'collab') {
    throw new Error('token 类型不允许用于协同')
  }
  if (payload.doc !== documentName) {
    throw new Error('token 与文档不匹配')
  }
  return payload
}

const server = Server.configure({
  port: PORT,
  address: HOST,

  // 连接鉴权：不通过就直接断开，文档内容不会被下发
  async onAuthenticate({ token, documentName, connection }) {
    if (!token) {
      throw new Error('缺少协同 token')
    }
    const payload = verifyCollabToken(token, documentName)
    if (!/^[A-Za-z0-9-]{1,64}$/.test(documentName) || !Number.isFinite(payload.exp)
        || files.isBlocked(documentName)) throw new Error('房间已失效')
    const lease = await checkAccess(token, documentName)
    if (files.isBlocked(documentName)) throw new Error('房间已失效')
    connection.readOnly = !lease.canWrite
    console.info('[access granted]', lease.docId, payload.sub, lease.canWrite ? 'read-write' : 'readonly')
    return {
      user: { id: payload.sub, name: payload.dn || `用户${payload.sub}`, color: payload.color || '#3370ff' },
      session: { ...lease, token, room: documentName, userId: payload.sub,
        expiry: payload.exp * 1000, checkAfter: Date.now() + LEASE_MS },
    }
  },

  async beforeHandleMessage({ connection, context, document, update }) {
    if (!context?.session) throw new Error('缺少协同授权')
    await renew(connection, context.session)
    if (context.session.closed || files.isBlocked(context.session.room)) throw new Error('协同房间已关闭')
    // 只记录审计。真正写入控制仍由 Hocuspocus 的 readOnly 执行。
    auditReadonlyWrite(document, update, context.session)
  },

  async connected({ connectionInstance, context }) {
    if (!context?.session || context.session.closed) return
    context.session.connection = connectionInstance
    connections.set(connectionInstance, context.session)
  },

  // 加载文档：存在则读取本地 ydoc 二进制，否则新建空文档
  async onLoadDocument({ document, documentName }) {
    const file = path.join(DATA_DIR, `${documentName}.bin`)
    if (fs.existsSync(file)) {
      const update = fs.readFileSync(file)
      Y.applyUpdate(document, update)
      console.log(`[load] ${documentName} (${update.length} bytes)`)
    } else {
      console.log(`[load] ${documentName} (new)`)
    }
    return document
  },

  // 保存文档：将 ydoc 全量态落盘（生产可改为增量 + 定时）
  async onStoreDocument({ document, documentName, context }) {
    files.store(documentName, document, context?.session?.docId)
  },

  onConnect() {
    console.log('[connect] client connected')
  },
  onDisconnect({ context }) {
    if (context?.session?.connection) connections.delete(context.session.connection)
    console.log('[disconnect] client disconnected')
  },
})

const files = createCollabFiles(DATA_DIR, server)
setInterval(() => {
  for (const [connection, session] of connections) {
    renew(connection, session).catch(() => {})
  }
}, 1000).unref()

server.listen()
console.log(`Hocuspocus collab server listening on ws://${HOST}:${PORT}`)

/**
 * 启动即全量重建一次正文索引。
 * 这一步同时兜住了「停服务 → scp 覆盖 .bin → 启动」这种绕过写入钩子的导入路径：
 * 只要文件 mtime 变过，就会被重新解析。520 个文件 / 16MB 正文，实测秒级完成。
 */
{
  const t0 = Date.now()
  const r = searchIndex.reindexAll(DATA_DIR)
  console.log(
    `[search] 索引就绪：${r.total} 个房间，本次解析 ${r.parsed} 个，共 ${r.chars} 字，耗时 ${Date.now() - t0}ms`,
  )
}

/** 供 Java 后端调用的内网检索接口；不走 Nginx、只绑回环、要带共享 token */
const searchHttp = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  if (req.headers['x-internal-token'] !== SEARCH_TOKEN) {
    return send(401, { error: 'unauthorized' })
  }
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' })

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    // 可见文档的 key 列表最多几百个，正常请求远小于 64KB；超了直接掐断
    if (body.length > 256 * 1024) {
      send(413, { error: 'payload too large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    try {
      const payload = body ? JSON.parse(body) : {}
      if (req.url === '/internal/reindex') {
        const t0 = Date.now()
        const r = searchIndex.reindexAll(DATA_DIR)
        return send(200, { ...r, costMs: Date.now() - t0, ...searchIndex.stats() })
      }
      if (req.url === '/internal/search') {
        const hits = searchIndex.search(payload.q, payload.keys, payload.limit ?? 50)
        return send(200, { hits, ...searchIndex.stats() })
      }
      if (req.url === '/internal/stats') return send(200, searchIndex.stats())
      const operation = files.handle(req.url, payload)
      if (operation) return send(operation.status, operation.result)
      return send(404, { error: 'not found' })
    } catch (e) {
      return send(400, { error: e.message })
    }
  })
})
searchHttp.listen(SEARCH_PORT, SEARCH_HOST, () => {
  console.log(`[search] internal API listening on http://${SEARCH_HOST}:${SEARCH_PORT}`)
})

import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import http from 'http'
import { fileURLToPath } from 'url'
import jwt from 'jsonwebtoken'
import * as searchIndex from './search-index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
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
  async onAuthenticate({ token, documentName }) {
    if (!token) {
      throw new Error('缺少协同 token')
    }
    const payload = verifyCollabToken(token, documentName)
    return {
      user: { id: payload.sub, name: payload.dn || `用户${payload.sub}`, color: payload.color || '#3370ff' },
    }
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
  async onStoreDocument({ document, documentName }) {
    const file = path.join(DATA_DIR, `${documentName}.bin`)
    fs.writeFileSync(file, Y.encodeStateAsUpdate(document))
    // 正文索引跟着落盘一起更新：这里握着最新的 Y.Doc，不用重新读文件
    searchIndex.updateFromDoc(documentName, document, file)
  },

  onConnect() {
    console.log('[connect] client connected')
  },
  onDisconnect() {
    console.log('[disconnect] client disconnected')
  },
})

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
      return send(404, { error: 'not found' })
    } catch (e) {
      return send(400, { error: e.message })
    }
  })
})
searchHttp.listen(SEARCH_PORT, SEARCH_HOST, () => {
  console.log(`[search] internal API listening on http://${SEARCH_HOST}:${SEARCH_PORT}`)
})

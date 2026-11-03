import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import jwt from 'jsonwebtoken'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const PORT = process.env.COLLAB_PORT || 1234
// 生产由 Nginx 反代到 127.0.0.1，因此默认只绑回环，避免协同端口直接暴露公网
const HOST = process.env.COLLAB_HOST || '127.0.0.1'

// 与 Java 后端共享的 JWT 密钥。
// Java 侧对 JWT_SECRET 做一次 SHA-256 得到 HS256 密钥，这里必须用同样方式派生，
// 否则两边算出的密钥不同，所有协同连接都会被判为签名无效。
const JWT_SECRET = process.env.JWT_SECRET || 'lightdoc-dev-only-secret-change-me'
const JWT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest()

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

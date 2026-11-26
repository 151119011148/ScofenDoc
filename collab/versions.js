import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { forgetDocument, plainText, updateFromDoc } from './search-index.js'

const AUTO_INTERVAL_MS = 15 * 60 * 1000
const AUTO_LIMIT = 50
const RESTORE_FREEZE_MS = 30_000

function validated(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('无效的存储标识')
  return value
}

function atomicallyWrite(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600, flush: true })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function withDocument(bytes, callback) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    return callback(doc)
  } finally {
    doc.destroy()
  }
}

export function createCollabFiles(dataDir, server) {
  const versionRoot = path.join(dataDir, 'versions')
  const frozen = new Map()
  const purged = new Set()
  const lastAuto = new Map()
  const roomFile = room => path.join(dataDir, validated(room, /^[A-Za-z0-9-]{1,64}$/) + '.bin')
  const versionDir = docId => path.join(versionRoot, validated(docId, /^[1-9][0-9]*$/))
  const versionPath = (docId, version) => path.join(versionDir(docId),
    validated(version, /^[0-9a-f-]{36}$/))

  function isBlocked(room) {
    if (purged.has(room)) return true
    const restore = frozen.get(room)
    if (restore?.until > Date.now()) return true
    frozen.delete(room)
    return false
  }

  function history(docId) {
    const dir = versionDir(docId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
      .map(entry => JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'info.json'), 'utf8')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function snapshot(docId, bytes, kind, name, actor = null, id = randomUUID()) {
    const dir = versionDir(docId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const metadata = { id, name, kind, actor, createdAt: new Date().toISOString() }
    const staging = fs.mkdtempSync(path.join(dir, '.pending-'))
    try {
      atomicallyWrite(path.join(staging, 'state.bin'), bytes)
      atomicallyWrite(path.join(staging, 'info.json'), JSON.stringify(metadata))
      fs.renameSync(staging, path.join(dir, id))
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
    return metadata
  }

  function state(room) {
    const file = roomFile(room)
    const doc = server.documents.get(room)
    if (doc) return Y.encodeStateAsUpdate(doc)
    if (fs.existsSync(file)) return fs.readFileSync(file)
    const empty = new Y.Doc()
    try { return Y.encodeStateAsUpdate(empty) } finally { empty.destroy() }
  }

  function store(room, doc, docId) {
    if (purged.has(room)) return
    const file = roomFile(room)
    const bytes = Y.encodeStateAsUpdate(doc)
    atomicallyWrite(file, bytes)
    updateFromDoc(room, doc, file)
    if (!docId || isBlocked(room)) return
    try {
      const now = Date.now()
      if (!lastAuto.has(docId)) {
        const latest = history(docId).find(version => version.kind === 'AUTO')
        lastAuto.set(docId, latest ? Date.parse(latest.createdAt) : 0)
      }
      if (now - lastAuto.get(docId) < AUTO_INTERVAL_MS) return
      snapshot(docId, bytes, 'AUTO', '自动快照')
      lastAuto.set(docId, now)
      const old = history(docId).filter(version => version.kind === 'AUTO').slice(AUTO_LIMIT)
      for (const version of old) fs.rmSync(versionPath(docId, version.id), { recursive: true, force: true })
    } catch (error) {
      console.error('[snapshot] 自动快照失败', docId, error.message)
    }
  }

  function handle(url, { docId, room, newRoom, rooms, version, name, actor }) {
    const ok = result => ({ status: 200, result })
    switch (url) {
      case '/internal/versions':
        return ok(history(docId))
      case '/internal/snapshot':
        if (isBlocked(room)) throw new Error('房间正在切换')
        return ok(snapshot(docId, state(room), 'MANUAL', name, actor))
      case '/internal/version-preview':
      case '/internal/version-restore': {
        const file = path.join(versionPath(docId, version), 'state.bin')
        if (!fs.existsSync(file)) return { status: 404, result: { error: '版本不存在' } }
        const bytes = fs.readFileSync(file)
        if (url === '/internal/version-preview') {
          return ok(withDocument(bytes, doc => {
            const text = plainText(doc)
            return { text: text.slice(0, 150_000), truncated: text.length > 150_000 }
          }))
        }
        const next = roomFile(newRoom)
        if (fs.existsSync(next) || isBlocked(room)) throw new Error('房间正在切换')
        frozen.set(room, { until: Date.now() + RESTORE_FREEZE_MS, newRoom })
        try {
          const current = state(room)
          snapshot(docId, current, 'BEFORE_RESTORE', '恢复前的内容', actor)
          atomicallyWrite(roomFile(room), current)
          snapshot(docId, bytes, 'RESTORE', '恢复的版本', actor, newRoom)
          atomicallyWrite(next, bytes)
          withDocument(bytes, doc => updateFromDoc(newRoom, doc, next))
          return ok({ restored: true })
        } catch (error) {
          frozen.delete(room)
          throw error
        }
      }
      case '/internal/version-abort': {
        fs.rmSync(roomFile(newRoom), { force: true })
        fs.rmSync(versionPath(docId, newRoom), { recursive: true, force: true })
        forgetDocument(newRoom)
        if (frozen.get(room)?.newRoom === newRoom) frozen.delete(room)
        return ok({ aborted: true })
      }
      case '/internal/purge-doc': {
        const dir = versionDir(docId)
        const targets = rooms.map(key => [key, roomFile(key)])
        for (const [key, file] of targets) {
          purged.add(key)
          fs.rmSync(file, { force: true })
          forgetDocument(key)
        }
        fs.rmSync(dir, { recursive: true, force: true })
        lastAuto.delete(docId)
        return ok({ purged: true })
      }
      default:
        return null
    }
  }

  return { handle, store, isBlocked }
}

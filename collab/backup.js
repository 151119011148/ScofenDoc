import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'

const root = process.argv[2]
if (!root) throw new Error('用法: node backup.js <恢复目录中的 collab 数据目录>')

let rooms = 0
let snapshots = 0

function check(file) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, fs.readFileSync(file))
  } catch (error) {
    throw new Error(`Yjs 数据无法读取: ${file}`, { cause: error })
  } finally {
    doc.destroy()
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.bin')) continue
  check(path.join(root, entry.name))
  rooms++
}
const versions = path.join(root, 'versions')
if (fs.existsSync(versions)) {
  for (const docId of fs.readdirSync(versions).filter(name => /^[1-9][0-9]*$/.test(name))) {
    const dir = path.join(versions, docId)
    for (const id of fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
      const metadata = JSON.parse(fs.readFileSync(path.join(dir, id, 'info.json'), 'utf8'))
      if (metadata.id !== id) throw new Error(`版本元数据不匹配: ${docId}/${id}`)
      check(path.join(dir, id, 'state.bin'))
      snapshots++
    }
  }
}
console.log(`Yjs 数据校验完成: ${rooms} 个房间，${snapshots} 个版本`)

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'

/**
 * 正文全文检索索引（协同进程内、纯内存）。
 *
 * 为什么放在这里、而不是交给 Java 后端或 Elasticsearch：
 *  - 正文的唯一真相源是 Yjs CRDT 二进制（onStoreDocument 落的 .bin），Java 侧没有
 *    y-prosemirror、也不挂载 /opt/scofendoc/collab/data，读不懂这个文件；
 *  - 而本进程已经有了 yjs，且每次保存都握着最新的 Y.Doc，抽文本零成本；
 *  - 线上 381 篇有效文档、正文 16MB，纯文本约 6~8MB，一次全量扫描是毫秒~秒级，
 *    子串匹配也只要几十毫秒 —— 不需要倒排索引，更不需要单独的搜索服务。
 *
 * 另一个关键设计：启动时按文件 mtime 全量重建一遍。导入脚本（publish-md.sh /
 * archive-import.mjs）是「停服务 → scp 覆盖 .bin → 启动」，完全绕过 Hocuspocus 的
 * 写入钩子，只有启动时扫盘才能把这些旁路写入的正文也收进索引。
 *
 * 索引不落库、不持久化：重启即重建，避免又多出一份需要和正文保持一致的副本。
 * 权限不在这里判 —— 后端只把「当前用户可见的 collabKey 列表」传进来，
 * 本模块只在这些 key 里搜，天然不会越权、也搜不到软删文档。
 */

/** collabKey -> { text, lower, mtimeMs } */
const index = new Map()

let dataDir = ''
let builtAt = 0

/** 递归取 Y.XmlFragment / Y.XmlElement / Y.XmlText 里的纯文本 */
function collect(node, out) {
  const children = typeof node.toArray === 'function' ? node.toArray() : []
  for (const child of children) {
    // Y.XmlText：toDelta() 只取 insert 字符串，跳过 mark 属性。
    // 不能用 child.toString() —— 它会把加粗/链接这类 mark 渲染成 <bold>…</bold>，
    // 既污染文本，又会把跨 mark 边界的词（「索引」「B+Tree」）切碎。
    if (typeof child.toDelta === 'function') {
      for (const delta of child.toDelta()) {
        const ins = delta.insert
        if (typeof ins === 'string') {
          out.push(ins)
        } else if (ins && typeof ins.toDelta === 'function') {
          collect({ toArray: () => [ins] }, out)
        } else if (ins && typeof ins.toArray === 'function') {
          collect(ins, out)
        }
      }
      continue
    }
    if (typeof child.toArray === 'function') {
      // 图片等原子节点：把 alt / title 也纳入，搜图注能找到文档
      const attrs = typeof child.getAttributes === 'function' ? child.getAttributes() : {}
      for (const k of ['alt', 'title']) {
        if (typeof attrs[k] === 'string' && attrs[k]) out.push(' ' + attrs[k] + ' ')
      }
      collect(child, out)
      out.push('\n') // 块边界；摘要里再压成空格
    }
  }
}

/** 从一个已 applyUpdate 的 Y.Doc 抽正文纯文本 */
export function plainText(ydoc) {
  const out = []
  collect(ydoc.getXmlFragment('default'), out)
  return out
    .join('')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function put(key, text, mtimeMs) {
  if (!text) {
    index.delete(key)
    return
  }
  index.set(key, { text, lower: text.toLowerCase(), mtimeMs })
}

/**
 * 全量重建：按 mtime 跳过没变过的文件。
 * 返回 { total, parsed, chars }，供启动日志与 /internal/reindex 回显。
 */
export function reindexAll(dir) {
  dataDir = dir
  let total = 0
  let parsed = 0
  let chars = 0
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.bin'))
  } catch {
    return { total: 0, parsed: 0, chars: 0 }
  }
  // 磁盘上已经删掉的房间不必从库里查，搜索时后端只传可见 key，取不到就是空
  for (const file of files) {
    const key = path.basename(file, '.bin')
    total++
    const full = path.join(dir, file)
    try {
      const st = fs.statSync(full)
      const prev = index.get(key)
      if (prev && prev.mtimeMs === st.mtimeMs) {
        chars += prev.text.length
        continue
      }
      const ydoc = new Y.Doc()
      try {
        Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(full)))
        const text = plainText(ydoc)
        put(key, text, st.mtimeMs)
        chars += text.length
        parsed++
      } finally {
        ydoc.destroy()
      }
    } catch (e) {
      // 单个损坏/半写入的 bin 不能拖垮整个服务，跳过并留日志
      console.warn(`[search] 跳过 ${file}: ${e.message}`)
    }
  }
  builtAt = Date.now()
  return { total, parsed, chars }
}

/**
 * 保存钩子：直接用内存里的 Y.Doc 更新，不用重新读盘。
 * mtime 取落盘后的真实值，避免下次 reindexAll 重复解析同一份文件。
 */
export function updateFromDoc(key, ydoc, file) {
  try {
    const st = fs.statSync(file)
    put(key, plainText(ydoc), st.mtimeMs)
  } catch (e) {
    console.warn(`[search] 更新索引失败 ${key}: ${e.message}`)
  }
}

/** 命中位置附近的摘要；大小写不敏感的定位，但展示保留原文 */
function snippetOf(text, lower, needle) {
  const at = lower.indexOf(needle)
  if (at < 0) return ''
  const start = Math.max(0, at - 36)
  const end = Math.min(text.length, at + needle.length + 64)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '')
}

/**
 * 在指定 key 范围内做子串匹配。
 * 中文/英文都不分词：小体量下子串匹配反而最符合直觉（搜「B+Tree」能直接命中，
 * 不会被分词器拆成 B / Tree 而召回一堆无关结果）。
 */
export function search(q, keys, limit = 50) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return []
  // keys 必须严格按调用方给的范围来：传空数组就是「一个都不许搜」，
  // 不能因为空就退化成全库扫描（那是权限边界，宁可漏搜也不能越权）
  const wanted = keys ?? [...index.keys()]
  const found = []
  for (const key of wanted) {
    const entry = index.get(key)
    if (!entry) continue
    let at = entry.lower.indexOf(needle)
    if (at < 0) continue
    let hits = 0
    let first = at
    while (at >= 0 && hits < 1000) {
      hits++
      at = entry.lower.indexOf(needle, at + Math.max(1, needle.length))
    }
    found.push({ key, hits, snippet: snippetOf(entry.text, entry.lower, needle) })
  }
  found.sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key))
  return found.slice(0, Math.max(1, Math.min(limit, 500)))
}

export function stats() {
  return { docs: index.size, builtAt, dataDir }
}

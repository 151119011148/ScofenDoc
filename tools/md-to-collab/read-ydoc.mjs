#!/usr/bin/env node
/**
 * 读回校验：把一个协同 .bin 还原成 ProseMirror JSON 并统计结构，
 * 用于确认「导入时写的」和「服务端存的」是同一份内容（防止 schema 丢节点）。
 *
 * 用法: node read-ydoc.mjs <file.bin>
 */
import fs from 'fs'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'

const file = process.argv[2]
if (!file) {
  console.error('用法: node read-ydoc.mjs <file.bin>')
  process.exit(1)
}
const ydoc = new Y.Doc()
Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(file)))
const json = yDocToProsemirrorJSON(ydoc, 'default')

const stats = { nodes: 0, tables: 0, text: 0, links: 0, innerLinks: 0, byType: {} }
;(function walk(n) {
  stats.nodes++
  stats.byType[n.type] = (stats.byType[n.type] || 0) + 1
  if (n.type === 'text') stats.text += (n.text || '').length
  if (n.type === 'table') stats.tables++
  for (const mark of n.marks || []) {
    if (mark.type !== 'link') continue
    stats.links++
    if ((mark.attrs?.href || '').includes('doc=')) stats.innerLinks++
  }
  ;(n.content || []).forEach(walk)
})(json)

console.log(`文件      ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`)
console.log(`节点      ${stats.nodes}  表格 ${stats.tables}  正文字数 ${stats.text}`)
console.log(`链接      ${stats.links} 处，其中站内互引 ${stats.innerLinks} 处`)
console.log(`顶层块    ${(json.content || []).length}`)
console.log('分布      ' + Object.entries(stats.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '))
const first = (json.content || []).slice(0, 3).map((n) => n.type + (n.attrs?.level ? `(h${n.attrs.level})` : '') + ' ' + (n.content || []).map((c) => c.text || '').join('').slice(0, 40))
console.log('开头      ' + first.join(' | '))

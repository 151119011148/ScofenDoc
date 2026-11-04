#!/usr/bin/env node
/**
 * 重发后的结构对照：线上 Yjs 正文 vs 源 md。
 *
 * 比的是什么：表格数、标题数、代码块数、正文字数（去标记后）、链接数。
 * 只要有一项对不上，说明这次重发丢了内容（schema 缺节点、解析器变严格、链接被吃掉）。
 *
 * 用法: node verify-links.mjs <link-manifest.json> <binsDir>
 *   binsDir 里按 <docId>.bin 命名（从服务器 /opt/scofendoc/collab/data/{collabKey}.bin 拷回来）
 */
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'

const [manifestPath, binsDir] = process.argv.slice(2)
if (!manifestPath || !binsDir) {
  console.error('用法: node verify-links.mjs <link-manifest.json> <binsDir>')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const rows = []

for (const [file, hit] of Object.entries(manifest)) {
  const bin = path.join(binsDir, `${hit.docId}.bin`)
  if (!fs.existsSync(bin)) {
    rows.push({ docId: hit.docId, file, err: '缺 bin' })
    continue
  }
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(bin)))
  const json = yDocToProsemirrorJSON(ydoc, 'default')

  const st = { tables: 0, headings: 0, code: 0, mermaid: 0, text: 0, links: 0, inner: 0, stars: 0 }
  ;(function walk(n, inCode = false) {
    if (n.type === 'table') st.tables += 1
    if (n.type === 'heading') st.headings += 1
    if (n.type === 'codeBlock') st.code += 1
    if (n.type === 'mermaid' || n.type === 'plantuml') st.mermaid += 1
    const nextInCode = inCode || n.type === 'codeBlock'
    if (n.type === 'text') {
      st.text += (n.text || '').length
      // 代码块里的 ** 是语法（1024**3、**kwargs），不是没转成的加粗
      if (!nextInCode && (n.text || '').includes('**')) st.stars += 1
    }
    for (const m of n.marks || []) {
      if (m.type !== 'link') continue
      st.links += 1
      if ((m.attrs?.href || '').includes('doc=')) st.inner += 1
    }
    ;(n.content || []).forEach((c) => walk(c, nextInCode))
  })(json)

  const md = fs.readFileSync(file, 'utf8')
  const mdTables = (md.match(/^\|[- :|]*\|$/gm) || []).length
  // mermaid / plantuml 围栏在线上是独立节点，不算 codeBlock，统计时要分开数
  const fences = md.match(/^```([^\n]*)$/gm) || []
  const mdMermaid = fences.filter((f) => /```\s*(mermaid|plantuml)/i.test(f)).length
  const mdCode = Math.floor(fences.length / 2) - mdMermaid
  // 导入时丢掉首行 H1（标题由文档名承载）
  const mdHeadings = (md.replace(/^#\s+.*\r?\n/, '').match(/^#{2,6}\s/gm) || []).length

  rows.push({ docId: hit.docId, file: path.basename(file), ...st, mdMermaid, mdTables, mdHeadings, mdCode })
}

let bad = 0
console.log('id  表格 标题 代码 图  字数 链接(站内)  文件（各列均为 线上/源）')
for (const r of rows.sort((a, b) => a.docId - b.docId)) {
  if (r.err) {
    console.log(`${r.docId}  ${r.err}  ${r.file}`)
    bad += 1
    continue
  }
  const ok =
    r.tables === r.mdTables &&
    r.headings === r.mdHeadings &&
    r.code === r.mdCode &&
    r.mermaid === r.mdMermaid &&
    r.stars === 0
  if (!ok) bad += 1
  console.log(
    `${String(r.docId).padEnd(4)} ${String(r.tables).padStart(2)}/${String(r.mdTables).padEnd(2)}` +
      `        ${String(r.headings).padStart(2)}/${String(r.mdHeadings).padEnd(2)}` +
      `        ${String(r.code).padStart(2)}/${String(r.mdCode).padEnd(2)}` +
      `       ${String(r.mermaid).padStart(2)}/${String(r.mdMermaid).padEnd(2)}` +
      `      ${String(r.text).padStart(6)}  ${String(r.links).padStart(3)}(${r.inner})` +
      `   ${r.file}${ok ? '' : '  ⚠'}`,
  )
}
console.log(`\n共 ${rows.length} 篇，结构异常 ${bad} 篇`)

#!/usr/bin/env node
/**
 * 批量导入后的逐篇体检：把线上 .bin 解回来，与源 md 对比
 * 表格数、标题数、代码块数（结构性指标），任何一项不等就标 ⚠。
 *
 * 用法: node batch-verify.mjs <源md目录> <map.tsv> <bin目录>
 *   map.tsv 从库里导出：select id,collab_key,title ...（tab 分隔，标题＝源文件名去扩展名）
 */
import fs from 'fs'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'

const [srcDir, mapFile, binDir] = process.argv.slice(2)
if (!srcDir || !mapFile || !binDir) {
  console.error('用法: node batch-verify.mjs <源md目录> <map.tsv> <bin目录>')
  process.exit(1)
}

const map = fs
  .readFileSync(mapFile, 'utf8')
  .trim()
  .split('\n')
  .map((line) => {
    const [id, key, title] = line.split('\t')
    return { id, key, title }
  })

const rows = []
for (const m of map) {
  const bin = `${binDir}/${m.key}.bin`
  const mdPath = `${srcDir}/${m.title}.md`
  if (!fs.existsSync(bin)) {
    rows.push({ ...m, err: '缺 bin' })
    continue
  }

  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(bin)))
  const json = yDocToProsemirrorJSON(ydoc, 'default')

  const st = { tables: 0, headings: 0, code: 0, text: 0, stars: 0 }
  ;(function walk(n) {
    if (n.type === 'table') st.tables += 1
    if (n.type === 'heading') st.headings += 1
    if (n.type === 'codeBlock') st.code += 1
    if (n.type === 'text') {
      st.text += (n.text || '').length
      if ((n.text || '').includes('**')) st.stars += 1
    }
    ;(n.content || []).forEach(walk)
  })(json)

  let mdTables = 0
  let mdHeadings = 0
  let mdCode = 0
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8')
    // 首行 H1 导入时被丢弃（标题由文档名承载），比对数时排除
    const body = md.replace(/^#[ \t]+.*\r?\n/, '')
    mdTables = (md.match(/^\|[- :|]*\|$/gm) || []).length
    mdHeadings = (body.match(/^#{2,6}[ \t]/gm) || []).length
    mdCode = Math.floor((md.match(/^```/gm) || []).length / 2)
  }

  rows.push({ ...m, ...st, mdTables, mdHeadings, mdCode })
}

console.log('id  表格  标题  代码块   字数   标题名')
let bad = 0
for (const r of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
  if (r.err) {
    console.log(`${r.id}  ${r.err}  ${r.title}`)
    bad += 1
    continue
  }
  const mismatch =
    r.tables !== r.mdTables || r.headings !== r.mdHeadings || r.code !== r.mdCode || r.stars > 0
  if (mismatch) bad += 1
  console.log(
    `${r.id}  ${r.tables}/${r.mdTables}  ${r.headings}/${r.mdHeadings}  ${r.code}/${r.mdCode}  ${String(r.text).padStart(6)}  ${r.title}${mismatch ? '  ⚠' : ''}`,
  )
}
console.log(`\n共 ${rows.length} 篇，结构不一致 ${bad} 篇`)

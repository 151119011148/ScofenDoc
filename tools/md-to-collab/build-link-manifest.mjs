#!/usr/bin/env node
/**
 * 生成「本地 md 路径 → 线上文档」对照表，供导入器把相对链接改写成站内深链。
 *
 * 输入：
 *   map.tsv  线上文档清单，三列：id \t workspace_id \t title
 *   roots    若干 md 目录（技术栈、ai学习 …）
 * 输出：
 *   link-manifest.json   { "<绝对 md 路径>": { docId, spaceId } }
 *
 * 匹配规则：md 文件名去后缀 == 文档标题。用户改过名的文档用别名兜住
 * （例如 00-总索引.md 在站内被改成「总索引」）。匹配不上的两边都打印出来，
 * 宁可少一条跳转，也不能把链接指到错文档上。
 *
 * 用法：
 *   node build-link-manifest.mjs map.tsv link-manifest.json ../技术栈 ../ai学习
 */
import fs from 'fs'
import path from 'path'

const [tsvPath, outPath, ...roots] = process.argv.slice(2)
if (!tsvPath || !outPath || roots.length === 0) {
  console.error('用法: node build-link-manifest.mjs <map.tsv> <out.json> <dir> [dir...]')
  process.exit(1)
}

/** 站内改过名的文档：文件名 → 站内标题 */
const TITLE_ALIAS = {
  '00-总索引': '总索引',
}

const rows = fs
  .readFileSync(tsvPath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split('\t'))
  .filter((cols) => cols.length >= 3)
  .map(([id, space, title]) => ({ docId: Number(id), spaceId: Number(space), title: title.trim() }))

const byTitle = new Map()
for (const row of rows) byTitle.set(row.title, row)

const manifest = {}
const unmatchedFiles = []
const usedDocIds = new Set()

for (const root of roots) {
  const dir = path.resolve(root)
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const base = file.replace(/\.md$/, '')
    const row = byTitle.get(base) ?? byTitle.get(TITLE_ALIAS[base] ?? '')
    if (!row) {
      unmatchedFiles.push(file)
      continue
    }
    manifest[path.join(dir, file)] = { docId: row.docId, spaceId: row.spaceId }
    usedDocIds.add(row.docId)
  }
}

fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const total = Object.keys(manifest).length
console.log(`对照表  ${outPath}`)
console.log(`收录    ${total} 个 md 文件 → 线上文档`)
if (unmatchedFiles.length) {
  console.log(`\n⚠ 这些 md 没有同名文档，链接会被降级为纯文字（${unmatchedFiles.length} 个）：`)
  unmatchedFiles.forEach((f) => console.log(`  · ${f}`))
}
const unused = rows.filter((r) => !usedDocIds.has(r.docId))
if (unused.length) {
  console.log(`\n这些线上文档没有对应 md（多为目录容器，正常，${unused.length} 个）：`)
  unused.forEach((r) => console.log(`  · #${r.docId} ${r.title}`))
}

#!/usr/bin/env node
/**
 * 从总索引里切出「每章一页」的章索引。
 *
 * 为什么这么做：目录树里每个章节点（第一章 … 第六章）本身是空页，点进去什么都没有；
 * 而总索引的表格里已经有每篇的编号、标题、一句话主轴。把这些行按章分组落成独立页面，
 * 章节点就成了真正的「本章索引」——篇名全部是站内跳转，跨章再回总索引。
 *
 * 用法: node gen-chapter-index.mjs <00-总索引.md> <输出目录>
 * 产物: 章-1.md … 章-6.md（放在 技术栈 目录下，保证相对链接能被导入器解析）
 */
import fs from 'fs'
import path from 'path'

const [indexMd, outDir] = process.argv.slice(2)
if (!indexMd || !outDir) {
  console.error('用法: node gen-chapter-index.mjs <00-总索引.md> <输出目录>')
  process.exit(1)
}

const lines = fs.readFileSync(indexMd, 'utf8').split('\n')

// | 1.2 | [Java基础-OO三大特性](1.2-Java基础-OO三大特性.md) | 主轴… | 锚… | 11｜7 |
// 有的行在链接后还跟一句括注（`（**1.5 子篇**）`），所以 `)` 与 `|` 之间允许任意内容
const rowRe = /^\|\s*([0-9]+(?:\.[0-9]+)*)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)[^|]*\|(.*)$/

const chapters = new Map()
for (const line of lines) {
  const m = rowRe.exec(line)
  if (!m) continue
  const [, num, title, href, rest] = m
  // 只认「技术栈 或 ../ai学习 下的 md」，表格里其它链接（存档索引等）不算正文篇目
  if (!/\.md$/i.test(href.trim())) continue
  const cols = rest.split('|').map((c) => c.trim())
  const gist = cols[0] || '—'
  const chapter = Number(num.split('.')[0])
  if (!chapters.has(chapter)) chapters.set(chapter, [])
  chapters.get(chapter).push({ num, title: title.trim(), href: href.trim(), gist })
}

const NAMES = {
  1: '第一章 Java 基础',
  2: '第二章 框架',
  3: '第三章 数据库',
  4: '第四章 消息队列',
  5: '第五章 架构方法论与实战',
  6: '第六章 Agent 开发',
}

fs.mkdirSync(outDir, { recursive: true })
let total = 0
for (const chapter of [...chapters.keys()].sort((a, b) => a - b)) {
  const rows = chapters.get(chapter)
  // 同一篇在表里可能出现两次（例如导览被列在总表与分组表），按编号去重
  const seen = new Set()
  const uniq = rows.filter((r) => (seen.has(r.num) ? false : (seen.add(r.num), true)))
  const body = [
    `> ${NAMES[chapter] ?? `第 ${chapter} 章`} · 本章 ${uniq.length} 篇。点篇名直接进；跨章串联与全量清单见 [总索引](00-总索引.md)。`,
    '',
    '| # | 文档 | 一句话主轴 |',
    '|---|---|---|',
    ...uniq.map((r) => `| ${r.num} | [${r.title}](${r.href}) | ${r.gist} |`),
    '',
  ].join('\n')
  const file = path.join(outDir, `章-${chapter}.md`)
  fs.writeFileSync(file, body, 'utf8')
  total += uniq.length
  console.log(`第 ${chapter} 章  ${uniq.length} 篇 → ${file}`)
}
console.log(`合计 ${total} 条篇目`)

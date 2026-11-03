#!/usr/bin/env node
/**
 * Markdown → 协同文档（Yjs 二进制）导入器
 * ---------------------------------------------------------------------------
 * 正文在 MySQL 里没有副本：一篇文档的正文就是 Hocuspocus 房间里那份 Yjs 文档，
 * 由 Node 协同服务落盘成 /opt/lightdoc/collab/data/{collabKey}.bin。
 * 所以「导入一篇 Markdown」= 构造出与前端编辑器同构的 Yjs 初始状态，再投放到对应房间。
 *
 * 链路：
 *   markdown --marked--> HTML --generateJSON（Tiptap 同款扩展）--> ProseMirror JSON
 *            --prosemirrorJSONToYDoc--> Y.Doc --encodeStateAsUpdate--> *.bin
 *
 * 关键约束：这里的 extensions 必须和前端 CollabEditor.vue 里的**逐项一致**。
 * 少一个节点类型，导入后那类内容就会在客户端被 schema 丢弃（表现为"表格消失"）。
 *
 * 用法：
 *   node md-to-ydoc.mjs <input.md> <output.bin> [--drop-first-h1] [--quiet]
 */

import fs from 'fs'
import path from 'path'
import { marked } from 'marked'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { generateJSON } from '@tiptap/html'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'

/* ---------------- 与前端完全一致的扩展集 ---------------- */

function buildExtensions() {
  return [
    StarterKit.configure({ history: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ]
}

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

if (positional.length < 2) {
  console.error('用法: node md-to-ydoc.mjs <input.md> <output.bin> [--drop-first-h1] [--keep-local-links] [--quiet]')
  process.exit(1)
}

const mdFile = positional[0]
const binFile = positional[1]

const raw = fs.readFileSync(mdFile, 'utf8')

/* ---------------- Markdown → HTML ---------------- */

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false })

let markdown = raw
if (flags.has('--drop-first-h1')) {
  // 文档标题已经在列表和页头展示，正文再出现一次一级标题就是重复
  markdown = markdown.replace(/^#\s+.*\r?\n/, '')
}

const html = cleanLinks(fixLiteralStrong(marked.parse(preNormalizeStrong(markdown))))

/**
 * 相对链接降级为纯文字。
 *
 * md 里的 [1.1-Java基础-章节导览](1.1-Java基础-章节导览.md)、[存档](CSDN存档/xxx.html)
 * 指向的是本地文件，搬到线上就是一串 404。文档站又没有 URL 深链可改写，
 * 所以默认把这类本地链接去壳留字（文字本身通常是可读的标题），外链 http(s) 原样保留。
 * 需要保留原样时加 --keep-local-links。
 */
function cleanLinks(input) {
  if (flags.has('--keep-local-links')) return input
  let stripped = 0
  const out = input.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, inner) => {
    if (/^(https?:|mailto:|tel:|#|\/\/)/i.test(href)) return m
    stripped += 1
    return inner
  })
  if (!flags.has('--quiet') && stripped > 0) console.log(`本地链接降级为文字：${stripped} 处`)
  return out
}

/**
 * 把行内加粗统一改写成 <strong>，绕开 CommonMark 的定界符规则。
 *
 * 中文写作里 ** 常常紧贴标点：`**"记账服务＝分录模板"**，`、`**"不许系统自己造钱"**换成`
 * 这类写法按 CommonMark 的 left/right-flanking 判定不成立（开头的 ** 后面紧跟引号、
 * 前面是汉字），解析器只能原样输出星号。这不是笔误，是中文标点密度导致的必然结果。
 *
 * 直接改写成 <strong>…</strong>（Markdown 允许内联 HTML）语义完全等价，且不受定界符规则影响；
 * 代码围栏与行内代码里的 ** 是内容本身，先摘出来再放回。
 */
function preNormalizeStrong(markdown) {
  const codeSpans = []
  let inFence = false

  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line

      // 行内代码先占位，避免把 `a**b` 这类内容改写掉
      const protectedLine = line.replace(/`[^`]*`/g, (m) => {
        codeSpans.push(m)
        return `\u0001${codeSpans.length - 1}\u0001`
      })

      const stars = (protectedLine.match(/\*\*/g) || []).length
      // 开头的 ** 后面偶有一个误敲的空格（`** fencing token…**`）：CommonMark 里紧跟空白
      // 也不能开粗体，这里允许并吃掉这一个空格，避免整段退化成裸星号
      const converted =
        stars >= 2
          ? protectedLine.replace(/\*\*[ \t]?(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
          : protectedLine

      return converted.replace(/\u0001(\d+)\u0001/g, (_m, i) => codeSpans[Number(i)])
    })
    .join('\n')
}

/**
 * 兜底：正常化之后若仍有字面量 **（例如跨行、书写残缺），在 HTML 文本节点里再收一次。
 * 代码块内的星号跳过——那里是正文内容，不是标记。
 */
function fixLiteralStrong(input) {
  let inCode = 0
  return input
    .split(/(<[^>]+>)/)
    .map((piece) => {
      if (piece.startsWith('<')) {
        if (/^<(pre|code)\b/i.test(piece)) inCode += 1
        else if (/^<\/(pre|code)>/i.test(piece)) inCode = Math.max(0, inCode - 1)
        return piece
      }
      if (inCode) return piece
      return piece.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    })
    .join('')
}

/* ---------------- HTML → ProseMirror JSON ---------------- */

const extensions = buildExtensions()
const schema = getSchema(extensions)
const json = generateJSON(html, extensions)

/* ---------------- ProseMirror JSON → Y.Doc ---------------- */

const ydoc = prosemirrorJSONToYDoc(schema, json, 'default')
const update = Y.encodeStateAsUpdate(ydoc)

fs.mkdirSync(path.dirname(path.resolve(binFile)), { recursive: true })
fs.writeFileSync(binFile, Buffer.from(update))

/* ---------------- 自校验：把二进制读回来数一遍 ---------------- */

const back = yDocToProsemirrorJSON(ydoc, 'default')

function walk(node, stats) {
  stats.nodes += 1
  stats.byType[node.type] = (stats.byType[node.type] || 0) + 1
  if (node.type === 'text') {
    stats.text += (node.text || '').length
    if ((node.text || '').includes('**')) stats.leftoverStars += 1
  }
  if (node.type === 'table') stats.tables += 1
  if (node.type === 'taskList') stats.taskLists += 1
  for (const child of node.content || []) walk(child, stats)
}

const stats = { nodes: 0, tables: 0, taskLists: 0, text: 0, leftoverStars: 0, byType: {} }
walk(back, stats)

const headings = (back.content || [])
  .filter((n) => n.type === 'heading')
  .map((n) => `${'  '.repeat((n.attrs?.level || 1) - 1)}H${n.attrs?.level} ${(n.content || []).map((c) => c.text || '').join('')}`)

if (!flags.has('--quiet')) {
  const kb = (update.length / 1024).toFixed(1)
  console.log(`输入  ${mdFile}  (${(raw.length / 1024).toFixed(1)} KB)`)
  console.log(`输出  ${binFile}  (${kb} KB Yjs 更新)`)
  console.log(`节点  ${stats.nodes}　表格 ${stats.tables}　待办 ${stats.taskLists}　正文字数 ${stats.text}`)
  if (stats.leftoverStars > 0) {
    console.log(`\u26a0 仍有 ${stats.leftoverStars} 处文本残留 ** 标记（可能是跨段的加粗写法，需人工看）`)
  } else {
    console.log('加粗/标记残留  无')
  }
  console.log('节点类型分布：')
  Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`))
  console.log('顶层标题：')
  headings.slice(0, 12).forEach((h) => console.log(`  ${h}`))
  if (headings.length > 12) console.log(`  … 共 ${headings.length} 个顶层标题`)
}

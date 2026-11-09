#!/usr/bin/env node
/**
 * Markdown → 协同文档（Yjs 二进制）导入器
 * ---------------------------------------------------------------------------
 * 正文在 MySQL 里没有副本：一篇文档的正文就是 Hocuspocus 房间里那份 Yjs 文档，
 * 由 Node 协同服务落盘成 /opt/scofendoc/collab/data/{collabKey}.bin。
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
import { Extension, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { MermaidBlock } from './mermaid-block.mjs'
import { PlantUMLBlock } from './plantuml-block.mjs'
import { generateJSON } from '@tiptap/html'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'

/* ---------------- 与前端完全一致的扩展集 ---------------- */

function buildExtensions(numbered = false) {
  return [
    StarterKit.configure({ history: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    // 必须与前端一致：少这个节点，导入的图会被 schema 静默丢掉
    Image.configure({ inline: false, allowBase64: false }),
    MermaidBlock,
    PlantUMLBlock,
    ...(numbered ? [HeadingNumberAttrs()] : []),
  ]
}

/**
 * 标题自动编号属性（前端的 HeadingNumber 扩展）。
 *
 * 站点里的标题是「纯文字 + numbered 属性」，序号（1 / 1.1 / 1.1.1）由前端装饰派生，
 * 不落在文字里。离线这条链路没引那个扩展，schema 里就没有这两个属性，
 * `generateJSON` 会把它们直接丢掉——重建/覆盖出来的文档「标题有文字、没有序号」。
 * 打开 --numbered 时把同名字段补进 schema，序号就还在。
 */
function HeadingNumberAttrs() {
  return Extension.create({
    name: 'headingNumberAttrs',
    addGlobalAttributes() {
      return [
        {
          types: ['heading'],
          attributes: {
            numbered: {
              default: false,
              parseHTML: (el) => el.getAttribute('data-numbered') === '1',
              renderHTML: (attrs) => (attrs.numbered ? { 'data-numbered': '1' } : {}),
            },
            numberStyle: {
              default: 'ordered',
              parseHTML: (el) => (el.getAttribute('data-numbered-style') === 'unordered' ? 'unordered' : 'ordered'),
              renderHTML: (attrs) =>
                attrs.numbered && attrs.numberStyle === 'unordered' ? { 'data-numbered-style': 'unordered' } : {},
            },
          },
        },
      ]
    },
  })
}

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const positional = []
const opts = {
  dropFirstH1: false,
  keepLocalLinks: false,
  quiet: false,
  numbered: false,
  manifest: '',
  selfDocId: 0,
  spaceId: 0,
  mergeInto: '',
}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--drop-first-h1') opts.dropFirstH1 = true
  else if (a === '--keep-local-links') opts.keepLocalLinks = true
  else if (a === '--numbered') opts.numbered = true
  else if (a === '--quiet') opts.quiet = true
  else if (a === '--manifest') opts.manifest = argv[++i] || ''
  else if (a === '--merge-into') opts.mergeInto = argv[++i] || ''
  else if (a === '--self') opts.selfDocId = Number(argv[++i] || 0)
  else if (a === '--space') opts.spaceId = Number(argv[++i] || 0)
  else if (a.startsWith('--')) {
    console.error(`未知参数：${a}`)
    process.exit(1)
  } else positional.push(a)
}

if (positional.length < 2) {
  console.error(
    '用法: node md-to-ydoc.mjs <input.md> <output.bin> [--drop-first-h1] [--keep-local-links] [--quiet]\n' +
      '       [--manifest link-manifest.json --self <docId> --space <spaceId>]',
  )
  process.exit(1)
}

const mdFile = positional[0]
const binFile = positional[1]

const raw = fs.readFileSync(mdFile, 'utf8')

/* ---------------- Markdown → HTML ---------------- */

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false })

let markdown = raw
if (opts.dropFirstH1) {
  // 文档标题已经在列表和页头展示，正文再出现一次一级标题就是重复
  markdown = markdown.replace(/^#\s+.*\r?\n/, '')
}

const manifest = opts.manifest ? JSON.parse(fs.readFileSync(opts.manifest, 'utf8')) : null
const linkStats = { internal: 0, inDoc: 0, external: 0, stripped: 0, missing: new Set() }

function internalUrl(docId, spaceId, anchor) {
  let url = `?space=${spaceId}&doc=${docId}`
  if (anchor) url += `&h=${encodeURIComponent(anchor)}`
  return url
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const html = rewriteLinks(fixLiteralStrong(marked.parse(preNormalizeStrong(markdown))))

/**
 * 链接改写：把「指向另一篇 md」的相对链接换成站内深链。
 *
 * md 里的 [1.1-Java基础-章节导览](1.1-Java基础-章节导览.md)、[RAG](.../6.1.3-xxx.md)
 * 指向的是本地文件，搬到线上就是 404。文档站本身是按 id 找文档的，所以只要知道
 * 「这个 md 路径对应哪一篇线上文档」，就能把链接改写成 `?space=2&doc=20`——
 * 不写死域名，换机器、换域名都不用重发。
 *
 * 锚点（`#g-xxx`、`#存档导航`）一并带过去，前端按文字匹配滚动（Yjs 正文里没有 heading id）。
 *
 * 没收录进清单的本地链接（CSDN存档/xxx.html 这类没发布的内容）仍然去壳留字，
 * 因为点开必然 404；需要保留原样时加 --keep-local-links。
 */
function rewriteLinks(input) {
  const baseDir = path.dirname(path.resolve(mdFile))
  return input.replace(/<a\s([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (m, pre, href, post, inner) => {
    if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) {
      linkStats.external += 1
      return m
    }
    // 纯页内锚点：指向本文档
    if (href.startsWith('#')) {
      if (!opts.selfDocId) {
        linkStats.stripped += 1
        return inner
      }
      linkStats.inDoc += 1
      return `<a href="${internalUrl(opts.selfDocId, opts.spaceId, safeDecode(href.slice(1)))}">${inner}</a>`
    }

    const [rawPath, rawHash = ''] = href.split('#')
    let target = ''
    try {
      target = path.resolve(baseDir, safeDecode(rawPath))
    } catch {
      target = ''
    }
    const hit = target && manifest ? manifest[target] : null
    if (!hit) {
      if (opts.keepLocalLinks) return m
      linkStats.stripped += 1
      if (/\.md$/i.test(rawPath)) linkStats.missing.add(path.basename(rawPath))
      return inner
    }
    linkStats.internal += 1
    return `<a href="${internalUrl(hit.docId, hit.spaceId ?? opts.spaceId, rawHash ? safeDecode(rawHash) : '')}">${inner}</a>`
  })
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

const extensions = buildExtensions(opts.numbered)
const schema = getSchema(extensions)
const json = generateJSON(html, extensions)

if (opts.numbered) {
  // 只给顶层遍历即可：标题都是顶层节点，正文里的 heading 不会出现在表格/引用内部
  let heads = 0
  for (const node of json.content || []) {
    if (node.type === 'heading') {
      node.attrs = { ...(node.attrs || {}), numbered: true }
      heads += 1
    }
  }
  if (!opts.quiet) console.log(`编号  已给 ${heads} 个标题打开自动编号`)
}

/* ---------------- ProseMirror JSON → Y.Doc ---------------- */

/**
 * 生成 Yjs 状态。
 *
 * 直接 `prosemirrorJSONToYDoc` 得到的是一个「全新文档」——它和线上已有房间是两条
 * 互不相干的 CRDT 历史。只要还有客户端连着（或离线端还留着旧状态），重新连上时
 * 它会把旧历史推回来，服务端合并后旧内容就盖掉了新内容（实测：链接会被整段抹掉）。
 *
 * 所以覆盖已有文档时走 `--merge-into <旧 bin>`：先把旧状态读进来，在**同一条历史**上
 * 删掉全部子节点、再插入新内容。删除动作会变成 CRDT 的 tombstone，任何还活着的客户端
 * 收到后都会跟着删，而不是各说各话。
 */
let ydoc
if (opts.mergeInto && fs.existsSync(opts.mergeInto)) {
  ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(opts.mergeInto)))
  const fragment = ydoc.getXmlFragment('default')
  const oldLength = fragment.length
  ydoc.transact(() => {
    if (fragment.length > 0) fragment.delete(0, fragment.length)
    prosemirrorJSONToYXmlFragment(schema, json, fragment)
  })
  if (!opts.quiet) console.log(`合并  基于现有房间（原 ${oldLength} 个顶层节点，已就地替换）`)
} else {
  ydoc = prosemirrorJSONToYDoc(schema, json, 'default')
}
const update = Y.encodeStateAsUpdate(ydoc)

fs.mkdirSync(path.dirname(path.resolve(binFile)), { recursive: true })
fs.writeFileSync(binFile, Buffer.from(update))

/* ---------------- 自校验：把二进制读回来数一遍 ---------------- */

const back = yDocToProsemirrorJSON(ydoc, 'default')

function walk(node, stats, inCode = false) {
  stats.nodes += 1
  stats.byType[node.type] = (stats.byType[node.type] || 0) + 1
  const nextInCode = inCode || node.type === 'codeBlock'
  if (node.type === 'text') {
    stats.text += (node.text || '').length
    // 代码块里的 ** 是语法（1024**3、**kwargs），不是没转成的加粗
    if (!nextInCode && (node.text || '').includes('**')) stats.leftoverStars += 1
  }
  if (node.type === 'table') stats.tables += 1
  if (node.type === 'taskList') stats.taskLists += 1
  for (const child of node.content || []) walk(child, stats, nextInCode)
}

const stats = { nodes: 0, tables: 0, taskLists: 0, text: 0, leftoverStars: 0, byType: {} }
walk(back, stats)

const headings = (back.content || [])
  .filter((n) => n.type === 'heading')
  .map((n) => `${'  '.repeat((n.attrs?.level || 1) - 1)}H${n.attrs?.level} ${(n.content || []).map((c) => c.text || '').join('')}`)

if (!opts.quiet) {
  const kb = (update.length / 1024).toFixed(1)
  console.log(`输入  ${mdFile}  (${(raw.length / 1024).toFixed(1)} KB)`)
  console.log(`输出  ${binFile}  (${kb} KB Yjs 更新)`)
  console.log(`节点  ${stats.nodes}　表格 ${stats.tables}　待办 ${stats.taskLists}　正文字数 ${stats.text}`)
  console.log(
    `链接  站内 ${linkStats.internal}　页内锚点 ${linkStats.inDoc}　外链 ${linkStats.external}　` +
      `未发布降级 ${linkStats.stripped}`,
  )
  if (linkStats.missing.size > 0) {
    const list = [...linkStats.missing].slice(0, 8).join('、')
    console.log(`\u26a0 有 ${linkStats.missing.size} 个 md 链接找不到对应文档：${list}${linkStats.missing.size > 8 ? ' …' : ''}`)
  }
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

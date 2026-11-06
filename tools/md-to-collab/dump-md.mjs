#!/usr/bin/env node
/**
 * 把协同 .bin 还原成可读 Markdown，便于人工校对内容（重复段落、顺序、层级）。
 *
 *   node dump-md.mjs <file.bin> [out.md]
 *
 * 只读：不修改源文件，也不碰服务端。
 */
import fs from 'fs'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'

const file = process.argv[2]
const out = process.argv[3]
if (!file) {
  console.error('用法: node dump-md.mjs <file.bin> [out.md]')
  process.exit(1)
}

const ydoc = new Y.Doc()
Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(file)))
const doc = yDocToProsemirrorJSON(ydoc, 'default')

function md(node, depth = 0) {
  const type = node.type
  const kids = node.content || []
  const inline = (ns) =>
    (ns || [])
      .map((n) => {
        if (n.type === 'text') {
          let t = n.text || ''
          const marks = (n.marks || []).map((m) => m.type)
          if (marks.includes('code')) t = '`' + t + '`'
          if (marks.includes('bold')) t = '**' + t + '**'
          if (marks.includes('italic')) t = '*' + t + '*'
          if (marks.includes('strike')) t = '~~' + t + '~~'
          const link = (n.marks || []).find((m) => m.type === 'link')
          if (link) t = `[${t}](${link.attrs?.href || ''})`
          return t
        }
        if (n.type === 'hardBreak') return '  \n'
        if (n.type === 'image') return `![${n.attrs?.alt || ''}](${n.attrs?.src || ''})`
        if (n.type === 'mermaidBlock' || n.type === 'plantumlBlock') return '\n```' + (n.type === 'mermaidBlock' ? 'mermaid' : 'plantuml') + '\n' + (n.attrs?.code || '') + '\n```\n'
        return inline(n.content)
      })
      .join('')
  const indent = '  '.repeat(depth)

  switch (type) {
    case 'heading': {
      const lvl = '#'.repeat(node.attrs?.level || 1)
      return `${lvl} ${inline(kids)}`
    }
    case 'paragraph':
      return indent + inline(kids)
    case 'codeBlock':
      return '```' + (node.attrs?.language || '') + '\n' + kids.map((c) => c.text || '').join('') + '\n```'
    case 'blockquote':
      return kids.map((k) => '> ' + md(k, 0).replace(/\n/g, '\n> ')).join('\n')
    case 'bulletList':
      return kids.map((li) => mdListItem(li, depth, '- ')).join('\n')
    case 'orderedList': {
      let i = 1
      return kids.map((li) => mdListItem(li, depth, `${i++}. `)).join('\n')
    }
    case 'taskList':
      return kids.map((li) => mdListItem(li, depth, li.attrs?.checked ? '- [x] ' : '- [ ] ')).join('\n')
    case 'table': {
      const rows = kids.map((row) => (row.content || []).map((cell) => (cell.content || []).map((p) => inline(p.content)).join(' ').replace(/\|/g, '\\|')))
      if (!rows.length) return ''
      const head = '| ' + rows[0].join(' | ') + ' |'
      const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |'
      const body = rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |')
      return [head, sep, ...body].join('\n')
    }
    case 'horizontalRule':
      return '---'
    case 'image':
      return `![${node.attrs?.alt || ''}](${node.attrs?.src || ''})`
    default:
      return kids.map((k) => (k.type === 'text' ? k.text : md(k, depth))).join('\n')
  }
}

function mdListItem(li, depth, bullet) {
  const parts = (li.content || []).map((c, i) => (i === 0 ? md(c, 0) : md(c, depth + 1)))
  return '  '.repeat(depth) + bullet + parts.join('\n')
}

const body = (doc.content || []).map((n) => md(n)).join('\n\n')
if (out) {
  fs.writeFileSync(out, body)
  console.log(`wrote ${out}  ${body.length} chars  ${(doc.content || []).length} blocks`)
} else {
  console.log(body)
}

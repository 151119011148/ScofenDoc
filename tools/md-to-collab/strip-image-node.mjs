#!/usr/bin/env node
/**
 * 从 Yjs .bin 里删除 image 节点（用于清理自动化测试往 doc 647 里插的测试图）。
 *
 *   node strip-image-node.mjs <in.bin> <out.bin> [urlKeyword]
 *
 * 直接在 Y.XmlFragment 层删除，不走 ProseMirror JSON 往返，
 * 避免 schema 缺失导致节点被降级或属性丢失。
 */
import fs from 'fs'
import * as Y from 'yjs'

const [, , inFile, outFile, keyword = ''] = process.argv
if (!inFile || !outFile) {
  console.error('用法: node strip-image-node.mjs <in.bin> <out.bin> [urlKeyword]')
  process.exit(1)
}

const doc = new Y.Doc()
Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(inFile)))
const frag = doc.getXmlFragment('default')

const removed = []
function walk(parent, path) {
  for (let i = 0; i < parent.length; i++) {
    const child = parent.get(i)
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'image') {
        const src = child.getAttribute('src') || ''
        if (!keyword || src.includes(keyword)) {
          removed.push(src)
          parent.delete(i, 1)
          i--
          continue
        }
      }
      walk(child, path + '/' + child.nodeName)
    }
  }
}
walk(frag, '')

function describe(el, depth = 0) {
  const out = []
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i)
    if (c instanceof Y.XmlElement) {
      const attrs = c.getAttributes?.() || {}
      out.push('  '.repeat(depth) + c.nodeName + (attrs.src ? ' src=' + attrs.src : ''))
      out.push(...describe(c, depth + 1))
    } else if (c instanceof Y.XmlText) {
      const t = c.toString()
      if (t.trim()) out.push('  '.repeat(depth) + 'text: ' + JSON.stringify(t.slice(0, 60)))
    }
  }
  return out
}

console.log('删除的 image 节点:', JSON.stringify(removed))
console.log('当前结构:')
console.log(describe(frag).join('\n') || '(空)')

fs.writeFileSync(outFile, Y.encodeStateAsUpdate(doc))
console.log('已写出', outFile, fs.statSync(outFile).size, 'bytes')

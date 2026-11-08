#!/usr/bin/env node
/**
 * 用一份新的 Markdown 整体重建某篇协同文档，并把标题打上「自动编号」属性。
 *
 *   node rebuild-doc.mjs <目标.bin> <new.md> <输出.bin> [--numbered]
 *
 * 与 replace-ydoc.mjs 的区别只有一点：replace-ydoc 忠实还原 Markdown，
 * 而站点里的文档标题是「纯文字 + numbered 属性」由前端派生序号（1 / 1.1 / …）。
 * 纯 Markdown 重建会把这个属性丢掉，整篇文档的序号和目录层级看起来就变了。
 * 所以重建线上文档时要用这个脚本，--numbered 会给所有顶层标题补上 numbered=true。
 *
 * 不传 --numbered 时行为与 replace-ydoc.mjs 一致。
 */
import fs from 'fs'
import { marked } from 'marked'
import { Extension, getSchema } from '@tiptap/core'
import { generateJSON } from '@tiptap/html'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { buildExtensions } from './html-to-ydoc-core.mjs'

/**
 * 标题的自动编号属性。
 *
 * 前端是 HeadingNumber 扩展加在 heading 上的全局属性；离线这条链路没引它，
 * 于是 schema 里没有 numbered / numberStyle，generateJSON 会直接把这两个属性丢掉，
 * 重建出来的文档就变成「标题有文字、但没有 1 / 1.1 序号」。
 * 这里补一份同名的属性定义（字段、默认值、序列化形式与前端一致），只在本脚本内使用。
 */
const HeadingNumberAttrs = () =>
  Extension.create({
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
              parseHTML: (el) =>
                el.getAttribute('data-numbered-style') === 'unordered' ? 'unordered' : 'ordered',
              renderHTML: (attrs) =>
                attrs.numbered && attrs.numberStyle === 'unordered'
                  ? { 'data-numbered-style': 'unordered' }
                  : {},
            },
          },
        },
      ]
    },
  })

const extForSchema = () => [...buildExtensions(), HeadingNumberAttrs()]

const args = process.argv.slice(2)
const numbered = args.includes('--numbered')
const [binIn, mdFile, binOut] = args.filter((a) => !a.startsWith('--'))
if (!binIn || !mdFile || !binOut) {
  console.error('用法: node rebuild-doc.mjs <目标.bin> <new.md> <输出.bin> [--numbered]')
  process.exit(1)
}

const schema = getSchema(extForSchema())
const md = fs.readFileSync(mdFile, 'utf8')

/**
 * 加粗包着行内代码时，marked 解析出的 strong 会被切成几段 mark：
 * 页面上仍是粗体，但 y-prosemirror 回读出来的 Markdown 会多出断点，
 * 下次核对就得逐行比对。这里提前提示，不阻断（页面效果本身没错）。
 */
const boldWithCode = []
for (const [i, line] of md.split('\n').entries()) {
  for (const m of line.matchAll(/\*\*[^*\n]*\*\*/g)) {
    if (m[0].includes('`')) boldWithCode.push(`第 ${i + 1} 行 ${m[0].slice(0, 40)}`)
  }
}

const html = marked.parse(md, { gfm: true, breaks: false })
const json = generateJSON(html, extForSchema())

let headings = 0
if (numbered) {
  for (const node of json.content || []) {
    if (node.type === 'heading') {
      node.attrs = { ...(node.attrs || {}), numbered: true }
      headings++
    }
  }
}

const fresh = prosemirrorJSONToYDoc(schema, json, 'default')
const update = Y.encodeStateAsUpdate(fresh)

const check = new Y.Doc()
Y.applyUpdate(check, update)
const back = yDocToProsemirrorJSON(check, 'default')
const count = (j) => (j.content || []).length

if (count(back) !== count(json)) {
  console.error(`✗ 顶层块数不一致：写入 ${count(json)}，读回 ${count(back)}`)
  process.exit(1)
}

const src = new Y.Doc()
Y.applyUpdate(src, new Uint8Array(fs.readFileSync(binIn)))
const old = yDocToProsemirrorJSON(src, 'default')

// 标题属性自检：确认 numbered 真的写进 Y.Doc 了（协同端读到的才是这个）
const backHeads = (back.content || []).filter((n) => n.type === 'heading')
const unnumbered = backHeads.filter((n) => !n.attrs?.numbered).length
if (numbered && unnumbered) {
  console.error(`✗ 有 ${unnumbered} 个标题没带上 numbered 属性`)
  process.exit(1)
}

fs.writeFileSync(binOut, Buffer.from(update))
console.log(
  `✓ ${binOut}\n  顶层块 ${count(old)} → ${count(back)}，` +
    `标题 ${backHeads.length} 个（numbered ${backHeads.length - unnumbered}）`,
)
if (boldWithCode.length) {
  console.warn(`⚠ 有 ${boldWithCode.length} 处加粗包着行内代码，回读时会多出断点：`)
  boldWithCode.slice(0, 5).forEach((x) => console.warn('  ', x))
}

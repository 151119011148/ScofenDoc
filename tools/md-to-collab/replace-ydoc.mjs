#!/usr/bin/env node
/**
 * 用一份新的 Markdown 整体替换某篇协同文档的正文。
 *
 *   node replace-ydoc.mjs <目标.bin> <new.md> <输出.bin>
 *
 * 只做「读 → 构建 → 写出」，不删任何东西；线上替换前务必先备份原 bin。
 * 构建与 md-to-ydoc.mjs 完全同一套扩展集，保证和前端 schema 逐项一致，
 * 否则表格、图片、代码块这类节点会在客户端被静默丢弃。
 */
import fs from 'fs'
import { marked } from 'marked'
import { getSchema } from '@tiptap/core'
import { generateJSON } from '@tiptap/html'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { buildExtensions } from './html-to-ydoc-core.mjs'

const [binIn, mdFile, binOut] = process.argv.slice(2)
if (!binIn || !mdFile || !binOut) {
  console.error('用法: node replace-ydoc.mjs <目标.bin> <new.md> <输出.bin>')
  process.exit(1)
}

const schema = getSchema(buildExtensions())
const md = fs.readFileSync(mdFile, 'utf8')
const html = marked.parse(md, { gfm: true, breaks: false })
// generateJSON 收的是扩展数组，不是 schema；两处各建一份，避免同一批扩展实例被重复注册
const json = generateJSON(html, buildExtensions())

const fresh = prosemirrorJSONToYDoc(schema, json, 'default')
const update = Y.encodeStateAsUpdate(fresh)

// 写出前先自检：新 bin 能读回同样的顶层块数，且没有节点被 schema 丢掉
const check = new Y.Doc()
Y.applyUpdate(check, update)
const back = yDocToProsemirrorJSON(check, 'default')
const count = (j) => (j.content || []).length

const src = new Y.Doc()
Y.applyUpdate(src, new Uint8Array(fs.readFileSync(binIn)))
const old = yDocToProsemirrorJSON(src, 'default')

if (count(back) !== count(json)) {
  console.error(`✗ 顶层块数不一致：写入 ${count(json)}，读回 ${count(back)}`)
  process.exit(1)
}
fs.writeFileSync(binOut, Buffer.from(update))
console.log(
  `✓ ${binOut}\n  顶层块 ${count(old)} → ${count(back)}，` +
    `字符 ${JSON.stringify(old).length} → ${JSON.stringify(back).length}`,
)

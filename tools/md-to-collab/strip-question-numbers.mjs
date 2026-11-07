#!/usr/bin/env node
/**
 * 扫描 / 清理正文里的问答编号前缀：Q1： / Q2: / Q10：
 *
 * 用法：
 *   node scan-question-numbers.mjs <数据目录>              # 只读扫描
 *   node strip-question-numbers.mjs <数据目录> <输出目录>   # 写到新目录，不动原文件
 *
 * 为什么要在 Yjs 层做而不是改成 Markdown 再整体重建：delete 几个字符只改文本，
 * 批注锚点、块 id、行内格式、图片引用全部原样保留；重建会把这些都丢掉。
 */
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import * as Y from 'yjs'

/**
 * 三条约束都是踩过的：
 * - `(?<![A-Za-z])` 前置字母边界：否则 "RocketMQ 7 篇"、"FAQ3:" 会被误当成编号；
 * - 必须有冒号："Q3 索引" 这类是正文，不动；
 * - 冒号后最多吃两个空格，避免行首留空格，又不会啃掉正文。
 */
export const QNUM = /(?<![A-Za-z])Q[ \t]*\d{1,2}[ \t]*[：:][ \t]{0,2}/g

const isCode = (el) => /code/i.test(el.nodeName || '')

function walk(node, visit, inCode = false) {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) visit(child, inCode)
    else if (child instanceof Y.XmlElement) walk(child, visit, inCode || isCode(child))
    else if (child instanceof Y.XmlFragment) walk(child, visit, inCode)
  }
}

export function readDoc(file) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(file)))
  return doc
}

/** 只读扫描：返回 { 文件, 命中数, 样例 } */
export function scanDoc(file) {
  const doc = readDoc(file)
  const found = []
  walk(doc.getXmlFragment('default'), (t, inCode) => {
    const s = t.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '\uFFFC')).join('')
    for (const m of s.matchAll(new RegExp(QNUM.source, 'g'))) {
      found.push({ cut: m[0], inCode, after: s.slice(m.index + m[0].length, m.index + m[0].length + 20) })
    }
  })
  return { hits: found.length, found }
}

/** 删除编号，返回改动列表；代码块跳过 */
export function stripDoc(doc) {
  const blocks = []
  const collect = (n) => {
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlElement) {
        blocks.push(c)
        collect(c)
      } else if (c instanceof Y.XmlFragment) collect(c)
    }
  }
  collect(doc.getXmlFragment('default'))

  const changes = []
  Y.transact(doc, () => {
    for (const el of blocks) {
      if (isCode(el)) continue
      for (const t of el.toArray()) {
        if (!(t instanceof Y.XmlText)) continue
        const s = t.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '\uFFFC')).join('')
        const ms = [...s.matchAll(new RegExp(QNUM.source, 'g'))]
        // 倒序删：正序删会让后面的位置整体左移
        for (let i = ms.length - 1; i >= 0; i--) {
          const m = ms[i]
          t.delete(m.index, m[0].length)
          changes.push({ block: el.nodeName, cut: m[0] })
        }
      }
    }
  })
  return changes
}

// 项目路径含中文，不能拼 `file://${argv[1]}`：import.meta.url 是 percent-encode 过的
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, out] = process.argv.slice(2)
  if (!dir) {
    console.error('用法：node strip-question-numbers.mjs <数据目录> [输出目录]')
    process.exit(1)
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bin'))
  if (!out) {
    // 无输出目录就是只读扫描
    let total = 0
    for (const f of files) {
      const r = scanDoc(path.join(dir, f))
      if (r.hits) {
        total += r.hits
        console.log(`${String(r.hits).padStart(4)}  ${f.slice(0, 8)}  ${JSON.stringify(r.found[0].cut)}${JSON.stringify(r.found[0].after)}`)
      }
    }
    console.log(`\n合计 ${total} 处`)
    process.exit(0)
  }
  fs.mkdirSync(out, { recursive: true })
  let n = 0
  let cuts = 0
  for (const f of files) {
    const doc = readDoc(path.join(dir, f))
    const ch = stripDoc(doc)
    if (!ch.length) continue
    fs.writeFileSync(path.join(out, f), Y.encodeStateAsUpdate(doc))
    n++
    cuts += ch.length
  }
  console.log(`改写 ${n} 个文件，删除编号 ${cuts} 处 → ${out}`)
}

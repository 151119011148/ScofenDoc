#!/usr/bin/env node
/**
 * 单个存档页 HTML → 协同 .bin（命令行入口；批量导入见 archive-import.mjs）
 *
 * 用法:
 *   node html-to-ydoc.mjs <input.html> <output.bin> --self <docId> --space <spaceId>
 *        [--archive-manifest map.json] [--md-manifest link-manifest.json]
 *        [--img-base /scofendoc/files/archive/csdn/] [--title "..."] [--dry] [--quiet]
 */
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from 'y-prosemirror'
import { convertHtml, schema } from './html-to-ydoc-core.mjs'

const argv = process.argv.slice(2)
const positional = []
const opts = {
  selfDocId: 0,
  spaceId: 2,
  archiveManifest: '',
  mdManifest: '',
  imgBase: '',
  title: '',
  dirPrefix: '',
  stripMeta: false,
  dry: false,
  quiet: false,
}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--self') opts.selfDocId = Number(argv[++i] || 0)
  else if (a === '--space') opts.spaceId = Number(argv[++i] || 2)
  else if (a === '--archive-manifest') opts.archiveManifest = argv[++i] || ''
  else if (a === '--md-manifest') opts.mdManifest = argv[++i] || ''
  else if (a === '--img-base') opts.imgBase = argv[++i] || ''
  else if (a === '--title') opts.title = argv[++i] || ''
  else if (a === '--dir-prefix') opts.dirPrefix = argv[++i] || ''
  else if (a === '--strip-meta') opts.stripMeta = true
  else if (a === '--dry') opts.dry = true
  else if (a === '--quiet') opts.quiet = true
  else if (a.startsWith('--')) {
    console.error(`未知参数：${a}`)
    process.exit(1)
  } else positional.push(a)
}

if (positional.length < 2) {
  console.error('用法: node html-to-ydoc.mjs <input.html> <output.bin> --self N --space N [--archive-manifest map.json]')
  process.exit(1)
}

const [htmlFile, binFile] = positional
const archiveMap =
  opts.archiveManifest && fs.existsSync(opts.archiveManifest)
    ? JSON.parse(fs.readFileSync(opts.archiveManifest, 'utf8'))
    : {}
const mdMap = opts.mdManifest && fs.existsSync(opts.mdManifest) ? JSON.parse(fs.readFileSync(opts.mdManifest, 'utf8')) : {}
const mdByName = {}
for (const [abs, hit] of Object.entries(mdMap)) {
  mdByName[path.basename(abs).replace(/\.md$/i, '')] = hit
}

const { json, stats, counts, dropped } = convertHtml(htmlFile, {
  selfDocId: opts.selfDocId,
  spaceId: opts.spaceId,
  archiveMap,
  mdByName,
  imgBase: opts.imgBase,
  title: opts.title,
  dirPrefix: opts.dirPrefix,
  stripMeta: opts.stripMeta,
})

const summary = `链接 ${stats.links}(内 ${stats.internal}/外 ${stats.external}/降级 ${stats.dropped})  图 ${stats.imgs}+${stats.remoteImgs}`

if (opts.dry) {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')
  console.log(`${path.basename(htmlFile)}  块 ${(json.content || []).length}  ${summary}`)
  console.log(`  ${top}`)
  if (dropped.length) console.log(`  降级样例: ${dropped.join(' , ')}`)
  process.exit(0)
}

const ydoc = prosemirrorJSONToYDoc(schema, json, 'default')
const update = Y.encodeStateAsUpdate(ydoc)
fs.writeFileSync(binFile, Buffer.from(update))

if (!opts.quiet) {
  console.log(
    `${path.basename(htmlFile)} → ${path.basename(binFile)}  ${(update.length / 1024).toFixed(1)}KB  块 ${(json.content || []).length}  ${summary}`,
  )
}

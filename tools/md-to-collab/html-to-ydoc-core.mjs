/**
 * 离线存档 HTML → ProseMirror JSON（可被批量导入器直接调用，不写文件）
 *
 * 存档页是本地生成的干净页面：
 *   CSDN：<div id="content_views">（原样保存的 CSDN 正文）
 *   语雀：<div id="content">
 * 所以不经过 Markdown，直接把正文 HTML 交给 Tiptap 的 generateJSON，
 * 再用与前端**逐项一致**的 schema 转成 ProseMirror JSON —— 省掉一次 md 往返，表格/代码块更保真。
 *
 * 正文里的三类地址必须改写，否则导入后全是死链：
 *   1. <img src="img/x.png">   → 站内静态目录（nginx 托管）
 *   2. <a href="xxx.html">     → ?space=&doc= 站内深链
 *   3. <a href="../X.html">    → 先按 X.md 查已发布文档表，再退回站内表
 * 查不到的相对链接降级成纯文本（留着必然 404）。
 */
import fs from 'fs'
import path from 'path'
import * as cheerio from 'cheerio'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { generateJSON } from '@tiptap/html'
import { MermaidBlock } from './mermaid-block.mjs'
import { PlantUMLBlock } from './plantuml-block.mjs'

/* ---------------- 与前端完全一致的扩展集 ---------------- */

export function buildExtensions() {
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
  ]
}

export const schema = getSchema(buildExtensions())

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

/**
 * 把 href 解析成 {docId, spaceId, anchor} / 'external' / false
 * @param {string} href
 * @param {{selfDocId:number, spaceId:number, archiveMap:object, mdByName:object}} ctx
 */
function resolveHref(href, ctx) {
  if (!href) return false
  if (/^(mailto:|tel:|javascript:)/i.test(href)) return false
  if (/^https?:/i.test(href)) return 'external'
  if (href.startsWith('#')) {
    return { docId: ctx.selfDocId, spaceId: ctx.spaceId, anchor: safeDecode(href.slice(1)) }
  }
  const [rawPath, rawHash = ''] = href.split('#')
  const name = safeDecode(rawPath.replace(/^\.\//, ''))
  const base = path.basename(name)
  const dir = path.dirname(name)
  const anchor = safeDecode(rawHash)

  const sameFolder = dir && dir !== '.' ? `${dir}/${base}` : null
  if (sameFolder && ctx.archiveMap[sameFolder]) {
    const hit = ctx.archiveMap[sameFolder]
    return { docId: hit.docId, spaceId: hit.spaceId ?? ctx.spaceId, anchor }
  }
  if (ctx.archiveMap[base]) {
    const hit = ctx.archiveMap[base]
    return { docId: hit.docId, spaceId: hit.spaceId ?? ctx.spaceId, anchor }
  }
  // 索引页里的链接是同目录相对名（106092509.html），表里的键带目录（CSDN存档/106092509.html）
  if (ctx.dirPrefix && ctx.archiveMap[ctx.dirPrefix + base]) {
    const hit = ctx.archiveMap[ctx.dirPrefix + base]
    return { docId: hit.docId, spaceId: hit.spaceId ?? ctx.spaceId, anchor }
  }
  // 索引页里的链接是同目录相对名（106092509.html），表里的键带目录（CSDN存档/106092509.html）
  if (ctx.dirPrefix && ctx.archiveMap[ctx.dirPrefix + base]) {
    const hit = ctx.archiveMap[ctx.dirPrefix + base]
    return { docId: hit.docId, spaceId: hit.spaceId ?? ctx.spaceId, anchor }
  }
  if (/\.html?$/i.test(base)) {
    const stem = base.replace(/\.html?$/i, '')
    if (ctx.mdByName[stem]) {
      const hit = ctx.mdByName[stem]
      return { docId: hit.docId, spaceId: hit.spaceId ?? ctx.spaceId, anchor }
    }
  }
  return false
}

/**
 * 转换一个存档页
 * @returns {{json:object, stats:object, counts:object, dropped:string[]}}
 */
export function convertHtml(file, opts) {
  const {
    selfDocId = 0,
    spaceId = 2,
    archiveMap = {},
    mdByName = {},
    imgBase = '',
    title = '',
    dirPrefix = '',
    stripMeta = false,
  } = opts || {}
  const ctx = { selfDocId, spaceId, archiveMap, mdByName, dirPrefix }
  const stats = { links: 0, external: 0, internal: 0, imgs: 0, remoteImgs: 0, dropped: 0 }
  const dropped = []

  const source = fs.readFileSync(file, 'utf8')
  const $ = cheerio.load(source)

  /**
   * 用 cheerio（parse5 内核）解析，而不是 zeed-dom。
   * CSDN 正文里的内联属性带嵌套引号（data-report-click="{&quot;spm&quot;:...}"），
   * zeed-dom 会把整个 <span> 当成纯文本塞回正文，导入后首行出现字面的标签串。
   */
  const article =
    $('[id="content_views"]').first().length ? $('[id="content_views"]').first()
    : $('.htmledit_views').length ? $('.htmledit_views').first()
    : $('[id="content"]').first().length ? $('[id="content"]').first()
    : $('article').length ? $('article').first()
    : $('body')

  if (!article.length) throw new Error(`没找到正文容器：${file}`)

  // 页眉/导航/说明块是本地浏览用的，进站后由文档树承担导航
  article.find('.nav, .head, .meta, .note, script, style').remove()
  // 索引页的列表项后面跟着「2020-05-13 ｜ 106092509」这类元信息，正文里是纯噪声
  if (stripMeta) article.find('li span.n').remove()

  /* 图片 */
  article.find('img').each((_, el) => {
    const node = $(el)
    const src = node.attr('src') || ''
    const alt = node.attr('alt') || ''
    if (!src || /^data:/i.test(src)) {
      node.remove()
      return
    }
    if (/^https?:/i.test(src)) {
      stats.remoteImgs += 1
      return
    }
    stats.imgs += 1
    node.attr('src', `${imgBase}${path.basename(src.replace(/^\.\//, ''))}`)
    if (alt) node.attr('alt', alt.slice(0, 120))
  })

  /* 链接 */
  article.find('a').each((_, el) => {
    const node = $(el)
    const href = (node.attr('href') || '').trim()
    if (!href) {
      node.replaceWith(node.contents())
      return
    }
    const hit = resolveHref(href, ctx)
    stats.links += 1
    if (hit === 'external') {
      stats.external += 1
      node.attr('target', '_blank').attr('rel', 'noopener noreferrer')
      return
    }
    if (hit) {
      stats.internal += 1
      node.attr('href', internalUrl(hit.docId, hit.spaceId, hit.anchor))
      return
    }
    stats.dropped += 1
    if (dropped.length < 8) dropped.push(href)
    node.replaceWith(node.contents())
  })

  /* 清属性 */
  article.find('td, th').removeAttr('rowspan').removeAttr('colspan')
  article
    .find('*')
    .removeAttr('style')
    .removeAttr('align')
    .removeAttr('class')
    .removeAttr('id')
    .removeAttr('data-report-click')
    .removeAttr('data-href')
    .removeAttr('data-tit')
    .removeAttr('data-pretit')
    .removeAttr('loading')
    .removeAttr('width')
    .removeAttr('height')

  const innerHTML = article.html() || ''
  const json = generateJSON(innerHTML, buildExtensions())

  // 语雀的 h1 在 #content 外面，CSDN 正文则没有标题；标题统一由列表名给
  if (title) {
    const first = (json.content || [])[0]
    const hasHeading = first && first.type === 'heading'
    if (!hasHeading) {
      json.content = [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
        ...(json.content || []),
      ]
    }
  }

  // 严格校验：prosemirrorJSONToYDoc 对不合法结构会直接抛，早点定位到具体文件
  schema.nodeFromJSON(json)

  const counts = {}
  ;(function walk(n) {
    counts[n.type] = (counts[n.type] || 0) + 1
    ;(n.content || []).forEach(walk)
  })(json)

  return { json, stats, counts, dropped }
}

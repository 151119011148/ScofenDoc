#!/usr/bin/env node
/**
 * 把协同文档里「散落的编码文本」统一改成代码块。
 *
 * 背景：CSDN / 语雀存档导入时，部分 <pre> 代码被解析成有序列表（每个 li 一行代码）
 * 或一串普通段落，渲染出来没有代码块样式。本工具扫描所有 Yjs .bin，把这些块
 * 精确替换成 <codeBlock>，其它块（标题、图片、表格、已有代码块、正文）原样不动。
 *
 * 三个阶段，互不越界：
 *   scan   <data-dir> <docs.tsv> <plan.json>   只读扫描，产出待办清单
 *   apply  <data-dir> <plan.json> <out-dir>    按清单改本地副本，产出新 bin
 *   verify <data-dir> <out-dir> <plan.json>    对比前后文本，确保一个字都没丢
 *
 * 判定与合并规则见 classifyLine / buildOps，改之前务必先看 scan 的预览。
 */
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'

const stage = process.argv[2]

/* ---------------- 公共：文本抽取 ---------------- */

function textOf(n) {
  if (!n) return ''
  if (n.type === 'hardBreak') return '\n'
  if (n.type === 'text') return n.text || ''
  return (n.content || []).map(textOf).join('')
}

function linesOf(block) {
  if (['orderedList', 'bulletList', 'taskList'].includes(block.type)) {
    return (block.content || []).map((li) =>
      (li.content || []).map(textOf).join('\n').replace(/\n$/, ''),
    )
  }
  if (block.type === 'blockquote') {
    return (block.content || []).flatMap((c) => textOf(c).split('\n'))
  }
  return textOf(block).split('\n')
}

/** NBSP / 全角空格 → 普通空格，行尾空白清掉，行首缩进保留 */
function normLine(line) {
  return line.replace(/\u00a0/g, ' ').replace(/\u3000/g, '  ').replace(/[ \t]+$/, '')
}

/* ---------------- 行分类 ---------------- */

const CODE_KEYWORDS = /\b(?:if|else|for|foreach|while|switch|case|return|break|continue|throw|try|catch|finally|new|class|interface|enum|public|private|protected|static|final|void|import|package|extends|implements|def|function|func|lambda|synchronized|volatile|transient|abstract|this|super|instanceof|assert|const|let|var|null|true|false|grant|permission|printf|sizeof|malloc)\b/
const SQL_KEYWORDS = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|VALUES|INTO|EXISTS|TABLE|DATABASE|GRANT|PERMISSION)\b/i
const CODE_OPS = /(?:->|=>|::|==|!=|>=|<=|\+=|-=|\*=|\/=|&&|\|\||\+\+|--|<<|>>)/
const CODE_SKELETON = /[;{}]|=>|->|==|::|^\s*(?:import|package|#include|#define|@\w+|<\/?[\w-]+|--\s|grant\b|permission\b)/i

/** 单行要成为代码，必须有明确的语句骨架；光是「函数调用」或英文单词不够 */
function isSingleLineCode(s) {
  if (/[;{}]\s*$/.test(s)) return true
  if (/[{}]/.test(s) && /[=()]|\b(?:if|for|while|switch|class|try)\b/.test(s)) return true
  if (/(?:->|=>|==|::|!=|>=|<=|\+=|&&|\|\|)/.test(s)) return true
  if (/^\s*(?:import|package|#include|#define|@\w+|grant|permission|public|private|protected|static|final|void|class|interface|enum|def|function|const|let|var|if|for|while|return|new)\b/.test(s)) return true
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i.test(s)) return true
  if (/^\s*[\w.]+\s*=\s*\S/.test(s)) return true
  if (/^\s*(?:<\/?[\w-]+|<!--)/.test(s)) return true
  return false
}

/** @returns {'blank'|'code'|'prose'} */
function classifyLine(raw) {
  const line = normLine(raw)
  const s = line.trim()
  if (!s) return 'blank'

  // 文件名 / 路径 / 图片名：create-default-node.png、src/main/java/X.java
  if (/^[\w./\\:+-]+\.(?:png|jpe?g|gif|svg|webp|bmp|md|txt|pdf|html?|xml|json|ya?ml|properties|java|class|jar|zip|sh|py|js|ts|css|sql|log|cfg|dat|ini)$/i.test(s)) return 'prose'
  // 「<first_name>显然选择性太低」这类中文讲解里的占位符，不是 HTML 标签
  if (/^<[\w, ]+>/.test(s) && (s.match(/[\u4e00-\u9fff]/g) || []).length >= 3) return 'prose'
  // 行首注释 / 注解 / 标签（JavaDoc、properties、SQL、XML、HTML）属于代码骨架，
  // 必须放在「自然语言长句」之前，否则 JavaDoc 的长英文句子会被当成说明而割裂代码块。
  if (/^(?:\/\/|\/\*|\*|<!--|-->|--\s|<\/?[\w-]+|<\?|\$\{|\{\{|<%|\?php)/.test(s)) return 'code'
  if (/^#/.test(s) && (s.match(/[\u4e00-\u9fff]/g) || []).length < 3) return 'code'
  if (/^@\w+/.test(s) && (s.match(/[\u4e00-\u9fff]/g) || []).length < 3) return 'code'
  // 自然语言长句（英文引用、说明），没有代码骨架
  if (s.length > 70 && !/[;{}]/.test(s) && (s.match(/\s/g) || []).length >= 8 && /[.!?](?:\s|$)/.test(s)) return 'prose'
  const cnAll = (line.match(/[\u4e00-\u9fff]/g) || []).length
  const indent = /^[ \t]{2,}/.test(line)

  // 中文多的行：中文技术文章里也常用 ASCII 分号，不能凭「; 结尾」判代码。
  // 只有两种情况放行：代码后跟中文行尾注释、或带缩进的赋值/调用行。
  if (cnAll >= 3) {
    const m = line.match(/^(.*?)(\/\/|#\s)(.*)$/)
    if (m) {
      const before = m[1]
      const cnBefore = (before.match(/[\u4e00-\u9fff]/g) || []).length
      if (cnBefore < 2 && /[;{}()=]/.test(before)) return 'code'
    }
    if (indent && /^[ \t]*[\w.]+\s*[({=]/.test(line) && cnAll <= 8) return 'code'
    return 'prose'
  }

  if (/^\s*\d+\s*[、．.]/.test(s)) return 'prose'          // 「1、selectNow()」中文序号列表
  if (/[：:]/.test(s) && cnAll >= 1) return 'prose'         // 「xxx：说明」
  if (/[。！？]$/.test(s) && !/[;{}()]/.test(s)) return 'prose'

  if (CODE_KEYWORDS.test(s)) return 'code'
  if (SQL_KEYWORDS.test(s)) return 'code'
  if (CODE_OPS.test(s)) return 'code'
  if (/[;{},]\s*$/.test(s) || /[{}]/.test(s)) return 'code'
  if (/\b\w+\s*\([^)]*\)/.test(s) && cnAll < 3) return 'code'
  if (/^\s*[\w.]+\s*=\s*\S/.test(s) && cnAll < 3) return 'code'
  if (/<\/?[\w-]+[^>]*>/.test(s)) return 'code'
  return 'prose'
}

/* ---------------- 块分类与替换操作 ---------------- */

const CONVERTIBLE = new Set(['paragraph', 'orderedList', 'bulletList', 'taskList', 'blockquote'])

/** 混合块：只把「开头 / 结尾」的说明行剥成普通段落，中间整段保留为一个代码块。
 *  不按行交替切 —— 那样会把 JavaDoc、properties 注释、SQL 注释从代码里硬切出去。 */
function splitMixed(lines) {
  const cls = lines.map(classifyLine)
  const first = cls.findIndex((c) => c === 'code')
  if (first < 0) return lines.filter((l) => l.trim()).map((l) => ({ type: 'paragraph', text: l }))
  let last = cls.length - 1
  while (last >= 0 && cls[last] !== 'code') last--
  const mid = lines.slice(first, last + 1)
  while (mid.length && !mid[0].trim()) mid.shift()
  while (mid.length && !mid[mid.length - 1].trim()) mid.pop()
  const out = []
  for (const l of lines.slice(0, first).filter((l) => l.trim())) out.push({ type: 'paragraph', text: l })
  if (mid.length) out.push({ type: 'codeBlock', text: mid.join('\n') })
  for (const l of lines.slice(last + 1).filter((l) => l.trim())) out.push({ type: 'paragraph', text: l })
  return out
}

function blockInfo(block) {
  if (!CONVERTIBLE.has(block.type)) return { kind: 'skip' }
  const lines = linesOf(block).map(normLine)
  const cls = lines.map(classifyLine)
  const code = cls.filter((c) => c === 'code').length
  const prose = cls.filter((c) => c === 'prose').length
  const meaningful = code + prose
  if (!meaningful || !code) return { kind: 'skip', lines, code, prose }
  const nonBlank = lines.filter((l) => l.trim())
  const ratio = code / meaningful

  // 只有一行的块：必须是明确的代码骨架，避免把「Filter(ServletFilter)」「Case 4」「xxx.png」这类术语转掉
  if (nonBlank.length === 1 && !isSingleLineCode(nonBlank[0])) {
    return { kind: 'skip', lines, code, prose, ratio }
  }
  // 单行代码（含「每行一个 orderedList」的 CSDN 形态）优先交给「连续合并」逻辑
  if (nonBlank.length === 1 && prose === 0 && code >= 1) {
    return { kind: 'codeLine', lines, code, prose, ratio }
  }
  // 整块就是代码（含代码注释、空行）：直接换成一个 codeBlock
  if (prose === 0 || (ratio >= 0.85 && prose <= 2)) {
    return { kind: 'codeBlock', lines, code, prose, ratio }
  }
  // 说明 + 代码混排：拆开，说明留成普通段落
  if (ratio >= 0.55 && code >= 2) return { kind: 'mixed', lines, code, prose, ratio }
  return { kind: 'skip', lines, code, prose, ratio }
}

/** 生成一个文档的替换操作列表；从后往前应用，索引不漂移 */
function buildOps(blocks) {
  const infos = blocks.map(blockInfo)
  const ops = []
  let i = 0
  while (i < blocks.length) {
    const info = infos[i]
    if (info.kind === 'skip' || info.kind === 'codeLine') { i++; continue }
    if (info.kind === 'codeBlock') {
      let text = info.lines.slice()
      while (text.length && !text[0].trim()) text.shift()
      while (text.length && !text[text.length - 1].trim()) text.pop()
      ops.push({
        start: i, count: 1,
        blocks: [{ type: 'codeBlock', text: text.join('\n') }],
        reason: `${blocks[i].type}/${info.lines.length}行`,
      })
      i++
      continue
    }
    if (info.kind === 'mixed') {
      const made = splitMixed(info.lines)
      if (made.length === 1 && made[0].type === 'codeBlock') {
        ops.push({ start: i, count: 1, blocks: made, reason: `mixed→单代码块` })
      } else if (made.some((b) => b.type === 'codeBlock')) {
        ops.push({ start: i, count: 1, blocks: made, reason: `mixed→拆分(${made.length}块)` })
      }
      i++
      continue
    }
    i++
  }

  /* 连续的单行代码段落合并成一个代码块（中间允许空段落作为空行） */
  const lineGroups = []
  let j = 0
  while (j < blocks.length) {
    if (infos[j].kind !== 'codeLine') { j++; continue }
    let end = j
    const texts = []
    while (end < blocks.length) {
      const k = infos[end].kind
      if (k === 'codeLine') { texts.push(infos[end].lines.find((l) => l.trim()) || ''); end++; continue }
      if (k === 'skip' && blocks[end].type === 'paragraph' && !textOf(blocks[end]).trim()
          && end + 1 < blocks.length && infos[end + 1].kind === 'codeLine') {
        texts.push(''); end++; continue
      }
      break
    }
    lineGroups.push({ start: j, count: end - j, texts })
    j = end
  }
  // 已经被上面的 ops 覆盖的区域不参与合并
  for (const g of lineGroups) {
    if (ops.some((o) => g.start < o.start + o.count && o.start < g.start + g.count)) continue
    while (g.texts.length && !g.texts[g.texts.length - 1].trim()) g.texts.pop()
    if (!g.texts.length) continue
    ops.push({
      start: g.start, count: g.count,
      blocks: [{ type: 'codeBlock', text: g.texts.join('\n') }],
      reason: `合并${g.count}个单行代码段落`,
    })
  }
  ops.sort((a, b) => b.start - a.start)
  return ops
}

/* ---------------- scan ---------------- */

function loadDocs(tsv) {
  const byKey = new Map()
  for (const line of fs.readFileSync(tsv, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const [id, key, ws, parent, ...rest] = line.split('\t')
    byKey.set(key, { id: Number(id), title: rest.join('\t'), ws, parent })
  }
  return byKey
}

function loadJson(file) {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(file)))
  return { ydoc, json: yDocToProsemirrorJSON(ydoc, 'default') }
}

function scan(dataDir, tsv, outPlan) {
  const byKey = loadDocs(tsv)
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.bin'))
  const plan = { generatedAt: new Date().toISOString(), dataDir, docs: [], stats: {} }
  const kindCount = {}
  let convertedBlocks = 0, producedCodeBlocks = 0, preservedParagraphs = 0, readFail = 0

  for (const f of files) {
    const key = f.replace(/\.bin$/, '')
    let json
    try { json = loadJson(path.join(dataDir, f)).json } catch (e) { readFail++; console.error('READ_FAIL', f, e.message); continue }
    const blocks = json.content || []
    const infos = blocks.map(blockInfo)
    for (const x of infos) kindCount[x.kind] = (kindCount[x.kind] || 0) + 1
    const ops = buildOps(blocks)
    if (!ops.length) continue
    for (const o of ops) {
      convertedBlocks += o.count
      for (const b of o.blocks) b.type === 'codeBlock' ? producedCodeBlocks++ : preservedParagraphs++
    }
    const meta = byKey.get(key)
    plan.docs.push({
      file: f, docId: meta?.id ?? null, title: meta?.title ?? null,
      totalBlocks: blocks.length, ops,
      preview: ops.slice(0, 3).map((o) => ({
        reason: o.reason, start: o.start,
        before: blocks.slice(o.start, o.start + o.count).map((b) => `${b.type}: ${textOf(b).slice(0, 90)}`),
        after: o.blocks.map((b) => `${b.type}: ${b.text.slice(0, 160).replace(/\n/g, '⏎')}`),
      })),
    })
  }
  plan.stats = {
    files: files.length, readFail, docsChanged: plan.docs.length,
    docsMapped: plan.docs.filter((d) => d.docId).length,
    convertedBlocks, producedCodeBlocks, preservedParagraphs,
    blockKinds: kindCount,
  }
  fs.writeFileSync(outPlan, JSON.stringify(plan, null, 2))
  console.log('=== scan 结果 ===')
  console.log(JSON.stringify(plan.stats, null, 2))
  console.log('\n--- 前 12 篇预览 ---')
  plan.docs.slice(0, 12).forEach((d) => {
    console.log(`\n[${d.docId ?? '--'}] ${d.title || '(无映射)'} ${d.file.slice(0, 8)}  共 ${d.ops.length} 处`)
    d.preview.forEach((p) => {
      console.log(`  #${p.start} ${p.reason}`)
      console.log('    BEFORE ' + JSON.stringify(p.before).slice(0, 220))
      console.log('    AFTER  ' + JSON.stringify(p.after).slice(0, 260))
    })
  })

  // 误伤复核：所有「单行代码块」+ 前 20 个拆分结果
  const singles = [], mixeds = []
  for (const d of plan.docs) for (const o of d.ops) {
    for (const b of o.blocks) if (b.type === 'codeBlock' && !b.text.includes('\n')) singles.push(b.text)
    if (o.reason.includes('拆分') && mixeds.length < 20) mixeds.push({ doc: d.docId, title: d.title, blocks: o.blocks })
  }
  console.log(`\n--- 单行代码块 ${singles.length} 个（抽查误伤，前 60）---`)
  singles.slice(0, 60).forEach((t) => console.log('  | ' + JSON.stringify(t.slice(0, 150))))
  console.log('\n--- mixed 拆分样本 ---')
  mixeds.forEach((m) => {
    console.log(`  [${m.doc}] ${m.title}`)
    m.blocks.slice(0, 4).forEach((b) => console.log(`     ${b.type}: ${JSON.stringify(b.text.slice(0, 100))}`))
  })
}

/* ---------------- apply ---------------- */

function makeEl(type, text) {
  const el = new Y.XmlElement(type)
  el.insert(0, [new Y.XmlText(text)])
  return el
}

function apply(dataDir, planFile, outDir) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  fs.mkdirSync(outDir, { recursive: true })
  let ok = 0, fail = 0
  for (const d of plan.docs) {
    try {
      const { ydoc } = loadJson(path.join(dataDir, d.file))
      const frag = ydoc.getXmlFragment('default')
      ydoc.transact(() => {
        for (const o of d.ops) {
          frag.delete(o.start, o.count)
          frag.insert(o.start, o.blocks.map((b) => makeEl(b.type, b.text)))
        }
      })
      fs.writeFileSync(path.join(outDir, d.file), Buffer.from(Y.encodeStateAsUpdate(ydoc)))
      ok++
    } catch (e) { fail++; console.error('APPLY_FAIL', d.file, e.message) }
  }
  console.log(`apply 完成：成功 ${ok}，失败 ${fail}，输出 ${outDir}`)
}

/* ---------------- verify ---------------- */

/** 全文去空白后的字符序列：类型换了，字必须一个不少 */
function flatText(json) {
  return (json.content || [])
    .map(textOf)
    .join('\n')
    .replace(/[\s\u00a0\u3000]+/g, '')
}

function verify(dataDir, outDir, planFile) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  let ok = 0, bad = 0, codeBefore = 0, codeAfter = 0, nonCodeCodeLines = 0
  const problems = []
  for (const d of plan.docs) {
    const a = loadJson(path.join(dataDir, d.file)).json
    const b = loadJson(path.join(outDir, d.file)).json
    codeBefore += (a.content || []).filter((x) => x.type === 'codeBlock').length
    codeAfter += (b.content || []).filter((x) => x.type === 'codeBlock').length
    const ta = flatText(a), tb = flatText(b)
    if (ta === tb) ok++
    else {
      bad++
      problems.push({ file: d.file, docId: d.docId, lenBefore: ta.length, lenAfter: tb.length,
        firstDiff: (() => { let i = 0; while (i < Math.min(ta.length, tb.length) && ta[i] === tb[i]) i++; return { i, a: ta.slice(i, i + 60), b: tb.slice(i, i + 60) } })() })
    }
    // 残留：非 codeBlock 的块里还有多少「代码行」
    for (const blk of b.content || []) {
      if (blk.type === 'codeBlock' || !CONVERTIBLE.has(blk.type)) continue
      const info = blockInfo(blk)
      if (info.kind === 'codeBlock' || info.kind === 'mixed') nonCodeCodeLines++
    }
  }
  console.log('=== verify 结果 ===')
  console.log(`文本完全一致 ${ok} 篇，不一致 ${bad} 篇`)
  console.log(`codeBlock 数量 ${codeBefore} → ${codeAfter}（+${codeAfter - codeBefore}）`)
  console.log(`转换后仍疑似代码的非代码块 ${nonCodeCodeLines} 块`)
  if (problems.length) {
    console.log('\n--- 不一致明细（前 10）---')
    problems.slice(0, 10).forEach((p) => console.log(JSON.stringify(p)))
  }
  return bad === 0
}

/* ---------------- main ---------------- */

if (stage === 'scan') scan(process.argv[3], process.argv[4], process.argv[5])
else if (stage === 'apply') apply(process.argv[3], process.argv[4], process.argv[5])
else if (stage === 'verify') process.exit(verify(process.argv[3], process.argv[4], process.argv[5]) ? 0 : 1)
else console.error('用法: node codeblocks.mjs scan|apply|verify ...')

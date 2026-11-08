#!/usr/bin/env node
/**
 * 锁相关两篇文档的线上只读验收（doc 440 / 441）。
 *
 * 这两篇刚做过结构重排：标题重新分层、重复章节合并、代码块从原文逐字搬回。
 * 所以这里只验「重构之后有没有被搞坏」，不验内容对错：
 *   1. 标题层级是否连续（不允许跳级、不允许缺失编号）
 *   2. 编号是否由 HeadingNumber 派生（data-number 连续、不重复）
 *   3. 代码块有没有空壳、有没有残留占位符 / 转存失败字样
 *   4. 表格、图片是否还在
 *   5. 无 JS 报错
 *
 * 只读，不写任何数据；token 用完即弃。
 *
 * 用法：node lockdocs-check.mjs <jwtSecret> [baseUrl]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const [secret, baseArg] = process.argv.slice(2)
if (!secret) {
  console.error('用法: node lockdocs-check.mjs <jwtSecret> [baseUrl]')
  process.exit(1)
}

const BASE = baseArg || 'http://47.117.110.143/scofendoc/'
const DOCS = [
  { id: 440, name: '锁核心类AQS详解', minHeadings: 28, minCode: 34 },
  { id: 441, name: 'ReentrantLock和ReentrantReadWriteLock详解', minHeadings: 22, minCode: 26 },
]

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ ok, name, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,960'],
  defaultViewport: { width: 1440, height: 960 },
})

const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate(
  (t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem(
      'scofendoc.user',
      JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
    )
  },
  token,
)

for (const doc of DOCS) {
  console.log(`\n=== doc ${doc.id} ${doc.name} ===`)
  await page.goto(`${BASE}?doc=${doc.id}`, { waitUntil: 'networkidle2' })
  await page
    .waitForFunction(() => (document.querySelector('.ProseMirror')?.innerText || '').length > 500, { timeout: 30000 })
    .catch(() => {})
  await sleep(2500)

  const r = await page.evaluate(() => {
    const root = document.querySelector('.ProseMirror')
    if (!root) return null
    const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
      level: Number(h.tagName[1]),
      num: h.getAttribute('data-number') || '',
      text: h.innerText.trim(),
    }))
    const codes = [...root.querySelectorAll('pre')].map((p) => p.innerText || '')
    // 表格单元格里的行内代码也算，单独统计 blockquote / 图片
    const text = root.innerText
    const emptyCode = codes.filter((c) => c.trim().length === 0).length
    const tooShort = codes.filter((c) => c.trim().length > 0 && c.trim().length < 12).length
    return {
      heads,
      codeCount: codes.length,
      emptyCode,
      tooShort,
      tables: root.querySelectorAll('table').length,
      rows: root.querySelectorAll('table tr').length,
      imgs: root.querySelectorAll('img').length,
      brokenImgs: [...root.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth === 0).length,
      chars: text.length,
      hasPlaceholder: /@@[A-Z] /.test(text) || text.includes('AI代码解释') || text.includes('转存失败'),
      title: document.querySelector('.doc-title, .title-input')?.value || document.querySelector('.doc-title')?.innerText || '',
    }
  })

  if (!r) {
    check(`doc ${doc.id} 正文能渲染`, false)
    continue
  }

  check(`doc ${doc.id} 正文非空`, r.chars > 3000, `${r.chars} 字`)
  check(`doc ${doc.id} 标题数 ≥ ${doc.minHeadings}`, r.heads.length >= doc.minHeadings, String(r.heads.length))

  // 层级连续性：每个标题最多比前一个深一级
  const jumps = r.heads.filter((h, i) => i > 0 && h.level - r.heads[i - 1].level > 1)
  check(`doc ${doc.id} 标题层级不跳级`, jumps.length === 0, jumps.map((h) => `${h.level}:${h.text.slice(0, 12)}`).join(' | '))

  // 编号派生：全部有 data-number，且同级不重复
  const missing = r.heads.filter((h) => !h.num)
  check(`doc ${doc.id} 全部标题有派生编号`, missing.length === 0, `${r.heads.length - missing.length}/${r.heads.length}`)
  const dup = []
  const seen = new Set()
  for (const h of r.heads) {
    if (!h.num) continue
    if (seen.has(h.num)) dup.push(h.num)
    seen.add(h.num)
  }
  check(`doc ${doc.id} 编号无重复`, dup.length === 0, dup.slice(0, 6).join(','))

  // 顶层编号从 1 开始、连续
  const top = r.heads.filter((h) => h.level === Math.min(...r.heads.map((x) => x.level)))
  const expectTop = top.map((_, i) => `${i + 1}.`)
  check(
    `doc ${doc.id} 顶层编号 1..${top.length} 连续`,
    JSON.stringify(top.map((h) => h.num)) === JSON.stringify(expectTop),
    top.map((h) => h.num).join(' '),
  )

  check(`doc ${doc.id} 代码块数 ≥ ${doc.minCode}`, r.codeCount >= doc.minCode, String(r.codeCount))
  check(`doc ${doc.id} 代码块无空壳`, r.emptyCode === 0, `空 ${r.emptyCode} / 过短 ${r.tooShort}`)
  check(`doc ${doc.id} 无占位符与抓取残留`, !r.hasPlaceholder)
  check(`doc ${doc.id} 表格存在`, r.tables > 0, `${r.tables} 表 / ${r.rows} 行`)
  check(`doc ${doc.id} 图片全部加载`, r.imgs > 0 && r.brokenImgs === 0, `${r.imgs} 张，坏 ${r.brokenImgs}`)

  console.log(`  顶层：${top.map((h) => `${h.num}${h.text.slice(0, 10)}`).join(' / ')}`)
  const lv = r.heads.reduce((a, h) => ((a[h.level] = (a[h.level] || 0) + 1), a), {})
  console.log(`  层级分布：${Object.entries(lv).map(([k, v]) => `H${k}×${v}`).join(' ')}`)

  await page.screenshot({ path: `/tmp/lockdocs/doc-${doc.id}-top.png` })
  await page.evaluate(() => {
    const el = document.querySelector('.content') || document.querySelector('.ProseMirror')
    if (el) el.scrollTop = 6000
  })
  await sleep(700)
  await page.screenshot({ path: `/tmp/lockdocs/doc-${doc.id}-mid.png` })
}

check('无 JS 报错', errors.length === 0, [...new Set(errors)].slice(0, 3).join(' | '))

const pass = results.filter((r) => r.ok).length
console.log(`\n${pass}/${results.length} 通过`)
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)

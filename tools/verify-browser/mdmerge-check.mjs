#!/usr/bin/env node
/**
 * 三篇文档合并后的线上验收（只读）。
 *
 *   node mdmerge-check.mjs <jwtSecret>
 *
 * 检查项：协同连接状态、标题数、图片数与每张图是否真的加载成功（naturalWidth>0）、
 * 代码块数、正文字符数、以及页面报错。不改任何数据。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
if (!secret) {
  console.error('用法: node mdmerge-check.mjs <jwtSecret>')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '30m' },
)

const BASE = 'http://47.117.110.143/scofendoc/'
const DOCS = [
  { title: 'Java 基础 - JDK8-11-25新特性', heads: 31, imgs: 0, codes: 1, tables: 2, minChars: 6000 },
  { title: '关键字: synchronized详解', heads: 76, imgs: 23, codes: 37, tables: 2, minChars: 20000 },
  { title: 'MySQL - 索引(B+树)', heads: 46, imgs: 32, codes: 34, tables: 16, minChars: 20000 },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

// 三篇文档都在「团队空间」（space=2），直接带参进站，省掉手动切空间
await page.goto(BASE + '?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem(
    'scofendoc.user',
    JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
  )
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await sleep(2000)

for (const d of DOCS) {
  errors.length = 0
  // 目录是折叠树：先把所有层级展开，再按 .title 精确点中目标文档
  for (let pass = 0; pass < 6; pass++) {
    const n = await page.evaluate(() => {
      const closed = [...document.querySelectorAll('.tree-row .twist:not(.placeholder):not(.open)')]
      closed.forEach((t) => t.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      return closed.length
    })
    await sleep(400)
    if (n === 0) break
  }
  const clicked = await page.evaluate((kw) => {
    const title = [...document.querySelectorAll('.tree-row .title')].find(
      (n) => n.textContent.trim() === kw,
    )
    if (!title) return false
    const row = title.closest('.tree-row')
    row.scrollIntoView({ block: 'center' })
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }, d.title)
  await sleep(1200)
  // 等正文与协同首屏稳定
  await page.waitForFunction(() => {
    const r = document.querySelector('.ProseMirror')
    return r && r.innerText.length > 200
  }, { timeout: 30000 }).catch(() => {})
  await sleep(2500)

  // 图片是懒加载的，先把整篇滚一遍逼它们真正发出请求，再统计
  await page.evaluate(async () => {
    const el = document.querySelector('.content') || document.querySelector('.ProseMirror')?.parentElement
    const step = 800
    const max = (el?.scrollHeight || 0) + 2000
    for (let y = 0; y < max; y += step) {
      if (el) el.scrollTop = y
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 60))
    }
    if (el) el.scrollTop = 0
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, 1200))
  })
  await sleep(1500)

  const r = await page.evaluate(() => {
    const root = document.querySelector('.ProseMirror')
    const imgs = [...(root?.querySelectorAll('img') || [])]
    return {
      status: document.querySelector('.collab .status')?.textContent?.trim() || '',
      title: document.querySelector('.title-input, input[type="text"]')?.value || '',
      heads: root?.querySelectorAll('h1,h2,h3,h4,h5,h6').length || 0,
      h2: [...(root?.querySelectorAll('h2') || [])].map((h) => h.innerText.trim()),
      imgs: imgs.length,
      broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
      codes: root?.querySelectorAll('pre').length || 0,
      tables: root?.querySelectorAll('table').length || 0,
      chars: root?.innerText.length || 0,
      firstText: root?.innerText.slice(0, 80).replace(/\n/g, ' ') || '',
      lastText: root?.innerText.slice(-80).replace(/\n/g, ' ') || '',
    }
  })

  console.log(`\n=== ${d.title} ===`)
  check('点开了目标文档', clicked)
  check('标题与文档一致', r.title.includes(d.title.slice(0, 6)), r.title)
  check('协同已连接', /已连接|在线|同步/.test(r.status) || r.status === '', r.status)
  check(`标题数 = ${d.heads}`, r.heads === d.heads, `实际 ${r.heads}`)
  check(`图片数 = ${d.imgs}`, r.imgs === d.imgs, `实际 ${r.imgs}`)
  check('图片全部加载成功', r.broken.length === 0, r.broken.slice(0, 3).join(' '))
  check(`代码块数 = ${d.codes}`, r.codes === d.codes, `实际 ${r.codes}`)
  check(`表格数 = ${d.tables}`, r.tables === d.tables, `实际 ${r.tables}`)
  check(`正文 ≥ ${d.minChars} 字`, r.chars >= d.minChars, `实际 ${r.chars}`)
  check('页面无报错', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160))
  console.log('  h2:', r.h2.join(' / ').slice(0, 300))
  console.log('  开头:', r.firstText)
  console.log('  结尾:', r.lastText)
}

await browser.close()
const bad = out.filter((x) => !x).length
console.log(`\n${out.length - bad}/${out.length} 通过`)
process.exit(bad ? 1 : 0)

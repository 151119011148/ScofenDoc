#!/usr/bin/env node
/**
 * 站内跳转验收（只读，不改数据）
 *
 * 验三件事：
 *   1. 正文里的互引是否真的渲染成 <a>（而不是又变回纯文字）
 *   2. 点普通文档链接，是否在站内切到目标文档（URL、标题、正文都变）
 *   3. 点带锚点的分组链接，是否切过去并滚到对应段落
 *
 * 用法: node verify-jumps.mjs <jwtSecret> <userId> [outDir]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const [secret, userId, outDir = '/tmp/jumps'] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '30m' },
)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const BASE = 'http://47.117.110.143/scofendoc/'
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)

await page.goto(`${BASE}?space=2&doc=19`, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror a[href*="doc="]').length > 5, { timeout: 40000 })
await new Promise((r) => setTimeout(r, 800))

const summary = await page.evaluate(() => {
  const links = [...document.querySelectorAll('.ProseMirror a')]
  const inner = links.filter((a) => (a.getAttribute('href') || '').includes('doc='))
  const withAnchor = inner.filter((a) => (a.getAttribute('href') || '').includes('&h='))
  const external = links.filter((a) => /^https?:/.test(a.getAttribute('href') || ''))
  const sample = inner.slice(0, 5).map((a) => ({ text: a.textContent.trim().slice(0, 20), href: a.getAttribute('href') }))
  const style = inner[0] ? getComputedStyle(inner[0]) : null
  return {
    total: links.length,
    inner: inner.length,
    withAnchor: withAnchor.length,
    external: external.length,
    sample,
    color: style?.color,
    underline: style?.borderBottomStyle,
  }
})
console.log('链接渲染：总 %d，站内 %d（其中带锚点 %d），外链 %d', summary.total, summary.inner, summary.withAnchor, summary.external)
console.log('样式    ：color=%s  border-bottom=%s', summary.color, summary.underline)
summary.sample.forEach((s) => console.log('  例  %s → %s', s.text, s.href))
await page.screenshot({ path: `${outDir}-1-index.png` })

/* ---------- 1. 点普通文档链接：应切到 1.1 导览 ---------- */
const beforeTitle = await page.$eval('.title-input', (el) => el.value)
await page.evaluate(() => {
  const a = document.querySelector('.ProseMirror a[href*="doc=20"]:not([href*="&h="])')
  a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
await page.waitForFunction(() => document.querySelector('.title-input')?.value.includes('1.1-Java基础-章节导览'), { timeout: 20000 })
await new Promise((r) => setTimeout(r, 900))
const afterFirst = await page.evaluate(() => ({
  title: document.querySelector('.title-input')?.value,
  url: location.search,
  h2: document.querySelector('.ProseMirror h2')?.textContent?.slice(0, 24),
  links: document.querySelectorAll('.ProseMirror a[href*="doc="]').length,
}))
console.log('\n[1] 点「%s」里的文档链接', beforeTitle)
console.log('    → 标题 %s  URL %s  首个小标题「%s」  站内链接 %d', afterFirst.title, afterFirst.url, afterFirst.h2, afterFirst.links)
await page.screenshot({ path: `${outDir}-2-doc.png` })

/* ---------- 2. 回总索引，点带锚点的分组链接：应滚到对应段 ---------- */
await page.goto(`${BASE}?space=2&doc=19`, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror a[href*="&h="]').length > 5, { timeout: 40000 })
await new Promise((r) => setTimeout(r, 800))
const clicked = await page.evaluate(() => {
  const a = [...document.querySelectorAll('.ProseMirror a')].find((x) => (x.getAttribute('href') || '').includes('doc=20&h='))
  const label = a?.textContent?.trim()
  const href = a?.getAttribute('href')
  const before = document.querySelector('.main')?.scrollTop || 0
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return { label, href, before }
})

// 图/表格渲染会改变高度，等待二次对齐窗口走完再量落点
await new Promise((r) => setTimeout(r, 900))
const hitEarly = await page.evaluate(() => !!document.querySelector('.ProseMirror .anchor-hit'))
await new Promise((r) => setTimeout(r, 2900))
const landed = await page.evaluate((label) => {
  const norm = (s) =>
    s
      .replace(/^g-/, '')
      .replace(/[\s\u00a0]/g, '')
      .replace(/[·：:，,。.、；;！!？?（）()【】\[\]「」“”"'’‘—\-_/\\|*`~#]/g, '')
  const want = norm(label || '')
  const scroller = document.querySelector('.main')
  const nodes = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3')]
  const target = nodes.find((n) => norm(n.textContent || '') === want) ?? nodes.find((n) => norm(n.textContent || '').includes(want))
  return {
    title: document.querySelector('.title-input')?.value,
    url: location.search,
    scrollTop: Math.round(scroller?.scrollTop || 0),
    offset: target ? Math.round(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null,
    text: target ? target.textContent.trim().slice(0, 24) : null,
    hit: !!document.querySelector('.anchor-hit'),
  }
}, clicked.label)
console.log('\n[2] 点分组锚点「%s」 %s', clicked.label, clicked.href)
console.log('    → 文档 %s  URL %s', landed.title, landed.url)
console.log(
  '    → 滚动到 %d，落点「%s」距顶部 %s px；高亮：0.9s %s / 3.8s %s',
  landed.scrollTop,
  landed.text,
  landed.offset,
  hitEarly ? '有' : '无',
  landed.hit ? '有' : '无',
)
await page.screenshot({ path: `${outDir}-3-anchor.png` })

console.log('\n页面错误：', errors.length ? errors : '无')
await browser.close()

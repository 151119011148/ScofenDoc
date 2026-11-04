#!/usr/bin/env node
/**
 * 手机端大纲面板体检（只读）：390x844 触摸视口下验证
 *   1) 顶栏有「目录」按钮
 *   2) 点开面板：贴底、高度≈min(64vh,520)、条目可见
 *   3) 点条目：正文滚到该标题（落点≈12px），面板自动收起
 *   4) 点遮罩：收起
 *
 * 用法: node outline-mobile-check.mjs <jwtSecret> <userId> [docTitle] [outDir]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, docTitle = '6.1-agent开发', outDir = '/tmp/m-outline'] = process.argv.slice(2)
if (!secret || !userId) {
  console.error('usage: node outline-mobile-check.mjs <jwtSecret> <userId> [docTitle] [outDir]')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)
fs.mkdirSync(outDir, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
page.on('pageerror', (e) => console.log('PAGE_ERR:', String(e).slice(0, 300)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto('http://47.117.110.143/scofendoc/?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem(
    'scofendoc.user',
    JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
  )
}, token)
await page.reload({ waitUntil: 'networkidle2' })

// 手机上先开抽屉选文档
await page.waitForFunction(() => document.querySelectorAll('.m-menu').length > 0, { timeout: 20000 })
await page.click('.m-menu')
await wait(500)
await page.waitForFunction(
  (title) => [...document.querySelectorAll('.tree-row')].some((n) => n.textContent.includes(title)),
  { timeout: 20000 },
  docTitle,
)
await page.evaluate((title) => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes(title))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, docTitle)
await page.waitForFunction(
  () => document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3').length > 0,
  { timeout: 30000 },
)
await wait(1200)

const result = {}

// 1) 顶栏目录按钮
result.topbarButton = await page.evaluate(() => {
  const b = document.querySelector('.m-outline')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { text: b.textContent.trim(), visible: r.width > 0, x: Math.round(r.x) }
})

// 2) 打开面板
await page.click('.m-outline')
await wait(500)
result.opened = await page.evaluate(() => {
  const el = document.querySelector('.outline-col')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    visible: cs.visibility,
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    height: Math.round(r.height),
    width: Math.round(r.width),
    items: el.querySelectorAll('.outline-item').length,
    firstItemHeight: Math.round(el.querySelector('.outline-item')?.getBoundingClientRect().height ?? 0),
    overflowX: document.documentElement.scrollWidth > 390 + 1,
    mask: !!document.querySelector('.outline-mask'),
  }
})
await page.screenshot({ path: `${outDir}/m-outline-open.png` })

// 3) 点第 4 个条目
await page.evaluate(() => {
  document.querySelectorAll('.outline-item')[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
// 平滑滚动时长跟距离有关：手机上从顶部滚到底可能超 1s，等 scrollTop 连续两帧稳定再测
await page.waitForFunction(
  () => {
    const main = document.querySelector('.main')
    if (!main) return false
    const now = Math.round(main.scrollTop)
    const prev = window.__lastTop
    window.__lastTop = now
    return prev === now
  },
  { polling: 200, timeout: 8000 },
).catch(() => {})
await wait(300)
result.afterJump = await page.evaluate(() => {
  const el = document.querySelector('.outline-col')
  const main = document.querySelector('.main')
  const bar = document.querySelector('.collab .bar')
  const active = document.querySelector('.outline-item.on')
  const h = active
    ? [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3')].find(
        (x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === (active.textContent || '').replace(/\s+/g, ' ').trim(),
      )
    : null
  return {
    panelVisibility: el ? getComputedStyle(el).visibility : 'missing',
    panelTop: el ? Math.round(el.getBoundingClientRect().top) : null,
    scrollTop: main ? Math.round(main.scrollTop) : -1,
    headingTopInView: h && main ? Math.round(h.getBoundingClientRect().top - main.getBoundingClientRect().top) : null,
    headingTopAbs: h ? Math.round(h.getBoundingClientRect().top) : null,
    barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
    // 标题整体要落在吸顶工具栏下方，否则第一行会被压住
    headingClearOfBar: h && bar ? h.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom - 1 : null,
    activeText: (active?.textContent || '').trim().slice(0, 16),
    maskLeft: !!document.querySelector('.outline-mask'),
  }
})
await page.screenshot({ path: `${outDir}/m-outline-jumped.png` })

// 4) 再开一次，点遮罩收起
await page.click('.m-outline')
await wait(500)
await page.click('.outline-mask')
await wait(500)
result.afterMask = await page.evaluate(() => {
  const el = document.querySelector('.outline-col')
  return {
    panelVisibility: el ? getComputedStyle(el).visibility : 'missing',
    maskLeft: !!document.querySelector('.outline-mask'),
  }
})

console.log(JSON.stringify(result, null, 2))

const ok =
  !!result.topbarButton?.visible &&
  result.opened?.visible === 'visible' &&
  Math.abs(result.opened.bottom - 844) <= 2 &&
  result.opened.items > 0 &&
  result.afterJump.panelVisibility === 'hidden' &&
  result.afterJump.headingClearOfBar === true &&
  result.afterMask.panelVisibility === 'hidden' &&
  !result.afterMask.maskLeft &&
  !result.opened.overflowX

console.log(ok ? '\n✅ PASS 手机端大纲可唤起、可跳转、可收起' : '\n❌ FAIL 见上面各项数值')
await browser.close()
process.exit(ok ? 0 : 1)

#!/usr/bin/env node
/**
 * 移动端适配体检（只读）
 * 用法: node mobile-check.mjs <jwtSecret> <userId> [outDir]
 *
 * 用 iPhone 尺寸（390x844, DPR2, 触摸）打开线上页面，走一遍：
 *   首页 → 唤起抽屉 → 打开第六章文档 → 正文滚动 → 斜杠菜单
 * 每一步截图，并把「有没有横向溢出 / 抽屉有没有正常收起」这些量出来。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, outDir = '/tmp/mobile-shots'] = process.argv.slice(2)
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
// iPhone 14 左右的尺寸
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

const shot = async (name) => {
  const p = `${outDir}/${name}.png`
  await page.screenshot({ path: p })
  console.log('shot', p)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto('http://47.117.110.143/scofendoc/?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await wait(1200)
await shot('01-home')

/** 横向溢出体检：整页 + 正文容器 + 主要块 */
const overflowProbe = () =>
  page.evaluate(() => {
    const doc = document.documentElement
    const wide = [...document.querySelectorAll('.ProseMirror *')]
      .map((el) => ({ tag: el.tagName, cls: el.className?.toString?.() || '', w: el.scrollWidth, box: el.getBoundingClientRect().width }))
      .filter((x) => x.w > window.innerWidth + 2)
    return {
      viewport: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
      offenders: wide.slice(0, 5),
    }
  })

// 抽屉（等滑入动画走完再量，否则量到的是动画中途的位置）
await page.click('.m-menu')
await wait(900)
const drawerOpen = await page.evaluate(() => {
  const rail = document.querySelector('.nav-rail')
  const r = rail?.getBoundingClientRect()
  return { visible: !!r && r.left >= -1 && r.width > 100, width: r?.width || 0 }
})
await shot('02-drawer')

// 点树里的 6.1 文档
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes('6.1-agent开发'))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror').length > 0, { timeout: 30000 })
await wait(2500)

const afterOpen = await page.evaluate(() => {
  const rail = document.querySelector('.nav-rail')
  return {
    drawerClosed: !document.querySelector('.nav-mask'),
    railLeft: Math.round(rail?.getBoundingClientRect().left ?? 0),
    topbarTitle: document.querySelector('.m-title')?.textContent?.trim() || '',
    hasTopbar: !!document.querySelector('.m-topbar') && getComputedStyle(document.querySelector('.m-topbar')).display !== 'none',
  }
})
console.log('drawerOpen=', JSON.stringify(drawerOpen))
console.log('afterOpen=', JSON.stringify(afterOpen))
console.log('overflow@doc=', JSON.stringify(await overflowProbe()))
await shot('03-doc')

// 正文往下滚
await page.evaluate(() => {
  const main = document.querySelector('.main')
  if (main) main.scrollTop = 1400
})
await wait(700)
await shot('04-doc-scroll')
console.log('overflow@scroll=', JSON.stringify(await overflowProbe()))

// 斜杠菜单 → 底部半屏面板
// 注意：这里绝不能往编辑器里真的敲 "/"，那是线上协作文档，会写进正文。
// 改为注入一个同结构的哑节点，只验样式与位置。
await page.evaluate(() => {
  const el = document.createElement('div')
  el.className = 'slash-menu'
  el.id = 'slash-stub'
  el.innerHTML =
    '<div class="slash-head">插入区块</div>' +
    '<div class="slash-list"><button class="slash-item"><span class="slash-text"><b>一级标题</b><i>大标题</i></span></button></div>' +
    '<div class="slash-foot">↑↓ 选择 · Enter 确认</div>'
  document.body.appendChild(el)
})
await wait(300)
const slash = await page.evaluate(() => {
  const el = document.querySelector('.slash-menu')
  if (!el) return { open: false }
  const r = el.getBoundingClientRect()
  return {
    open: true,
    left: Math.round(r.left),
    right: Math.round(window.innerWidth - r.right),
    bottom: Math.round(window.innerHeight - r.bottom),
    width: Math.round(r.width),
    coversViewport: r.left <= 10 && window.innerWidth - r.right <= 10,
  }
})
console.log('slashMenu=', JSON.stringify(slash))
await shot('05-slash')

await browser.close()

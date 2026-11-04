#!/usr/bin/env node
/**
 * 行内 ＋ 的悬停显隐回归（只读，不往正文写内容）：
 * 1) 初始（鼠标没动过）→ ＋ 不显示
 * 2) 鼠标移到某一行 → ＋ 出现在该行左侧
 * 3) 鼠标移到另一个块 → ＋ 跟过去（纵向位置变化）
 * 4) 鼠标离开正文（挪到左侧导航）→ ＋ 收起
 * 5) 再移回来 → ＋ 重新出现
 * 6) 悬停 ＋ → 弹菜单且 ＋ 保留
 * 用法: node plus-hover-check.mjs <jwtSecret> <userId> [docTitle] [outDir]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, docTitle = '6.1-agent开发', outDir = '/tmp/plus-shots'] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)
fs.mkdirSync(outDir, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })

await page.goto('http://47.117.110.143/scofendoc/?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await wait(1200)
await page.evaluate((title) => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes(title))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, docTitle)
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror').length > 0, { timeout: 30000 })
await wait(2200)

const stat = () =>
  page.evaluate(() => {
    const dot = document.querySelector('.plus-dot')
    const menu = document.querySelector('.slash-menu')
    if (!dot) return { visible: false, menu: !!menu }
    const r = dot.getBoundingClientRect()
    return {
      visible: getComputedStyle(dot).display !== 'none',
      left: Math.round(r.left),
      top: Math.round(r.top),
      on: dot.classList.contains('on'),
      menu: menu ? { left: Math.round(menu.getBoundingClientRect().left), top: Math.round(menu.getBoundingClientRect().top) } : null,
    }
  })

/** 收集「完整落在视口内」的顶层块取样点（靠左取点，避免落进图片/链接正中） */

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

/* 1. 初始 */
const s0 = await stat()
check('初始未悬停 → 不显示', !s0.visible, JSON.stringify(s0))

/* 2. 移到视口内第 1 个块 */
const list = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror > *')]
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 30), y: Math.round(r.top + Math.min(r.height / 2, 12)), top: Math.round(r.top), bottom: Math.round(r.bottom), tag: el.tagName }
    })
    .filter((b) => b.bottom - b.top > 8 && b.top > 140 && b.bottom < window.innerHeight - 30),
)
if (list.length < 2) throw new Error(`视口内可用块太少：${list.length}`)
const p1 = list[0]
const p2 = list[list.length - 1]
await page.mouse.move(p1.x, p1.y, { steps: 6 })
await wait(250)
const s1 = await stat()
check('悬停正文 → 出现', s1.visible === true, `<${p1.tag}> (${p1.x},${p1.y}) / dot ${JSON.stringify(s1)}`)
await page.screenshot({ path: `${outDir}/hover-line.png` })

/* 3. 移到靠后的块，＋ 应跟过去 */
await page.mouse.move(p2.x, p2.y, { steps: 8 })
await wait(250)
const s2 = await stat()
check(
  '换行 → ＋ 跟随',
  s2.visible === true && Math.abs(s2.top - s1.top) > 20,
  `<${p2.tag}> y=${p2.y}（共 ${list.length} 块）/ dot top ${s1.top} → ${s2.top}`,
)

/* 4. 离开正文（挪到左侧nav） */
await page.mouse.move(60, 600, { steps: 10 })
await wait(400)
const s3 = await stat()
check('离开正文 → 收起', !s3.visible, JSON.stringify(s3))
await page.screenshot({ path: `${outDir}/hover-left.png` })

/* 5. 再移回来 */
await page.mouse.move(p2.x, p2.y, { steps: 8 })
await wait(250)
const s4 = await stat()
check('再移回 → 重新出现', s4.visible === true, JSON.stringify(s4))

/* 6. 悬停 ＋ 本体 */
await page.mouse.move(s4.left + 10, s4.top + 10, { steps: 6 })
await wait(400)
const s5 = await stat()
check('悬停＋ → 弹菜单且＋保留', s5.visible === true && s5.on === true && !!s5.menu, JSON.stringify(s5))
await page.screenshot({ path: `${outDir}/hover-plus.png` })

/* 7. 菜单开着离开 → 菜单与 ＋ 一起收 */
await page.mouse.move(60, 600, { steps: 10 })
await wait(450)
const s6 = await stat()
check('菜单开着离开 → 一起收起', !s6.visible && !s6.menu, JSON.stringify(s6))

const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} 项未通过` : '\n全部通过')
await browser.close()
process.exit(bad.length ? 1 : 0)

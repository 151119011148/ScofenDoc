#!/usr/bin/env node
/**
 * 行内 ＋ 与光标绑定（只读，不往正文写内容）：
 * 1) 光标在某块，鼠标也在该块 → 显示，且贴在光标那一行
 * 2) 鼠标移到别的块（光标没动）→ 不显示   ← 本次需求的判据
 * 3) 鼠标移回光标所在块 → 再出现
 * 4) 鼠标离开正文 → 收起
 * 5) 悬停 ＋ → 弹菜单且 ＋ 保留
 * 用法: node plus-anchor-check.mjs <jwtSecret> <userId> [docTitle] [outDir]
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

/** 视口内可点到的顶层块（含 rect，方便判断「这一块 / 别的块」） */
const blocks = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror > *')]
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 40), y: Math.round(r.top + Math.min(r.height / 2, 10)), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), tag: el.tagName }
    })
    .filter((b) => b.h > 16 && b.top > 150 && b.bottom < 860),
)
if (blocks.length < 2) throw new Error(`视口内块太少：${blocks.length}`)
const anchorBlk = blocks[0]
const otherBlk = blocks[blocks.length - 1]

const stat = () =>
  page.evaluate(() => {
    const dot = document.querySelector('.plus-dot')
    if (!dot) return { visible: false, menu: !!document.querySelector('.slash-menu') }
    const r = dot.getBoundingClientRect()
    return {
      visible: getComputedStyle(dot).display !== 'none',
      top: Math.round(r.top),
      left: Math.round(r.left),
      on: dot.classList.contains('on'),
      menu: !!document.querySelector('.slash-menu'),
    }
  })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

/* 光标点进第 1 块 */
await page.mouse.click(anchorBlk.x, anchorBlk.y)
await wait(300)
const caret = await page.evaluate(() => {
  const d = document.querySelector('.plus-dot')
  return d ? { top: Math.round(d.getBoundingClientRect().top) } : null
})
console.log(`光标块 <${anchorBlk.tag}> top=${anchorBlk.top} .. ${anchorBlk.bottom}；另一块 <${otherBlk.tag}> top=${otherBlk.top}`)

/* 鼠标停到光标块上 */
await page.mouse.move(anchorBlk.x, anchorBlk.y, { steps: 6 })
await wait(250)
const s1 = await stat()
check('鼠标在光标所在块 → 显示', s1.visible === true, JSON.stringify(s1))
const inBlock = s1.visible && s1.top >= anchorBlk.top - 4 && s1.top <= anchorBlk.bottom
check('＋ 贴在光标块内', inBlock, `dot top ${s1.top} / 块 ${anchorBlk.top}..${anchorBlk.bottom}`)
await page.screenshot({ path: `${outDir}/anchor-on.png` })

/* 鼠标移到别的块（光标不动）→ 必须不显示 */
await page.mouse.move(otherBlk.x, otherBlk.y, { steps: 8 })
await wait(400)
const s2 = await stat()
check('鼠标在别的块 → 不显示', !s2.visible, `鼠标 y=${otherBlk.y} / ${JSON.stringify(s2)}`)
await page.screenshot({ path: `${outDir}/anchor-off.png` })

/* 移回光标块 → 再出现 */
await page.mouse.move(anchorBlk.x, anchorBlk.y, { steps: 8 })
await wait(250)
const s3 = await stat()
check('移回光标块 → 再显示', s3.visible === true, JSON.stringify(s3))

/* 悬停 ＋ */
await page.mouse.move(s3.left + 10, s3.top + 10, { steps: 6 })
await wait(400)
const s4 = await stat()
check('悬停 ＋ → 弹菜单且 ＋ 保留', s4.visible === true && s4.on === true && s4.menu, JSON.stringify(s4))
await page.screenshot({ path: `${outDir}/anchor-menu.png` })

/* 离开正文 */
await page.mouse.move(60, 600, { steps: 10 })
await wait(450)
const s5 = await stat()
check('离开正文 → 收起', !s5.visible && !s5.menu, JSON.stringify(s5))

const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} 项未通过` : '\n全部通过')
await browser.close()
process.exit(bad.length ? 1 : 0)

#!/usr/bin/env node
/**
 * 行内 ＋ 按钮回归（只读，不往正文写任何内容）：
 * 1) 悬停 ＋ → 块菜单弹出，且 ＋ 仍然可见、不被菜单盖住
 * 2) 鼠标从 ＋ 移到菜单里 → ＋ 依旧保留
 * 3) Esc 关闭菜单 → ＋ 回到普通态，仍然可见
 * 用法: node plus-check.mjs <jwtSecret> <userId> <docTitle> [outDir]
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

/* 把光标放进正文第一个段落，让 ＋ 定位到该块左侧 */
const blockBox = await page.evaluate(() => {
  const p = document.querySelector('.ProseMirror p')
  if (!p) return null
  const r = p.getBoundingClientRect()
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
})
if (!blockBox) throw new Error('正文里没有段落节点')
await page.mouse.click(blockBox.x, blockBox.y)
await wait(600)

const stat = () =>
  page.evaluate(() => {
    const dot = document.querySelector('.plus-dot')
    const menu = document.querySelector('.slash-menu')
    if (!dot) return { dot: null, menu: !!menu }
    const r = dot.getBoundingClientRect()
    const cs = getComputedStyle(dot)
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      dot: {
        left: Math.round(r.left),
        top: Math.round(r.top),
        w: Math.round(r.width),
        display: cs.display,
        opacity: cs.opacity,
        visibility: cs.visibility,
        zIndex: cs.zIndex,
        on: dot.classList.contains('on'),
        ariaExpanded: dot.getAttribute('aria-expanded'),
        covered: !(hit === dot || dot.contains(hit)),
        hitTag: hit ? hit.className || hit.tagName : 'none',
      },
      menu: menu ? { left: Math.round(menu.getBoundingClientRect().left), top: Math.round(menu.getBoundingClientRect().top) } : null,
    }
  })

const before = await stat()
console.log('1. 悬停前      ', JSON.stringify(before))

/* 悬停 ＋ */
const dotCenter = await page.evaluate(() => {
  const r = document.querySelector('.plus-dot').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
await page.mouse.move(dotCenter.x, dotCenter.y)
await wait(500)
const hovered = await stat()
console.log('2. 悬停 ＋ 后  ', JSON.stringify(hovered))
await page.screenshot({ path: `${outDir}/plus-hover.png` })

/* 移进菜单（模拟用户去点功能项），＋ 应继续保留 */
const menuCenter = await page.evaluate(() => {
  const r = document.querySelector('.slash-menu')?.getBoundingClientRect()
  return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) } : null
})
let inMenu = null
if (menuCenter) {
  await page.mouse.move(menuCenter.x, menuCenter.y, { steps: 8 })
  await wait(400)
  inMenu = await stat()
  console.log('3. 移入菜单    ', JSON.stringify(inMenu))
  await page.screenshot({ path: `${outDir}/plus-menu-hover.png` })
}

/* Esc 关闭 */
await page.keyboard.press('Escape')
await wait(300)
const closed = await stat()
console.log('4. Esc 关闭后  ', JSON.stringify(closed))
await page.screenshot({ path: `${outDir}/plus-closed.png` })

const ok =
  !!hovered.dot &&
  hovered.dot.display !== 'none' &&
  Number(hovered.dot.opacity) > 0.9 &&
  !hovered.dot.covered &&
  !!hovered.menu &&
  hovered.dot.on === true &&
  (!inMenu || (!!inMenu.dot && !inMenu.dot.covered)) &&
  !!closed.dot &&
  !closed.menu

console.log(ok ? '\nPASS 悬停弹出菜单时 ＋ 保持可见' : '\nFAIL 见上面快照')
await browser.close()
process.exit(ok ? 0 : 1)

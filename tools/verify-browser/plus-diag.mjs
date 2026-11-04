#!/usr/bin/env node
/**
 * 诊断：沿正文纵向扫一遍鼠标位置，看 ＋ 在哪些 y 上不出现、出现在哪。
 * 用法: node plus-diag.mjs <jwtSecret> <userId> [docTitle] [outDir]
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
page.on('console', (m) => {
  const t = m.text()
  if (t.startsWith('[plus]')) console.log('  console>', t)
})
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

/** 先把光标点在一个地方（制造「鼠标与光标不在一处」的前提） */
const caret = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.ProseMirror > *')]
  const el = blocks[0]
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 80), y: Math.round(r.top + 10) }
})
await page.mouse.click(caret.x, caret.y)
await wait(300)
console.log('光标点:', caret)

const geom = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const r = pm.getBoundingClientRect()
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }
})
console.log('正文盒:', geom)

/**
 * 逐屏扫描：每屏沿纵向扫 20 个点，统计「正文内但 ＋ 没出现」的情况。
 * 光标本就停在文档顶部（第一屏点时点的），所以后面几屏天然是「鼠标与光标不在一处」。
 */
const scroller = await page.evaluateHandle(() => document.querySelector('.content-scroll') || document.scrollingElement)
const rows = []
for (let screen = 0; screen < 6; screen++) {
  if (screen > 0) {
    await page.evaluate((el) => el.scrollBy(0, 760), scroller)
    await wait(500)
  }
  const box = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror').getBoundingClientRect()
    return { top: Math.max(pm.top, 150), bottom: Math.min(pm.bottom, 870) }
  })
  for (let y = Math.round(box.top + 6); y < box.bottom - 6; y += 36) {
    const x = geom.left + 40
    await page.mouse.move(x, y)
    await wait(60)
    const r = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y)
        const dot = document.querySelector('.plus-dot')
        const dr = dot ? dot.getBoundingClientRect() : null
        return {
          el: el ? el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') : 'null',
          inPM: !!(el && el.closest('.ProseMirror')),
          dot: dr ? { top: Math.round(dr.top), left: Math.round(dr.left), h: Math.round(dr.height) } : null,
        }
      },
      [x, y],
    )
    rows.push({ screen, y, ...r })
    // 图块上单独留一张图，肉眼确认 ＋ 真的贴在图块左边
    if (r.el.includes('mermaid-block') && !fs.existsSync(`${outDir}/diag-mermaid.png`)) {
      await page.screenshot({ path: `${outDir}/diag-mermaid.png` })
    }
  }
}

const miss = rows.filter((r) => r.inPM && !r.dot)
const off = rows.filter((r) => r.dot && (r.dot.left < 0 || r.dot.top < 0 || r.dot.top > 900))
console.log(`\n扫描 ${rows.length} 个点（6 屏），正文内但 ＋ 未出现：${miss.length}，跑到屏幕外：${off.length}`)
for (const m of miss) console.log(`  [屏${m.screen}] y=${m.y} el=${m.el}`)
for (const m of off) console.log(`  [屏${m.screen}] y=${m.y} el=${m.el} dot=${JSON.stringify(m.dot)}`)

/** 复现用户描述：光标在 A，鼠标移到远处 B */
const far = rows.filter((r) => r.dot && r.screen === 3)[0]
if (far) {
  await page.mouse.move(geom.left + 40, far.y, { steps: 5 })
  await wait(200)
  const s1 = await page.evaluate(() => {
    const d = document.querySelector('.plus-dot')
    return d ? Math.round(d.getBoundingClientRect().top) : null
  })
  console.log(`\n光标在 ${caret.y}（第 1 屏），鼠标在第 4 屏 y=${far.y} → ＋ top=${s1}`)
}
await page.screenshot({ path: `${outDir}/diag.png` })
await browser.close()

#!/usr/bin/env node
/**
 * 行内 ＋ 与光标绑定（只读，不往正文写内容）
 * 判据：
 *  1) 点击某段 → ＋ 出现在该段
 *  2) 同段内横向移动 → 保持
 *  3) 键盘把光标移到另一段 → ＋ 跟到新段（鼠标没动也要跟）
 *  4) 鼠标移到非光标段落 → 收起
 *  5) 鼠标离开正文 → 收起
 *  6) 点击另一段 → ＋ 到新段
 * 用法: node plus-caret-check.mjs <jwtSecret> <userId> [docTitle] [outDir]
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

const textBlocks = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror > *')]
    .map((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left + 60),
        y: Math.round(r.top + Math.min(r.height / 2, 10)),
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        h: Math.round(r.height),
        tag: el.tagName,
        text: (el.textContent || '').slice(0, 16),
      }
    })
    .filter(
      (b) =>
        ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE'].includes(b.tag) &&
        b.h > 16 &&
        b.top > 150 &&
        b.top < 780,
    ),
)
if (textBlocks.length < 3) throw new Error(`视口内文字块太少：${textBlocks.length}`)

const stat = () =>
  page.evaluate(() => {
    const dot = document.querySelector('.plus-dot')
    if (!dot) return { visible: false }
    const r = dot.getBoundingClientRect()
    return { visible: getComputedStyle(dot).display !== 'none', top: Math.round(r.top), left: Math.round(r.left) }
  })

/** 当前光标所在顶层块的几何 */
const caretBlock = () =>
  page.evaluate(() => {
    const s = window.getSelection()
    if (!s || !s.rangeCount) return null
    const n = s.getRangeAt(0).startContainer
    const el = n.nodeType === 3 ? n.parentElement : n
    const blk = el?.closest('.ProseMirror > *')
    if (!blk) return null
    const r = blk.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), tag: blk.tagName, text: (blk.textContent || '').slice(0, 16) }
  })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

const A = textBlocks[textBlocks.length - 1]
const B = textBlocks[0]
const C = textBlocks[Math.max(0, textBlocks.length - 3)]

/* 1) 点 A 段 */
await page.mouse.click(A.x, A.y)
await wait(320)
await page.mouse.move(A.x, A.y, { steps: 5 })
await wait(280)
const s1 = await stat()
const cb1 = await caretBlock()
check('点击后 ＋ 出现', s1.visible === true, JSON.stringify(s1))
check(
  '＋ 在光标所在段落',
  s1.visible === true && s1.top >= cb1.top - 6 && s1.top <= cb1.bottom,
  `dot ${s1.top} / 光标段 ${cb1.top}..${cb1.bottom} <${cb1.tag}>「${cb1.text}」`,
)

/* 2) 同段内横向移动 → 保持 */
await page.mouse.move(A.right - 30, A.y, { steps: 6 })
await wait(300)
const s2 = await stat()
check('同段内横向移动 → 保持', s2.visible === true, JSON.stringify(s2))

/* 3) 键盘换段：鼠标没动，＋ 也要跟到新段落 */
let cb2 = cb1
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('ArrowDown')
  await wait(320)
  cb2 = await caretBlock()
  if (cb2 && cb2.top !== cb1.top) break
}
const s3 = await stat()
check('键盘换段 → 光标块变了', !!cb2 && cb2.top !== cb1.top, `光标 ${cb1.top} → ${cb2?.top} <${cb2?.tag}>「${cb2?.text}」`)
check(
  '键盘换段后 ＋ 跟到新段落',
  !!cb2 && s3.visible === true && s3.top >= cb2.top - 8 && s3.top <= cb2.bottom,
  `dot ${s3.top} / 新段 ${cb2.top}..${cb2.bottom}`,
)
await page.screenshot({ path: `${outDir}/caret-keyboard.png` })

/* 3.5) 鼠标一直停在老段落没动：停手一会儿（900ms 复核）后要自己收掉 */
await wait(1300)
const s35 = await stat()
check('鼠标不在新光标行 → 停顿后自动收起', s35.visible === false, JSON.stringify(s35))

/* 4) 鼠标移到新光标段落 → 再出现 */
await page.mouse.move(A.x, cb2.top + 12, { steps: 6 })
await wait(320)
const s4 = await stat()
check('鼠标移到新光标段落 → 再出现', s4.visible === true && s4.top >= cb2.top - 8 && s4.top <= cb2.bottom, `dot ${s4.top} / 光标段 ${cb2.top}..${cb2.bottom}`)

/* 5) 鼠标移到非光标段落 → 必须收起 */
await page.mouse.move(B.x, B.y, { steps: 8 })
await wait(500)
const s5 = await stat()
check('鼠标移到非光标段落 → 收起', s5.visible === false, `鼠标 y=${B.y} / ${JSON.stringify(s5)}`)
await page.screenshot({ path: `${outDir}/caret-off.png` })

/* 6) 鼠标离开正文/窗口 → 收起 */
await page.mouse.move(70, 700, { steps: 8 })
await wait(500)
const s6 = await stat()
check('鼠标离开正文 → 收起', s6.visible === false, JSON.stringify(s6))

/* 7) 点另一段 C */
await page.mouse.click(C.x, C.y)
await wait(320)
await page.mouse.move(C.x, C.y, { steps: 5 })
await wait(300)
const s7 = await stat()
const cb7 = await caretBlock()
check(
  '点另一段后 ＋ 到新段落',
  s7.visible === true && !!cb7 && s7.top >= cb7.top - 8 && s7.top <= cb7.bottom,
  `dot ${s7.top} / 段 ${cb7?.top}..${cb7?.bottom}「${cb7?.text}」`,
)

console.log('')
const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `${bad.length} 项未通过` : '全部通过')
await browser.close()
process.exit(bad.length ? 1 : 0)

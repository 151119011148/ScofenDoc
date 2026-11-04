import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * 选区工具条「等选中完成再弹」验收：
 *  1) 真实鼠标拖选（down → move → move → up）过程中 .sel-bar 不能出现
 *  2) 松手后必须出现，且位置落在选区上方
 *  3) 键盘 Shift+方向键连续选中时不弹，停手后才弹
 *  4) 弹出来之后按钮照常可用（加粗能否写入）
 *
 * 全程在临时文档里操作，跑完软删该文档。
 * 用法：node bubble-defer-check.mjs <JWT_SECRET>
 */

const secret = process.argv[2]
if (!secret) {
  console.error('用法：node bubble-defer-check.mjs <JWT_SECRET>')
  process.exit(1)
}

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '60m' },
)

const ORIGIN = 'http://47.117.110.143'
const BASE = `${ORIGIN}/scofendoc/`
const API = `${ORIGIN}/scofendoc/api`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

/* 1) 建临时文档 */
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
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
const created = await page.evaluate(
  async (api, tk) => {
    const r = await fetch(`${api}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ workspaceId: 2, parentId: null, title: '【临时】选区弹窗时机验收' }),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  },
  API,
  token,
)
const doc = created.body
if (!doc?.id) {
  console.log(JSON.stringify(created, null, 2))
  await browser.close()
  process.exit(1)
}

/* 2) 输入验收文本 */
await page.goto(`${BASE}?space=2&doc=${doc.id}`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(1200)
await page.click('.ProseMirror')
await page.keyboard.type('第一段 拖拽选择必须松手之后才弹工具条')
await page.keyboard.press('Enter')
await page.keyboard.type('第二段 用键盘配合 Shift 连续扩选也不要中途弹')
await page.keyboard.press('Enter')
await page.keyboard.type('第三段 键盘选中停手之后应当弹出工具条')
await sleep(600)

/** 第 n 个段落的几何（行内靠左到靠右的一段，用来模拟横向拖选） */
const paraBox = (n) =>
  page.evaluate((idx) => {
    const ps = [...document.querySelectorAll('.ProseMirror > p')].filter((el) => el.getBoundingClientRect().height > 8)
    const el = ps[idx]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      y: Math.round(r.top + Math.min(r.height / 2, 12)),
      text: el.textContent,
    }
  }, n)

/** 工具条当前状态 */
const barState = () =>
  page.evaluate(() => {
    const b = document.querySelector('.sel-bar')
    if (!b) return { visible: false }
    const r = b.getBoundingClientRect()
    return { visible: true, left: Math.round(r.left), top: Math.round(r.top) }
  })

/* 3) 真实拖选：中途一律不弹 */
const box = await paraBox(0)
if (!box) throw new Error('没找到正文段落')
await page.mouse.move(box.left + 3, box.y)
await page.mouse.down()
const mid = []
const steps = 6
for (let i = 1; i <= steps; i++) {
  const x = box.left + 3 + ((box.right - box.left - 20) * i) / steps
  await page.mouse.move(x, box.y, { steps: 2 })
  await sleep(45)
  mid.push(await barState())
}
const dragVisible = mid.filter((s) => s.visible).length
check('拖选途中不弹工具条', dragVisible === 0, `${mid.length} 次采样，弹出 ${dragVisible} 次`)

const selDuring = await page.evaluate(() => {
  const s = window.getSelection()
  return { len: s ? s.toString().length : 0 }
})
check('拖选途中确实已有选区', selDuring.len > 0, `已选 ${selDuring.len} 字`)

/* 4) 松手后必须弹 */
await page.mouse.up()
await sleep(320)
const afterUp = await barState()
check('松手后弹出工具条', afterUp.visible === true, JSON.stringify(afterUp))
check('工具条在选区上方', afterUp.visible && afterUp.top < box.top, `bar top ${afterUp.top} vs 段落 top ${box.top}`)
await page.screenshot({ path: '/tmp/plus-shots/bubble-after-drag.png' })

/* 5) 再拖一次：旧工具条要先消失，新的一次仍要等松手 */
const box2 = await paraBox(1)
await page.mouse.move(box2.left + 3, box2.y)
await page.mouse.down()
await page.mouse.move(box2.left + 120, box2.y, { steps: 4 })
await sleep(60)
const duringSecond = await barState()
check('再次拖选时旧工具条立即收起', duringSecond.visible === false)
await page.mouse.move(box2.left + 240, box2.y, { steps: 4 })
await sleep(60)
const duringSecond2 = await barState()
check('再次拖选途中仍不弹', duringSecond2.visible === false)
await page.mouse.up()
await sleep(320)
const afterUp2 = await barState()
check('再次松手后弹出', afterUp2.visible === true, JSON.stringify(afterUp2))

/* 6) 键盘连续扩选：不中途弹，停手才弹 */
await page.click('.ProseMirror > p:nth-child(3)')
await sleep(200)
await page.keyboard.press('Home')
await sleep(150)
const duringKeys = []
for (let i = 0; i < 8; i++) {
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  await sleep(45)
  duringKeys.push(await barState())
}
const keyVisible = duringKeys.filter((s) => s.visible).length
check('键盘连按时不弹', keyVisible === 0, `${duringKeys.length} 次采样，弹出 ${keyVisible} 次`)
await sleep(400)
const afterKeys = await barState()
check('键盘停手后弹出', afterKeys.visible === true, JSON.stringify(afterKeys))

/* 7) 弹出来之后按钮照常可用：先取消选区，再重新拖选中第二段，点加粗应落在第二段上 */
await page.keyboard.press('ArrowRight')
await sleep(350)
const collapsed = await barState()
check('选区收成光标后工具条收起', collapsed.visible === false, JSON.stringify(collapsed))

// 工具条可能正压在第二段上方，点击位置取行尾（避开浮层）
await page.mouse.click(box2.right - 12, box2.y)
await sleep(350)
const afterClick = await barState()
check('单击落光标后不残留工具条', afterClick.visible === false)

await page.mouse.move(box2.left + 3, box2.y)
await page.mouse.down()
await page.mouse.move(box2.left + 200, box2.y, { steps: 5 })
await sleep(50)
await page.mouse.up()
await sleep(320)
await page.click('.sel-bar button[title^="加粗"]')
await sleep(350)
const strong = await page.$$eval('.ProseMirror strong', (els) => els.map((e) => e.textContent))
check('工具条按钮作用在本轮拖选的文字上', strong.some((s) => s.startsWith('第二段')), JSON.stringify(strong))

console.log(`\nJS 错误：${errors.length ? errors.slice(0, 4).join(' | ') : '无'}`)
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\n${failed.length} 项未通过` : '\n全部通过')

/* 9) 清理 */
await page.evaluate(
  async (api, tk, id) => {
    await fetch(`${api}/docs/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tk}` } })
  },
  API,
  token,
  doc.id,
)

await browser.close()
process.exit(failed.length ? 1 : 0)

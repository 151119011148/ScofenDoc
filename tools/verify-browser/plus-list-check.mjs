import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * 行内 ＋ 在「列表里」的表现验收：
 *  1) 光标落在第 3 个列表项，＋ 必须贴在那一行（不能顶到列表第一行）
 *  2) 点 ＋ → 选「正文」后结构仍合法、原文本不丢
 * 全程在临时文档里操作，跑完软删。
 * 用法：node plus-list-check.mjs <JWT_SECRET>
 */

const secret = process.argv[2]
if (!secret) {
  console.error('用法：node plus-list-check.mjs <JWT_SECRET>')
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
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
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

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.evaluate(
  (t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
  },
  token,
)
const created = await page.evaluate(
  async (api, tk) => {
    const r = await fetch(`${api}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ workspaceId: 2, parentId: null, title: '【临时】＋ 列表位置验收' }),
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

await page.goto(`${BASE}?space=2&doc=${doc.id}`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(1200)

/* 敲 4 行文字，再整体转成无序列表 */
const lines = ['第一项 甲乙丙', '第二项 丁戊己', '第三项 庚辛壬', '第四项 癸子丑']
await page.click('.ProseMirror')
for (let i = 0; i < lines.length; i++) {
  await page.keyboard.type(lines[i])
  if (i < lines.length - 1) await page.keyboard.press('Enter')
}
await sleep(300)
await page.keyboard.down('Meta')
await page.keyboard.press('KeyA')
await page.keyboard.up('Meta')
await sleep(500)
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title="列表"]')
await page.waitForSelector('.sel-panel .sel-item', { timeout: 3000 })
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.sel-panel .sel-item')].find((x) => x.textContent.includes('无序列表'))
  b?.click()
})
await sleep(600)
const liCount = await page.$$eval('.ProseMirror ul > li', (els) => els.length)
check('已生成 4 项无序列表', liCount === 4, `li=${liCount}`)

/* 点进第 3 项 */
const lis = await page.$$eval('.ProseMirror ul > li', (els) =>
  els.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 60), y: Math.round(r.top + 12), top: Math.round(r.top), bottom: Math.round(r.bottom), text: (el.textContent || '').slice(0, 10) }
  }),
)
const third = lis[2]
await page.mouse.click(third.x, third.y)
await sleep(320)
await page.mouse.move(third.x, third.y, { steps: 5 })
await sleep(300)
const stat = await page.evaluate(() => {
  const dot = document.querySelector('.plus-dot')
  if (!dot) return { visible: false }
  const r = dot.getBoundingClientRect()
  return { visible: getComputedStyle(dot).display !== 'none', top: Math.round(r.top), left: Math.round(r.left) }
})
check(
  '第 3 项内 ＋ 贴在光标那一行（不是列表首项）',
  stat.visible === true && stat.top >= third.top - 8 && stat.top <= Math.min(third.bottom, third.top + 34),
  `dot ${stat.top} / 第3项 ${third.top}..${third.bottom}「${third.text}」/ 首项 top ${lis[0].top}`,
)
await page.screenshot({ path: '/tmp/plus-shots/list-dot.png' })

/* 打开块菜单，看菜单是不是也贴着 ＋ */
await page.mouse.move(stat.left + 10, stat.top + 10, { steps: 6 })
await sleep(500)
const menu = await page.evaluate(() => {
  const m = document.querySelector('.slash-menu')
  if (!m) return null
  const r = m.getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), h: Math.round(r.height) }
})
check('块菜单出现在 ＋ 旁边', !!menu && Math.abs(menu.top - stat.top) < 60, JSON.stringify(menu))
await page.screenshot({ path: '/tmp/plus-shots/list-menu.png' })

/* 选「正文」→ 必须在列表之后落一个新段落，且原列表完好 */
const itemBox = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.slash-menu .slash-item')].find((x) => (x.textContent || '').includes('正文'))
  if (!b) return null
  b.scrollIntoView({ block: 'center' })
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})
if (!itemBox) throw new Error('菜单里没找到「正文」项')
await page.mouse.click(itemBox.x, itemBox.y)
await sleep(800)
const after = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const ul = pm ? pm.querySelector('ul') : null
  return {
    html: pm ? pm.innerHTML : '',
    liCount: pm ? pm.querySelectorAll('ul > li').length : 0,
    pInUl: pm ? pm.querySelectorAll('ul > p').length : 0,
    pAfterUl: !!(ul && ul.nextElementSibling && ul.nextElementSibling.tagName === 'P'),
    menuOpen: !!document.querySelector('.slash-menu'),
    text: pm ? pm.innerText.replace(/\s+/g, ' ').trim() : '',
  }
})
check('插入后 4 个列表项还在', after.liCount === 4, `li=${after.liCount} / ul 内直接段落 ${after.pInUl}`)
check('新段落落在列表之后', after.pAfterUl === true, `pAfterUl=${after.pAfterUl}`)
check('选完之后菜单收起', after.menuOpen === false)
check('原有文字没丢', lines.every((l) => after.text.includes(l.slice(0, 3))), after.text.slice(0, 80))
console.log('\n插入后的结构（截断）：\n' + after.html.replace(/<p>/g, '\n<p>').slice(0, 700))

console.log(`\nJS 错误：${errors.length ? errors.slice(0, 3).join(' | ') : '无'}`)
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\n${failed.length} 项未通过` : '\n全部通过')

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

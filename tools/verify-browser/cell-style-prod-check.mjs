/**
 * 线上只读验收：单元格底色 / 对齐 / 多选操作条。
 *
 *   node cell-style-prod-check.mjs <JWT_SECRET> [docId]
 *
 * 只看不写：拖选单元格（只改本地选区）、打开操作条、展开色板、打开块菜单看「单元格」段，
 * 全程不点任何会改文档的按钮，最后 Esc 退出。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const docId = Number(process.argv[3]) || 70
if (!secret) {
  console.error('用法: node cell-style-prod-check.mjs <JWT_SECRET> [docId]')
  process.exit(2)
}

const BASE = 'http://47.117.110.143/scofendoc/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key, { algorithm: 'HS256', expiresIn: '30m' },
)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

await page.goto(`${BASE}?space=2&doc=${docId}`, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({
    id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
  }))
}, token)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 40000 })
await sleep(2000)

// 表格可能不在首屏，滚到视口中间再量坐标
await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  const r = t.getBoundingClientRect()
  if (r.top < 140 || r.bottom > window.innerHeight - 60) t.scrollIntoView({ block: 'center' })
})
await sleep(800)

const grid = await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  return [...t.rows].slice(0, 3).map((r) =>
    [...r.cells].map((c) => {
      const b = c.getBoundingClientRect()
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }
    }),
  )
})
if (grid.length < 2) {
  console.log('文档里表格行数不足，无法拖选两行')
  await browser.close()
  process.exit(1)
}
const a = grid[0][0]
const b2 = grid[1][Math.min(1, grid[1].length - 1)]
await page.mouse.move(a.cx, a.cy)
await sleep(60)
await page.mouse.down()
await page.mouse.move(a.cx + 6, a.cy + 6, { steps: 4 })
await page.mouse.move(b2.cx, b2.cy, { steps: 12 })
await sleep(80)
await page.mouse.up()
await sleep(420)

const bar = await page.evaluate(() => {
  const el = document.querySelector('.tbl-cellbar')
  const sel = document.querySelectorAll('.ProseMirror td.selectedCell, .ProseMirror th.selectedCell')
  return el
    ? {
        labels: [...el.querySelectorAll('.tbl-cbtn')].map((x) => x.textContent.trim() || x.title),
        selCount: sel.length,
      }
    : null
})
check('线上拖选单元格浮出操作条', !!bar, bar ? `${bar.selCount} 格` : '未出现')
check(
  '操作条含合并/底色/对齐/删除',
  !!bar && ['合并', '底色', '左对齐', '居中', '右对齐', '删除表格'].every((k) => bar.labels.some((l) => l.includes(k))),
  bar ? bar.labels.join('|') : '',
)

await page.click('.tbl-cellbar .tbl-bgwrap .tbl-cbtn')
await sleep(280)
const sw = await page.$$eval('.tbl-cellbar .tbl-bgpop .tbl-bgsw', (els) => els.map((e) => e.title))
check('底色色板 8 档', sw.length === 8, sw.join(','))
await page.keyboard.press('Escape')
await sleep(250)

// 块菜单里的「单元格」段
await page.mouse.move(b2.cx, b2.cy)
await sleep(320)
const handle = await page.$('.tbl-handle .tbl-hbtn')
check('块手柄出现', !!handle)
if (handle) {
  await handle.click()
  await sleep(340)
  const menu = await page.evaluate(() => ({
    swatches: document.querySelectorAll('.tbl-menu .tbl-sws .tbl-bgsw').length,
    aligns: document.querySelectorAll('.tbl-menu .tbl-alns .tbl-aln').length,
    sect: document.querySelector('.tbl-menu .tbl-sect')?.textContent?.trim() || '',
    items: [...document.querySelectorAll('.tbl-menu .tbl-item')].length,
  }))
  check('菜单有「单元格」底色与对齐', menu.swatches === 8 && menu.aligns === 3 && menu.sect === '单元格', JSON.stringify(menu))
  check('原有 10 个菜单项仍在', menu.items === 10, `${menu.items} 项`)
  await page.keyboard.press('Escape')
  await sleep(200)
}

check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' / '))
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

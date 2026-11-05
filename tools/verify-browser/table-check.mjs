/**
 * 飞书式表格验收。
 *
 *   node table-check.mjs --local                 # 本地冒烟页，含写操作
 *   node table-check.mjs <JWT_SECRET> [docId]    # 线上只读，docId 默认 70
 *
 * 线上模式只做「不改文档」的检查：hover 手柄、打开块菜单、核对菜单项与开关初始态、
 * 选中整表看样式、右键菜单定位；均分列宽/追加行/切换标题行这些会写 Yjs，
 * 只在本地冒烟页执行。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const local = process.argv[2] === '--local'
const secret = local ? '' : process.argv[2]
const docId = Number(process.argv[3]) || 70
const BASE = 'http://47.117.110.143/scofendoc/'
const LOCAL = 'http://127.0.0.1:5388/editor-smoke.html'
if (!local && !secret) {
  console.error('用法: node table-check.mjs --local  或  node table-check.mjs <JWT_SECRET> [docId]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}

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

if (local) {
  await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
} else {
  const key = crypto.createHash('sha256').update(secret).digest()
  const token = jwt.sign(
    { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
    key, { algorithm: 'HS256', expiresIn: '30m' },
  )
  await page.goto(`${BASE}?space=2&doc=${docId}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem('scofendoc.user', JSON.stringify({
      id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
    }))
  }, token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ProseMirror table', { timeout: 40000 })
}
await sleep(local ? 900 : 1800)

const geom = () =>
  page.evaluate(() => {
    const t = document.querySelector('.ProseMirror table')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      cx: r.left + r.width / 2, cy: r.top + Math.min(r.height / 2, 40),
      rows: t.rows.length, cols: t.rows[0]?.cells.length || 0,
      widths: [...(t.rows[0]?.cells || [])].map((c) => Math.round(c.getBoundingClientRect().width)),
    }
  })

/** 表格可能在大文档的下方，先滚到视口中间，不然鼠标坐标落在屏幕外 */
async function ensureVisible() {
  await page.evaluate(() => {
    const t = document.querySelector('.ProseMirror table')
    if (!t) return
    const r = t.getBoundingClientRect()
    if (r.top < 90 || r.bottom > window.innerHeight - 40) t.scrollIntoView({ block: 'center' })
  })
  await sleep(650)
}
await ensureVisible()

if (!local) {
  const diag = await page.evaluate(() => ({
    ce: document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
    tables: document.querySelectorAll('.ProseMirror table').length,
    rows: document.querySelector('.ProseMirror table')?.rows.length || 0,
  }))
  console.log('DIAG', JSON.stringify(diag))
}

let g = await geom()
if (!g) {
  console.log('FAIL  没找到表格')
  await browser.close()
  process.exit(1)
}

/** 鼠标移到表格上，等块手柄出现 */
async function hoverTable() {
  await page.mouse.move(g.cx, g.cy)
  await sleep(320)
}
async function handleBox() {
  return page.evaluate(() => {
    const h = document.querySelector('.tbl-handle')
    if (!h) return null
    const r = h.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, w: r.width, h: r.height }
  })
}
async function menuInfo() {
  return page.evaluate(() => {
    const m = document.querySelector('.tbl-menu')
    if (!m) return null
    return {
      items: [...m.querySelectorAll('.tbl-item')].map((b) => ({
        label: b.querySelector('.tbl-label')?.textContent?.trim() || b.textContent.trim(),
        sw: b.querySelector('.tbl-sw')?.classList.contains('on') ?? null,
      })),
      left: Math.round(m.getBoundingClientRect().left),
      top: Math.round(m.getBoundingClientRect().top),
    }
  })
}
async function closeMenu() {
  await page.keyboard.press('Escape')
  await sleep(200)
}

/* ---------- 1. 块手柄 ---------- */
await hoverTable()
const hb = await handleBox()
check('鼠标经过表格浮出块手柄', !!hb, JSON.stringify(hb))
check('手柄贴在表格左侧', !!hb && hb.right <= g.left + 6, hb && `手柄右沿 ${Math.round(hb.right)} / 表格左沿 ${Math.round(g.left)}`)
check('手柄上有表格图标 / 六点 / 添加行三个入口',
  await page.evaluate(() => !!document.querySelector('.tbl-hbtn') && !!document.querySelector('.tbl-hdots') && !!document.querySelector('.tbl-hadd')))

/* ---------- 2. 块菜单 ---------- */
if (await page.evaluate(() => !!document.querySelector('.tbl-handle'))) {
  await page.click('.tbl-handle .tbl-hbtn')
  await sleep(280)
}
let menu = await menuInfo()
check('点表格图标打开块菜单', !!menu, menu && `${menu.items.length} 项`)
if (menu) {
  const labels = menu.items.map((i) => i.label)
  const need = ['标题行', '标题列', '均分列宽', '在上方插入行', '在下方插入行', '在左侧插入列', '在右侧插入列', '删除表格']
  check('菜单项与飞书一致', need.every((n) => labels.includes(n)), labels.join(' / '))
  check('「标题行」开关初态与正文一致',
    menu.items.find((i) => i.label === '标题行')?.sw === true,
    JSON.stringify(menu.items.filter((i) => i.sw !== null)))
  check('菜单出现在手柄右侧、不与表格重叠',
    menu.left > (hb?.right || 0), `菜单 left ${menu.left}`)
}

/* ---------- 3. 整表选中态 ---------- */
if (menu) await closeMenu()
await hoverTable()
if (await page.evaluate(() => !!document.querySelector('.tbl-hdots'))) {
  await page.click('.tbl-hdots')
  await sleep(320)
}
const selState = await page.evaluate(() => {
  const wrap = document.querySelector(
    '.ProseMirror .tableWrapper.ProseMirror-selectednode, .ProseMirror table.ProseMirror-selectednode',
  )
  const t = document.querySelector('.ProseMirror table')
  const td = t.querySelector('tr:nth-child(2) td') || t.querySelector('td')
  return {
    sel: !!wrap,
    cls: wrap?.className || '',
    bg: td ? getComputedStyle(td).backgroundColor : '',
    outline: getComputedStyle(t).outlineColor,
  }
})
check('六点手柄选中整张表格', selState.sel, selState.cls)
check('选中态是淡蓝底 + 蓝框',
  selState.bg.includes('51, 112, 255') && selState.outline.includes('51, 112, 255'),
  JSON.stringify(selState))

if (!local) {
  // 线上到此为止：后面的操作会改文档结构
  check('线上页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
  await browser.close()
  const failed = results.filter((r) => !r).length
  console.log(`\n结果：${results.length - failed}/${results.length} 通过（线上只读）`)
  process.exit(failed ? 1 : 0)
}

/* ---------- 4. 追加行（＋） ---------- */
await page.keyboard.press('Escape')
await hoverTable()
const beforeRows = (await geom()).rows
await page.click('.tbl-hadd')
await sleep(500)
const afterRows = (await geom()).rows
check('手柄的 ＋ 在表格末尾追加一行', afterRows === beforeRows + 1, `${beforeRows} → ${afterRows}`)

/* ---------- 5. 标题行开关 ---------- */
await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
await sleep(900)
g = await geom()
await hoverTable()
await page.click('.tbl-handle .tbl-hbtn')
await sleep(260)
const thBefore = await page.evaluate(() => document.querySelector('.ProseMirror table tr').cells[0].tagName)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tbl-item')].find((x) => x.textContent.includes('标题行'))
  b.click()
})
await sleep(420)
const thAfter = await page.evaluate(() => document.querySelector('.ProseMirror table tr').cells[0].tagName)
const swAfter = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tbl-item')].find((x) => x.textContent.includes('标题行'))
  return b?.querySelector('.tbl-sw')?.classList.contains('on')
})
check('「标题行」开关把首行 TH 切成 TD', thBefore === 'TH' && thAfter === 'TD', `${thBefore} → ${thAfter}`)
check('开关状态跟着切换', swAfter === false, String(swAfter))

/* ---------- 6. 均分列宽 ---------- */
await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
await sleep(900)
g = await geom()
// 先手动把三列拉成不等宽，才能看出均分是否生效
await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  t.style.tableLayout = 'fixed'
  const cols = [...t.querySelectorAll('col')]
  if (cols.length) {
    cols[0].style.width = '420px'
    cols[1].style.width = '160px'
    cols[2].style.width = '140px'
  }
})
await sleep(200)
const uneven = (await geom()).widths
await hoverTable()
await page.click('.tbl-handle .tbl-hbtn')
await sleep(260)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tbl-item')].find((x) => x.textContent.includes('均分列宽'))
  b.click()
})
await sleep(520)
const even = (await geom()).widths
const spread = Math.max(...even) - Math.min(...even)
check('「均分列宽」把各列拉平', spread <= 3, `${uneven.join('/')} → ${even.join('/')}`)

/* ---------- 7. 拖列宽 ---------- */
await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
await sleep(900)
g = await geom()
const cell0 = await page.evaluate(() => {
  const c = document.querySelector('.ProseMirror table tr').cells[0]
  const r = c.getBoundingClientRect()
  return { right: r.right, top: r.top }
})
await page.mouse.move(cell0.right - 2, cell0.top + 24)
await sleep(320)
const hasHandle = await page.evaluate(() => {
  const h = document.querySelector('.column-resize-handle')
  return !!h && getComputedStyle(h).display !== 'none'
})
const w0 = (await geom()).widths[0]
await page.mouse.down()
await page.mouse.move(cell0.right + 70, cell0.top + 24, { steps: 10 })
await page.mouse.up()
await sleep(500)
const w1 = (await geom()).widths[0]
check('鼠标靠近列边界出现拖拽手柄', hasHandle)
check('拖动列边界改变首列宽度', Math.abs(w1 - w0) >= 20, `${w0}px → ${w1}px`)

/* ---------- 8. 右键菜单 ---------- */
await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
await sleep(900)
g = await geom()
await page.mouse.click(g.cx, g.cy, { button: 'right' })
await sleep(320)
const ctx = await menuInfo()
check('右键单元格在鼠标处打开同一份菜单', !!ctx, ctx && `left ${ctx.left} top ${ctx.top}`)
check('右键时页面没有弹出系统菜单', await page.evaluate(() => !!document.querySelector('.tbl-menu')))

check('本地页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n结果：${results.length - failed}/${results.length} 通过（本地）`)
process.exit(failed ? 1 : 0)

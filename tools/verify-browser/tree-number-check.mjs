/**
 * 文档树章节号验收（线上只读）。
 *
 *   node tree-number-check.mjs <JWT_SECRET> [baseUrl]
 *
 * 检查：树内蓝色层级前缀 1 / 1.1 / 1.1.1、折叠不影响编号、
 * 正文标题栏与面包屑、右键菜单、搜索结果 / 主页最近文档、按章节号搜索。
 * 全程只读，不新建/移动/删除任何文档。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const BASE = process.argv[3] || 'http://47.117.110.143/scofendoc/'
if (!secret) {
  console.error('用法: node tree-number-check.mjs <JWT_SECRET> [baseUrl]')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '30m' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}
const BLUE = ['rgb(51, 112, 255)', 'rgb(36, 91, 219)']

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 960 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    errors.push(m.text().slice(0, 160))
  }
})
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`${r.status()} ${r.url().slice(0, 120)}`)
})

await page.goto(`${BASE}?space=2`, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({
    id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
  }))
}, token)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.tree-row .tree-no', { timeout: 30000 })
await sleep(1500)

/* 1) 树内前缀 */
const treeInfo = await page.evaluate(() => {
  const nos = [...document.querySelectorAll('.tree-row .tree-no')]
  const rows = [...document.querySelectorAll('.tree-row')]
  return {
    count: nos.length,
    samples: nos.slice(0, 8).map((n) => n.textContent.trim()),
    color: nos.length ? getComputedStyle(nos[0]).color : '',
    allValid: nos.every((n) => /^\d+(\.\d+)*$/.test(n.textContent.trim())),
    hasLevels: ['1', '1.1', '1.1.1'].every((lv) => nos.some((n) => n.textContent.trim() === lv)),
    legacyTitles: rows
      .map((r) => r.querySelector('.title')?.textContent?.trim() || '')
      .filter((t) => /^\d+(\.\d+)*[-.、\s]/.test(t)),
  }
})
check('文档树渲染出大量蓝色编号前缀', treeInfo.count > 100, `共 ${treeInfo.count} 行，样例 ${treeInfo.samples.join(' ')}`)
check('编号格式全部为 1 / 1.1 / 1.1.1', treeInfo.allValid)
check('出现根 / 二级 / 三级编号', treeInfo.hasLevels)
check('前缀为蓝色', BLUE.includes(treeInfo.color), treeInfo.color)
check('标题里旧手写编号已清空', treeInfo.legacyTitles.length === 0, JSON.stringify(treeInfo.legacyTitles.slice(0, 3)))

/* 2) 折叠/展开不改变编号（编号基于完整树而非可见行）
      折叠只会隐藏行：剩下的编号必须原样保留，且不能凭空冒出新编号，
      展开后整份「编号 → 标题」映射要完全复原。 */
const pairs = () => page.$$eval('.tree-row', (rows) => rows.map((r) => [
  r.querySelector('.tree-no')?.textContent.trim() || '',
  r.querySelector('.title')?.textContent.trim() || '',
]))
const beforeFold = await pairs()
const beforeMap = new Map(beforeFold)
const toggle11 = () => page.evaluate(() => {
  const tw = [...document.querySelectorAll('.tree-row .twist:not(.placeholder)')]
    .find((el) => el.closest('.tree-row')?.querySelector('.tree-no')?.textContent.trim() === '1.1')
  tw?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await toggle11()
await sleep(300)
const folded = await pairs()
const stable = folded.every(([no, title]) => beforeMap.has(no) && beforeMap.get(no) === title)
check('折叠后剩余行编号不重排', stable && folded.length < beforeFold.length,
  `折叠前 ${beforeFold.length} 行 → 折叠后 ${folded.length} 行`)
await toggle11()
await sleep(300)
const unfolded = await pairs()
check('展开后编号完整复原', JSON.stringify(unfolded) === JSON.stringify(beforeFold))

/* 3) 选中一篇三层文档：标题栏 / 面包屑 / 右键菜单 */
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row')]
    .find((r) => r.querySelector('.tree-no')?.textContent.trim() === '1.1.1')
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForSelector('.title-line .doc-no-lg', { timeout: 20000 })
const headInfo = await page.evaluate(() => {
  const big = document.querySelector('.title-line .doc-no-lg')
  const input = document.querySelector('.title-input')
  return {
    big: big?.textContent.trim() || '',
    bigColor: big ? getComputedStyle(big).color : '',
    titleValue: input?.value || '',
    crumbs: [...document.querySelectorAll('.crumb-no')].map((n) => n.textContent.trim()),
  }
})
check('正文标题栏带章节号', headInfo.big === '1.1.1', headInfo.big)
check('标题栏编号为蓝色', BLUE.includes(headInfo.bigColor), headInfo.bigColor)
check('输入框只装纯标题（编号不写进标题）', !/^\d+(\.\d+)*\s/.test(headInfo.titleValue), headInfo.titleValue)
check('面包屑每级都带编号', headInfo.crumbs.length >= 2 && headInfo.crumbs[0] === '1', JSON.stringify(headInfo.crumbs))

await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row')]
    .find((r) => r.querySelector('.tree-no')?.textContent.trim() === '1.1.1')
  row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 300 }))
})
await sleep(200)
const ctxNo = await page.$eval('.ctx-menu .ctx-no', (n) => n.textContent.trim()).catch(() => '')
check('右键菜单标题带编号', ctxNo === '1.1.1', ctxNo)
await page.keyboard.press('Escape')

/* 4) 搜索结果：关键词 + 纯章节号 */
async function search(kw) {
  await page.evaluate(() => {
    const el = document.querySelector('.nav-search input')
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('.nav-search input')
  await page.type('.nav-search input', kw)
  await sleep(900)
}

await search('Java基础')
const kwHits = await page.evaluate(() => ({
  rows: document.querySelectorAll('.hit-row').length,
  nos: [...document.querySelectorAll('.hit-no')].slice(0, 5).map((n) => n.textContent.trim()),
  color: document.querySelector('.hit-no') ? getComputedStyle(document.querySelector('.hit-no')).color : '',
}))
check('关键词搜索结果带编号', kwHits.rows > 0 && kwHits.nos.length > 0, JSON.stringify(kwHits.nos))
check('搜索结果编号为蓝色', BLUE.includes(kwHits.color), kwHits.color)

await search('1.1')
const numHits = await page.evaluate(() => ({
  rows: document.querySelectorAll('.hit-row').length,
  nos: [...document.querySelectorAll('.hit-no')].slice(0, 4).map((n) => n.textContent.trim()),
}))
check('按章节号「1.1」能搜到该章及子文档', numHits.rows > 0 && numHits.nos.some((n) => n === '1.1' || n.startsWith('1.1.')), JSON.stringify(numHits.nos))

/* 5) 主页最近更新 */
await page.evaluate(() => {
  const home = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('主页'))
  home?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(1000)
const homeNos = await page.$$eval('.hit-no', (ns) => ns.slice(0, 5).map((n) => n.textContent.trim()))
check('主页最近更新也带编号', homeNos.length > 0, JSON.stringify(homeNos))

check('页面无 JS 报错 / 无接口失败', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n结果：${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

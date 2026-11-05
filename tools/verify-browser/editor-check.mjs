/**
 * 编辑器回归验收：标题自动编号 + 表格行列增删改 / 删除表格。
 *
 * 不依赖后端与协同服务，直接跑本地的纯 Tiptap 冒烟页：
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node editor-check.mjs                       # 默认 http://127.0.0.1:5388/editor-smoke.html
 *   node editor-check.mjs http://…/editor-smoke.html
 *
 * 冒烟页是 frontend/editor-smoke.html（Vite 构建只认 index.html，不会进生产产物）。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/editor-smoke.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()) })
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`) })

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror h1', { timeout: 20000 })
await sleep(300)

/* 1) 全文编号：1 / 1.1 / 1.2 / 1.2.1 */
await page.evaluate(() => window.ed.commands.setAllHeadingsNumbered(true))
await sleep(150)
const nums = await page.$$eval('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3', (hs) =>
  hs.map((h) => h.getAttribute('data-number')),
)
check('层级编号 1 / 1.1 / 1.2 / 1.2.1', JSON.stringify(nums) === JSON.stringify(['1.', '1.1.', '1.2.', '1.2.1.']), JSON.stringify(nums))

const before = await page.$eval('.ProseMirror h1', (h) => getComputedStyle(h, '::before').content)
check('CSS 伪元素渲染出序号', before.includes('1.'), before)

/* 2) 单个标题关编号，后续编号自动重排 */
await page.evaluate(() => {
  const ed = window.ed
  let target = -1
  ed.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.textContent === '小节 A') target = offset
  })
  ed.commands.setTextSelection(target + 1)
  ed.commands.toggleHeadingNumber(false)
})
await sleep(150)
const nums2 = await page.$$eval('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3', (hs) =>
  hs.map((h) => h.getAttribute('data-number')),
)
check('关掉某个标题后其余编号自动重排', nums2[0] === '1.' && nums2[1] === null && nums2[2] === '1.1.' && nums2[3] === '1.1.1.', JSON.stringify(nums2))
const attrs = await page.evaluate(() => window.ed.state.doc.firstChild?.attrs)
check('编号写进 heading attrs（可随 Yjs 同步）', attrs?.numbered === true, JSON.stringify(attrs))
const html = await page.evaluate(() => window.ed.getHTML())
check('HTML 输出带 data-numbered（粘贴/导出可还原）', html.includes('data-numbered="1"'))

/* 2b) 普通段落上开编号标题：块仍要是标题，且直接带上序号（斜杠菜单 / 浮动条走这条路）。
   默认级别从 H2 改成 H1：用户要的是 H1 与有序/无序共存。 */
await page.evaluate(() => {
  const ed = window.ed
  let p = -1
  ed.state.doc.forEach((node, offset) => { if (node.type.name === 'paragraph') p = offset })
  ed.commands.setTextSelection(p + 1)
  ed.commands.toggleHeadingNumber(true)
})
await sleep(150)
const promoted = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('.ProseMirror h1')]
  const hit = hs.find((h) => h.textContent.includes('正文一段'))
  return hit ? { tag: hit.tagName, num: hit.getAttribute('data-number') } : null
})
check('段落直接转「编号标题」（H1）', promoted?.tag === 'H1' && !!promoted?.num, JSON.stringify(promoted))

/* 3) 光标进表格，浮动条出现并显示行列数 */
await page.evaluate(() => {
  const ed = window.ed
  let cell = -1
  ed.state.doc.descendants((node, pos) => {
    if (cell < 0 && (node.type.name === 'tableCell' || node.type.name === 'tableHeader')) cell = pos
  })
  ed.commands.setTextSelection(cell + 1)
})
await sleep(300)
const bar = await page.evaluate(() => {
  const el = document.querySelector('.tbl-bar')
  return el ? { visible: getComputedStyle(el).display !== 'none', size: el.querySelector('.tbl-size')?.textContent } : null
})
check('表格浮动条出现且显示行列数', !!bar?.visible && bar.size === '3 行 × 3 列', JSON.stringify(bar))

/* 4) 增行 / 增列 */
await page.click('.tbl-bar button[title="在下方插入行"]')
await sleep(200)
const rows = await page.$$eval('.ProseMirror table tr', (rs) => rs.length)
check('下方插入一行 → 4 行', rows === 4, String(rows))

await page.click('.tbl-bar button[title="在右侧插入列"]')
await sleep(200)
const cols = await page.$$eval('.ProseMirror table tr:first-child > *', (cs) => cs.length)
check('右侧插入一列 → 4 列', cols === 4, String(cols))

/* 5) 删行 / 删列 */
await page.click('.tbl-bar button[title="删除当前行"]')
await sleep(200)
const rows2 = await page.$$eval('.ProseMirror table tr', (rs) => rs.length)
check('删除当前行 → 3 行', rows2 === 3, String(rows2))
await page.click('.tbl-bar button[title="删除当前列"]')
await sleep(200)
const cols2 = await page.$$eval('.ProseMirror table tr:first-child > *', (cs) => cs.length)
check('删除当前列 → 3 列', cols2 === 3, String(cols2))

/* 6) 右键菜单 + 删除整张表 */
const cellBox = await page.$eval('.ProseMirror table td', (td) => {
  const r = td.getBoundingClientRect()
  return { x: r.left + 8, y: r.top + 8 }
})
await page.mouse.click(cellBox.x, cellBox.y, { button: 'right' })
await sleep(250)
const menu = await page.evaluate(() => {
  const el = document.querySelector('.tbl-menu')
  return el ? el.textContent.includes('删除整个表格') : false
})
check('单元格右键弹出完整菜单', menu)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tbl-menu .tbl-item')].find((b) => b.textContent.includes('删除整个表格'))
  btn?.click()
})
await sleep(250)
const left = await page.evaluate(() => ({
  tables: document.querySelectorAll('.ProseMirror table').length,
  bar: !!document.querySelector('.tbl-bar'),
}))
check('删除整个表格生效且浮动条收起', left.tables === 0 && !left.bar, JSON.stringify(left))

const realErrors = errors.filter((e) => !/favicon\.ico/.test(e))
check('无运行时报错', realErrors.length === 0, JSON.stringify(errors.slice(0, 6)))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

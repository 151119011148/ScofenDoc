/**
 * 表格「单元格底色 / 对齐 / 多选操作条」验收（本地冒烟页，含写操作）。
 *
 *   node cell-style-check.mjs
 *
 * 覆盖：拖选多格 → 操作条浮出并定位在选区上沿、色板 8 档、底色落到 data-bg + 行内样式、
 * 对齐三档、合并/拆分、块菜单里单格改底色、撤销能回退、全程无 JS 报错。
 */
import puppeteer from 'puppeteer-core'

const LOCAL = 'http://127.0.0.1:5388/editor-smoke.html'
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

await page.goto(LOCAL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror table', { timeout: 30000 })
await sleep(900)

const cells = () =>
  page.evaluate(() => {
    const t = document.querySelector('.ProseMirror table')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return {
      table: { left: r.left, top: r.top, width: r.width, height: r.height },
      grid: [...t.rows].map((row) =>
        [...row.cells].map((c) => {
          const b = c.getBoundingClientRect()
          return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, colspan: c.colSpan, rowspan: c.rowSpan }
        }),
      ),
    }
  })

/** 从 (r1,c1) 拖到 (r2,c2)，prosemirror-tables 会把文本选区升级成 CellSelection */
async function dragCells(r1, c1, r2, c2) {
  const g = await cells()
  const a = g.grid[r1][c1]
  const b = g.grid[r2][c2]
  await page.mouse.move(a.cx, a.cy)
  await sleep(60)
  await page.mouse.down()
  await page.mouse.move(a.cx + 6, a.cy + 6, { steps: 4 })
  await page.mouse.move(b.cx, b.cy, { steps: 12 })
  await sleep(80)
  await page.mouse.up()
  await sleep(320)
}

const cellStyles = () =>
  page.evaluate(() => {
    const t = document.querySelector('.ProseMirror table')
    return [...t.rows].flatMap((row) =>
      [...row.cells].map((c) => ({
        bg: c.style.backgroundColor || '',
        dataBg: c.getAttribute('data-bg') || '',
        align: c.style.textAlign || '',
        colspan: c.colSpan,
        selected: c.classList.contains('selectedCell'),
      })),
    )
  })

/* ---------- 1. 拖选 2×2 单元格，操作条应浮出 ---------- */
await dragCells(1, 0, 2, 1)
let bar = await page.evaluate(() => {
  const el = document.querySelector('.tbl-cellbar')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const sel = [...document.querySelectorAll('.ProseMirror td.selectedCell, .ProseMirror th.selectedCell')]
  const tops = sel.map((c) => c.getBoundingClientRect().top)
  return {
    left: r.left, top: r.top, width: r.width,
    selCount: sel.length,
    selTop: Math.min(...tops),
    labels: [...el.querySelectorAll('.tbl-cbtn')].map((b) => b.textContent.trim() || b.title),
  }
})
check('拖选单元格后浮出操作条', !!bar, bar ? `${bar.selCount} 格` : '未出现')
check('操作条在选区上方且不越出视口', !!bar && bar.top + 30 <= bar.selTop && bar.left >= 0, bar ? `bar.top=${Math.round(bar.top)} selTop=${Math.round(bar.selTop)}` : '')
check('操作条含合并/底色/对齐/删除', !!bar && ['合并', '底色', '左对齐', '居中', '右对齐', '删除表格'].every((k) => bar.labels.some((l) => l.includes(k))), bar ? bar.labels.join('|') : '')

/* ---------- 2. 色板与底色 ---------- */
await page.click('.tbl-cellbar .tbl-bgwrap .tbl-cbtn')
await sleep(220)
const swatches = await page.$$eval('.tbl-cellbar .tbl-bgpop .tbl-bgsw', (els) => els.length)
check('底色弹出 8 档色板', swatches === 8, `${swatches} 个`)

await page.evaluate(() => {
  const els = [...document.querySelectorAll('.tbl-cellbar .tbl-bgpop .tbl-bgsw')]
  els.find((e) => e.title.includes('蓝')).click()
})
await sleep(320)
let st = await cellStyles()
const blue = st.filter((c) => c.bg.includes('225, 234, 255') && c.dataBg === '#e1eaff')
check('底色应用到所有选中格', blue.length >= 4, `命中 ${blue.length} 格`)
const bgPopGone = await page.evaluate(() => !document.querySelector('.tbl-bgpop'))
check('选完颜色自动收起色板', bgPopGone)

/* ---------- 3. 对齐 ---------- */
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tbl-cellbar .tbl-cbtn')].find((b) => b.title === '居中')
  btn.click()
})
await sleep(320)
st = await cellStyles()
const centered = st.filter((c) => c.align === 'center')
check('居中应用到所有选中格', centered.length >= 4, `${centered.length} 格`)
const alignOn = await page.evaluate(() =>
  [...document.querySelectorAll('.tbl-cellbar .tbl-cbtn')].some((b) => b.title === '居中' && b.classList.contains('on')),
)
check('对齐按钮显示选中态', alignOn)

/* ---------- 4. 合并 / 拆分 ---------- */
const beforeMerge = await page.evaluate(() => document.querySelector('.ProseMirror table').rows.length)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tbl-cellbar .tbl-cbtn')].find((b) => b.title === '合并单元格')
  btn.click()
})
await sleep(400)
const merged = await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  const spans = [...t.rows].flatMap((r) => [...r.cells].map((c) => c.colSpan * c.rowSpan))
  return { rows: t.rows.length, maxSpan: Math.max(...spans) }
})
check('合并单元格生效', merged.maxSpan > 1, `最大跨格 ${merged.maxSpan}，行数 ${beforeMerge}→${merged.rows}`)

// 合并后选区仍停在合成格上，操作条应自动多出「拆分」
const splitBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tbl-cellbar .tbl-cbtn')].find((x) => x.title === '拆分单元格')
  if (!b) return false
  b.click()
  return true
})
await sleep(420)
const afterSplit = await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  const spans = [...t.rows].flatMap((r) => [...r.cells].map((c) => c.colSpan * c.rowSpan))
  return Math.max(...spans)
})
check('合并后出现「拆分」并能还原', splitBtn && afterSplit === 1, `最大跨格 ${afterSplit}`)

/* ---------- 5. 块菜单里的单格底色 ---------- */
await page.evaluate(() => {
  const ed = window.ed
  const first = ed.view.dom.querySelector('td')
  const pos = ed.view.posAtDOM(first, 0)
  ed.chain().focus().setTextSelection(pos + 1).run()
})
await sleep(250)
const t = await page.evaluate(() => {
  const r = document.querySelector('.ProseMirror table').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + 20 }
})
await page.mouse.move(t.x, t.y)
await sleep(350)
await page.click('.tbl-handle .tbl-hbtn')
await sleep(320)
const menuCell = await page.evaluate(() => ({
  swatches: document.querySelectorAll('.tbl-menu .tbl-sws .tbl-bgsw').length,
  aligns: document.querySelectorAll('.tbl-menu .tbl-alns .tbl-aln').length,
  sect: document.querySelector('.tbl-menu .tbl-sect')?.textContent?.trim() || '',
}))
check('块菜单里有「单元格」底色与对齐', menuCell.swatches === 8 && menuCell.aligns === 3, JSON.stringify(menuCell))

await page.evaluate(() => {
  const els = [...document.querySelectorAll('.tbl-menu .tbl-sws .tbl-bgsw')]
  els.find((e) => e.title.includes('红')).click()
})
await sleep(320)
const singleBg = await page.evaluate(() => {
  const c = document.querySelector('.ProseMirror table td')
  return { bg: c.style.backgroundColor, dataBg: c.getAttribute('data-bg') }
})
check('单格改底色生效', singleBg.dataBg === '#fde2e2' && singleBg.bg.includes('253, 226, 226'), JSON.stringify(singleBg))

/* ---------- 6. 菜单色板能看到当前底色高亮 ---------- */
if (!(await page.$('.tbl-menu'))) {
  await page.mouse.move(t.x, t.y)
  await sleep(320)
  await page.click('.tbl-handle .tbl-hbtn')
  await sleep(320)
}
const activeSw = await page.evaluate(() => {
  const on = document.querySelector('.tbl-menu .tbl-sws .tbl-bgsw.on')
  return on ? on.title : ''
})
check('菜单色板高亮当前底色', activeSw.includes('红'), activeSw)

/* ---------- 7. 无报错 ---------- */
check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' / '))

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

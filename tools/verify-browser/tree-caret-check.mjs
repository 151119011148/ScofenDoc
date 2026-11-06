/**
 * 文档树折叠三角验收：样式与「文章大纲」一致（蓝色、悬停出现、收起后常驻）。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/tree-caret-check.mjs [url]
 *
 * 只跑本地冒烟页（tree-smoke.html，假数据），不连后端、不写数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/tree-smoke.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1200, height: 820 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 300))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForSelector('.tree-row', { timeout: 20000 })
await sleep(320)

/** 把鼠标移开（移到右侧正文区），保证读到的都是「无悬停」状态 */
const parkMouse = async () => {
  await page.mouse.move(900, 700)
  await sleep(180)
}

const state = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tree-row')]
    return {
      count: rows.length,
      titles: rows.map((r) => r.querySelector('.title')?.textContent?.trim() || ''),
      // 标题左边缘：用来验「三角出现/消失不挤动文字」
      titleLeft: rows.map((r) => Math.round(r.querySelector('.title').getBoundingClientRect().left)),
      carets: rows.map((r) => {
        const c = r.querySelector('.twist')
        if (!c) return null
        const s = getComputedStyle(c)
        return {
          tag: c.tagName.toLowerCase(),
          text: (c.textContent || '').trim(),
          placeholder: c.classList.contains('placeholder'),
          open: c.classList.contains('open'),
          opacity: Number(s.opacity),
          color: s.color,
          expanded: c.getAttribute('aria-expanded'),
          title: c.getAttribute('title') || '',
        }
      }),
      collapsedRows: rows.filter((r) => r.classList.contains('collapsed')).length,
    }
  })

// 1) 初始：6 行（父节点默认全展开），只有带子级的三行有真三角
let st = await state()
check('冒烟页渲染 6 行（父节点默认展开）', st.count === 6, `${st.count} 行`)
// 第一章 / 小节 A 有子文档；小节 B、两个细节、第二章 是叶子
check(
  '带子级的行才有真三角（其余是同宽占位）',
  st.carets.filter((c) => c && !c.placeholder).length === 2 &&
    st.carets.filter((c) => c && c.placeholder).length === 4,
  st.carets.map((c) => (c ? (c.placeholder ? 'ph' : 'caret') : '-')).join(','),
)
check(
  '叶子行的占位不显示、不响应点击',
  st.carets.filter((c) => c && c.placeholder).every((c) => c.opacity === 0),
)

// 2) 三角换成了按钮（可聚焦、带 aria），不再是一个灰 ▸ 文本
const btn = st.carets.find((c) => c && !c.placeholder)
check('三角是 button 且没有文字（图形由 CSS 画）', btn.tag === 'button' && btn.text === '', `${btn.tag} "${btn.text}"`)
check('展开时 aria-expanded=true', btn.expanded === 'true', btn.expanded)
check('提示文案说明点它会折叠', /折叠/.test(btn.title), btn.title)

// 3) 无悬停时不可见；悬停该行才出现
await parkMouse()
st = await state()
check(
  '无悬停时三角不可见（默认全部 opacity 0）',
  st.carets.filter((c) => c && !c.placeholder).every((c) => c.opacity === 0),
  st.carets.filter((c) => c && !c.placeholder).map((c) => c.opacity).join(','),
)
const before = st.titleLeft

await page.hover('.tree-row:nth-child(1)')
await sleep(260)
st = await state()
check('悬停第一行时该行三角显示', st.carets[0].opacity === 1, String(st.carets[0].opacity))
check(
  '只显示悬停那一行，其他行仍然隐藏',
  st.carets[2].opacity === 0 && st.carets[4].opacity === 0,
  `${st.carets[2].opacity}/${st.carets[4].opacity}`,
)
check('三角是品牌蓝（#3370ff → rgb(51, 112, 255)）', st.carets[0].color === 'rgb(51, 112, 255)', st.carets[0].color)
check('三角出现后标题没有位移', JSON.stringify(st.titleLeft) === JSON.stringify(before), st.titleLeft.slice(0, 3).join(','))

// 4) 点三角折叠：子级隐藏、三角常驻、图标转向
await page.evaluate(() => document.querySelectorAll('.tree-row')[0].querySelector('.twist').click())
await sleep(260)
await parkMouse()
st = await state()
// 折起第一章后只剩「第一章 总览」和「第二章 设计」两行
check('点三角能折叠：子文档从树里收起', st.count === 2, `${st.count} 行`)
check('折叠后该行标记 collapsed', st.collapsedRows === 1, String(st.collapsedRows))
check('折叠后三角常驻（无悬停也可见）', st.carets[0].opacity === 1, String(st.carets[0].opacity))
check('折叠后 aria-expanded=false 且不再 open（▶ 指向右）', st.carets[0].expanded === 'false' && st.carets[0].open === false)
check('折叠后提示变成「展开」', /展开/.test(st.carets[0].title), st.carets[0].title)
check('折叠后标题仍没被三角挤动', st.titleLeft[0] === before[0], `${st.titleLeft[0]} vs ${before[0]}`)

// 5) 再点一次展开，完全复原
await page.evaluate(() => document.querySelectorAll('.tree-row')[0].querySelector('.twist').click())
await sleep(260)
await parkMouse()
st = await state()
check('再点一次展开：行数复原', st.count === 6 && st.collapsedRows === 0, `${st.count} 行 / collapsed=${st.collapsedRows}`)
check('展开后三角又只在悬停时出现', st.carets[0].opacity === 0, String(st.carets[0].opacity))

// 6) 点三角不应该改变「当前打开文档」
const activeBefore = await page.evaluate(() => document.querySelector('.tree-row.active .title')?.textContent?.trim() || '')
await page.evaluate(() => document.querySelectorAll('.tree-row')[0].querySelector('.twist').click())
await sleep(220)
const activeAfter = await page.evaluate(() => document.querySelector('.tree-row.active .title')?.textContent?.trim() || '')
check('点三角不会切换当前文档', activeBefore === activeAfter && activeBefore === '第一章 总览', `${activeBefore} → ${activeAfter}`)

// 7) 窄屏：没有 hover，三角常驻
const mobile = await browser.newPage()
await mobile.setViewport({ width: 390, height: 780 })
await mobile.goto(URL, { waitUntil: 'networkidle2' })
await mobile.waitForSelector('.tree-row')
await sleep(320)
const mob = await mobile.evaluate(() => {
  const c = document.querySelector('.tree-row .twist')
  const s = getComputedStyle(c)
  return { opacity: Number(s.opacity), w: Math.round(c.getBoundingClientRect().width) }
})
check('手机端三角常驻（没有悬停也可见）', mob.opacity === 1, String(mob.opacity))
check('手机端三角不挤压布局（宽度仍是 14px 槽位）', mob.w === 14, `${mob.w}px`)
await mobile.close()

check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)

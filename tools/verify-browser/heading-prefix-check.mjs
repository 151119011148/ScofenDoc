/**
 * 标题前缀验收：H1–H6 六级、有序 1/1.1/…/1.1.1.1.1.1、无序 ● ○ ■ □ ◆ ◇、统一蓝色。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   cd tools/verify-browser && node heading-prefix-check.mjs
 *
 * 只跑本地冒烟页，不连后端、不写线上数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/color-tab-smoke.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}
const BLUE = 'rgb(51, 112, 255)'
const HTML =
  '<h1>一级标题</h1><h2>二级标题</h2><h3>三级标题</h3>' +
  '<h4>四级标题</h4><h5>五级标题</h5><h6>六级标题</h6>' +
  '<p>正文段落用于唤起浮动工具条</p>'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 960 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await sleep(200)

const setContent = async (html = HTML) => {
  await page.evaluate((h) => window.ed.commands.setContent(h), html)
  await sleep(220)
}
const numbered = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror [data-number]')].map((el) => ({
      tag: el.tagName,
      num: el.getAttribute('data-number'),
      kind: el.getAttribute('data-number-kind'),
      color: getComputedStyle(el, '::before').color,
      prefixSize: parseFloat(getComputedStyle(el, '::before').fontSize),
      padLeft: parseFloat(getComputedStyle(el).paddingLeft) || 0,
    })),
  )

/* ---------- 1) 六级标题都能建出来 ---------- */
await setContent()
const levels = await page.evaluate(() =>
  [...Array(6)].map((_, i) => {
    const el = document.querySelector(`.ProseMirror h${i + 1}`)
    if (!el) return null
    const cs = getComputedStyle(el)
    return { tag: el.tagName, size: parseFloat(cs.fontSize), weight: cs.fontWeight }
  }),
)
check('H1–H6 六级标题全部存在', levels.every(Boolean), levels.map((l) => l?.tag).join(' '))
check(
  '六级字号逐级递减且都是标题字重',
  levels.every((l, i) => i === 0 || l.size <= levels[i - 1].size) &&
    levels.every((l) => Number(l.weight) >= 600 || l.weight === 'bold'),
  `${levels.map((l) => l?.size).join(' > ')} / ${levels.map((l) => l?.weight).join(',')}`,
)

/* ---------- 2) 有序编号到 6 段 ---------- */
await page.evaluate(() => window.ed.chain().focus().setAllHeadingsNumbered(true, 'ordered').run())
await sleep(250)
const ordered = await numbered()
const EXPECT_ORDERED = ['1.', '1.1.', '1.1.1.', '1.1.1.1.', '1.1.1.1.1.', '1.1.1.1.1.1.']
check('有序编号 6 级到 1.1.1.1.1.1', JSON.stringify(ordered.map((x) => x.num)) === JSON.stringify(EXPECT_ORDERED), ordered.map((x) => x.num).join(' '))
check('有序前缀是品牌蓝', ordered.length === 6 && ordered.every((x) => x.color === BLUE), ordered[0]?.color)
check('有序标题按层级缩进', ordered[1].padLeft > 0 && ordered[5].padLeft > ordered[1].padLeft, `${ordered[1].padLeft} → ${ordered[5].padLeft}`)
const orderedPrefixSize = ordered[0].prefixSize

/* ---------- 3) 无序符号按层级变化 ---------- */
await page.evaluate(() => window.ed.chain().focus().setAllHeadingsNumbered(true, 'unordered').run())
await sleep(250)
const unordered = await numbered()
check('无序符号 ● ○ ■ □ ◆ ◇', JSON.stringify(unordered.map((x) => x.num)) === JSON.stringify(['●', '○', '■', '□', '◆', '◇']), unordered.map((x) => x.num).join(' '))
check('无序前缀同样是品牌蓝', unordered.length === 6 && unordered.every((x) => x.color === BLUE), unordered[0]?.color)
check('装饰标记 data-number-kind=unordered', unordered.every((x) => x.kind === 'unordered'))
check('无序符号比数字略大', unordered[0].prefixSize > orderedPrefixSize, `${orderedPrefixSize} → ${unordered[0].prefixSize}`)

/* ---------- 4) 往返：导出 / 粘贴 / 旧文档兼容 ---------- */
const exported = await page.evaluate(() => window.ed.getHTML())
check('导出 HTML 带 data-numbered-style', exported.includes('data-numbered-style="unordered"'), exported.slice(0, 110))

await setContent('<h2 data-numbered="1" data-numbered-style="unordered">导入标题</h2><p>正文</p>')
const imported = await numbered()
check('粘贴/导入保留无序样式', imported[0]?.num === '○', JSON.stringify(imported[0]))

await setContent('<h2 data-numbered="1">旧标题</h2><p>正文</p>')
const legacy = await numbered()
check('旧文档（无样式标记）默认有序', legacy[0]?.num === '1.' && legacy[0]?.kind === 'ordered', JSON.stringify(legacy[0]))

/* ---------- 5) 单篇切换只影响当前标题 ---------- */
await setContent()
await page.evaluate(() => {
  const ed = window.ed
  ed.chain().focus().setAllHeadingsNumbered(true, 'ordered').run()
  let pos = -1
  ed.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'heading' && node.attrs.level === 3) pos = p + 1
  })
  ed.commands.setTextSelection(pos)
  ed.chain().focus().toggleHeadingNumber(true, 'unordered').run()
})
await sleep(250)
const mixed = await numbered()
check('单篇切无序只改当前标题', mixed[2]?.num === '■' && mixed[1]?.num === '1.1.' && mixed[3]?.num === '1.1.1.1.', mixed.map((x) => x.num).join(' '))

await page.evaluate(() => window.ed.chain().focus().setAllHeadingsNumbered(false).run())
await sleep(250)
const closed = await page.evaluate(() => document.querySelectorAll('.ProseMirror [data-number]').length)
check('关闭前缀后无残留 data-number', closed === 0, String(closed))

/* ---------- 6) 选区标题面板入口 ---------- */
await setContent()
const pbox = await page.evaluate(() => {
  const p = document.querySelector('.ProseMirror p')
  const r = p.getBoundingClientRect()
  return { x: r.left + 6, y: r.top + r.height / 2 }
})
await page.mouse.click(pbox.x, pbox.y)
await sleep(150)
await page.keyboard.down('Shift')
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
await page.keyboard.up('Shift')
await sleep(450)
await page.waitForSelector('.sel-bar', { timeout: 10000 })
// 标题按钮已拆成「主键一键套用 + ▾ 换级别」，打开面板要点 ▾
await page.click('.heading-dd .heading-caret')
await page.waitForSelector('.sel-panel', { timeout: 5000 })
const panel = await page.evaluate(() => ({
  text: document.querySelector('.sel-panel')?.textContent || '',
  items: document.querySelectorAll('.sel-panel .sel-item').length,
}))
check('标题面板有 H1–H6 六级入口', ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].every((k) => panel.text.includes(k)), `${panel.items} 项`)
check('标题面板有有序 / 无序两种前缀', panel.text.includes('标题有序编号') && panel.text.includes('标题无序符号'))

/* ---------- 7) 折叠三角支持六级 ---------- */
const folded = await page.evaluate(() => {
  const ed = window.ed
  ed.commands.setContent('<h1>一级</h1><h2>二级</h2><h3>三级</h3><h4>四级</h4><h5>五级</h5><h6>六级</h6>')
  return [...Array(6)].map((_, i) => !!document.querySelector(`.ProseMirror h${i + 1} .fold-caret`))
})
check('H1–H6 六级都有折叠三角', folded.every(Boolean), folded.join(','))

check('无 JS 报错', errors.length === 0, errors.join(' | '))

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

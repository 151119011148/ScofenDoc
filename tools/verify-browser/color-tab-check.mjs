/**
 * 颜色一键上色 / Tab 两字符缩进 / 标题+有序编号 / 有序列表蓝色序号 的验收。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node color-tab-check.mjs [url]
 *
 * 默认跑本地冒烟页（不连后端、不写线上数据）；也可传线上地址做轻量回归。
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
const RED = '#f54a45'

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
await page.waitForSelector('.ProseMirror ol > li', { timeout: 10000 })
await page.evaluate(() => localStorage.removeItem('scofendoc:lastColor'))
await page.reload({ waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await page.waitForSelector('.ProseMirror ol > li', { timeout: 10000 })
await sleep(200)

/* ---------- 1) 有序列表序号蓝色 ---------- */
const marker = await page.$eval('.ProseMirror ol > li', (el) => ({
  color: getComputedStyle(el, '::marker').color,
  weight: getComputedStyle(el, '::marker').fontWeight,
}))
check('有序列表序号为品牌蓝', marker.color === BLUE, JSON.stringify(marker))
const bodyColor = await page.$eval('.ProseMirror ol > li > p', (el) => getComputedStyle(el).color)
check('列表项正文颜色未被染蓝', bodyColor !== BLUE, bodyColor)

/* ---------- 2) 正文 Tab 空两字符 ---------- */
async function caretIn(text, offset = 1) {
  return page.evaluate(({ text, offset }) => {
    const ed = window.ed
    let pos = -1
    ed.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isTextblock && node.textContent.includes(text)) pos = p + offset
    })
    if (pos < 0) return false
    ed.chain().focus().setTextSelection(pos).run()
    return true
  }, { text, offset })
}
async function textOf(text) {
  return page.evaluate((text) => {
    let out = ''
    window.ed.state.doc.descendants((node) => {
      if (!out && node.isTextblock && node.textContent.includes(text)) out = node.textContent
    })
    return out
  }, text)
}

await caretIn('正文一段')
await page.keyboard.press('Tab')
await sleep(120)
const tabbed = await textOf('正文一段')
check('Tab 插入两个全角空格（＝两个中文字符）', tabbed.startsWith('\u3000\u3000正文'), JSON.stringify(tabbed.slice(0, 8)))
await page.keyboard.down('Shift')
await page.keyboard.press('Tab')
await page.keyboard.up('Shift')
await sleep(120)
const untabbed = await textOf('正文一段')
check('Shift+Tab 回退这两格', untabbed === '正文一段，用来测试颜色与 Tab 缩进。', JSON.stringify(untabbed))

/* 列表里的 Tab 仍走层级缩进，不能被插空格抢走 */
await caretIn('列表项二')
await page.keyboard.press('Tab')
await sleep(150)
const listState = await page.evaluate(() => ({
  nested: /<ol>[\s\S]*<ol>/.test(window.ed.getHTML()),
  fullWidth: window.ed.getHTML().includes('\u3000'),
}))
check('列表内 Tab 保持层级缩进、不插全角空格', listState.nested && !listState.fullWidth, JSON.stringify(listState))

/* 代码块里的 Tab 用等宽的两格 */
await caretIn('const a = 1')
await page.keyboard.press('Tab')
await sleep(120)
const codeText = await textOf('const a = 1')
check('代码块 Tab 插两个半角空格', codeText.startsWith('  const a = 1'), JSON.stringify(codeText.slice(0, 8)))

/* ---------- 3) 标题 + 有序编号 ---------- */
await page.evaluate(() => {
  const ed = window.ed
  ed.commands.setContent('<h1>第一章</h1><h2>小节 A</h2><h2>小节 B</h2><h3>细项</h3><p>正文一段</p>')
  ed.commands.setAllHeadingsNumbered(true)
})
await sleep(180)
const nums = await page.$$eval('.ProseMirror [data-number]', (els) => els.map((e) => e.getAttribute('data-number')))
check('标题带 1 / 1.1 / 1.2 / 1.2.1 有序编号', JSON.stringify(nums) === JSON.stringify(['1.', '1.1.', '1.2.', '1.2.1.']), JSON.stringify(nums))
const numColor = await page.$eval('.ProseMirror h1[data-number]', (el) => getComputedStyle(el, '::before').color)
check('编号标题序号同为品牌蓝', numColor === BLUE, numColor)

/* 有序列表项里点「编号标题」：修复前命令返回成功却毫无变化；
   ListItemHeading 放宽 schema 后就地升成 H1 并留在列表里，
   蓝色 1. 由 ::marker 提供，标题本身不再重复显示第二套前缀。 */
await page.evaluate(() => {
  const ed = window.ed
  ed.commands.setContent('<h1>第一章</h1><ol><li><p>列表项一</p></li><li><p>列表项二</p></li></ol>')
  let pos = -1
  ed.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent === '列表项一') pos = p + 1
  })
  ed.commands.setTextSelection(pos)
  ed.chain().focus().toggleHeadingNumber(true).run()
})
await sleep(150)
const promoted = await page.evaluate(() => {
  const h = [...document.querySelectorAll('.ProseMirror li > h1')].find((el) => el.textContent.includes('列表项一'))
  return {
    tag: h?.tagName || '',
    inList: !!h?.closest('li'),
    numbered: h?.getAttribute('data-numbered') || '',
    html: window.ed.getHTML(),
  }
})
check('列表项点「编号标题」就地升为 H1 且保留列表', promoted.tag === 'H1' && promoted.inList && promoted.numbered === '1', JSON.stringify(promoted))

/* ---------- 4) 颜色：先选一次，之后单击 A 一步上色 ---------- */
async function dragSelect(text, width = 70) {
  // 上一轮的工具条可能正盖在下一段上（选区靠页顶时面板向下展开），
  // 不先收起的话 mousedown 会落在工具条上，选区根本不会换。
  await page.keyboard.press('Escape')
  await sleep(80)
  const box = await page.evaluate((text) => {
    const p = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.includes(text))
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { x: r.left + 2, y: r.top + r.height / 2 }
  }, text)
  if (!box) return ''
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x + width, box.y, { steps: 10 })
  await page.mouse.up()
  await sleep(320)
  return page.evaluate(() => window.getSelection()?.toString() || '')
}

await page.evaluate(() => {
  window.ed.commands.setContent('<p>第一段文字用来选颜色</p><p>第二段文字验证一键上色</p>')
})
await sleep(150)
const sel1 = await dragSelect('第一段文字用来选颜色')
check('拖选能唤起浮动工具条', !!sel1 && !!(await page.$('.sel-bar')), JSON.stringify(sel1))

await page.click('.color-caret')
await page.waitForSelector('.sel-colors-grid .swatch', { timeout: 5000 })
const swatches = await page.$$eval('.sel-colors-grid .swatch', (els) => els.length)
check('色板为 8 色 + 恢复默认', swatches === 8 && !!(await page.$('.sel-colors-reset')), `色块 ${swatches}`)
await page.click('.sel-colors-grid .swatch:nth-child(1)')
await sleep(220)
const stored = await page.evaluate(() => localStorage.getItem('scofendoc:lastColor'))
check('选色写入记忆色', stored === RED, String(stored))

const sel2 = await dragSelect('第二段文字验证一键上色')
check('第二次拖选也弹出工具条', !!sel2 && !!(await page.$('.sel-bar')), JSON.stringify(sel2))
const cbar = await page.$eval('.cbar', (el) => getComputedStyle(el).backgroundColor)
check('A 下面横线显示上次选的颜色', cbar === 'rgb(245, 74, 69)', cbar)
const title = await page.$eval('.color-dd > button:first-child', (el) => el.getAttribute('title'))
check('A 按钮提示可直接复用上次颜色', !!title && title.includes('单击应用上次颜色'), String(title))

await page.click('.color-dd > button:first-child')
await sleep(220)
const colored = await page.evaluate(() => {
  const p = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.includes('第二段文字验证一键上色'))
  return {
    styles: p ? [...p.querySelectorAll('[style*="color"]')].map((s) => s.getAttribute('style')) : [],
    panelOpen: !!document.querySelector('.sel-colors'),
  }
})
check('单击 A 一步上色（无需再开色板）', colored.styles.some((s) => s && (/245,\s*74,\s*69/i.test(s) || s.toLowerCase().includes('#f54a45'))) && !colored.panelOpen, JSON.stringify(colored))

/* 恢复默认要顺手清掉记忆色：换一段全新内容再选，保证工具条重新弹出 */
await page.evaluate(() => {
  window.ed.commands.setContent('<p>第三段文字用来恢复默认</p><p>第四段文字占位</p>')
})
await sleep(150)
await dragSelect('第三段文字用来恢复默认')
await page.waitForSelector('.color-caret', { timeout: 5000 })
await page.click('.color-caret')
await page.waitForSelector('.sel-colors-reset')
await page.click('.sel-colors-reset')
await sleep(180)
const cleared = await page.evaluate(() => localStorage.getItem('scofendoc:lastColor'))
check('恢复默认清除记忆色', cleared === null, String(cleared))

check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} 通过`)
await browser.close()
process.exit(passed === results.length ? 0 : 1)

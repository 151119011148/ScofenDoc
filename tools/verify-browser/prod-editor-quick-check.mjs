/**
 * 线上编辑器验收（只读，不新增/修改任何文档内容）。
 *
 *   node prod-editor-quick-check.mjs <JWT_SECRET> [baseUrl]
 *
 * 覆盖：新前端已加载、颜色按钮拆分与色板、顶部 № 入口、有序列表序号蓝色、
 *       以及页面无 JS 报错。会拖选正文以唤起浮动工具条，但不会点击任何改色命令。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const BASE = process.argv[3] || 'http://47.117.110.143/scofendoc/'
if (!secret) {
  console.error('用法: node prod-editor-quick-check.mjs <JWT_SECRET> [baseUrl]')
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
const BLUE = 'rgb(51, 112, 255)'

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

/* 打开一篇三层文档，确保协同正文渲染出来 */
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row')]
    .find((r) => r.querySelector('.tree-no')?.textContent.trim() === '1.1.1')
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForSelector('.ProseMirror p', { timeout: 30000 })
await sleep(1800)

const base = await page.evaluate(() => ({
  paragraphs: [...document.querySelectorAll('.ProseMirror p')].filter((p) => p.textContent.trim().length > 8).length,
  numTitle: document.querySelector('.num-main')?.getAttribute('title') || '',
  entryJS: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).join(','),
}))
check('线上正文已加载', base.paragraphs > 0, `可用段落 ${base.paragraphs}`)
check('顶部 № 入口标明「标题 + 有序编号」', base.numTitle.includes('标题 + 有序编号'), base.numTitle)
check('已加载本次构建产物', /\/scofendoc\/assets\/index-/.test(base.entryJS), base.entryJS.slice(0, 90))

/* 有序列表序号颜色：造一个离屏 .ProseMirror ol 量 ::marker，不动文档数据 */
const marker = await page.evaluate(() => {
  const box = document.createElement('div')
  box.className = 'ProseMirror'
  box.style.cssText = 'position:absolute;left:-9999px;top:0'
  box.innerHTML = '<ol><li><p>x</p></li></ol>'
  document.body.appendChild(box)
  const li = box.querySelector('li')
  const out = { color: getComputedStyle(li, '::marker').color, text: getComputedStyle(box.querySelector('p')).color }
  box.remove()
  return out
})
check('有序列表序号为品牌蓝', marker.color === BLUE, JSON.stringify(marker))
check('列表项正文颜色未变', marker.text !== BLUE, marker.text)

/* 拖选唤起浮动工具条，检查颜色按钮的拆分结构（不点击任何改色命令） */
const box = await page.evaluate(() => {
  const ps = [...document.querySelectorAll('.ProseMirror p')].filter((el) => el.textContent.trim().length > 8)
  const visible = ps.find((el) => {
    const r = el.getBoundingClientRect()
    return r.top > 130 && r.bottom < window.innerHeight - 90 && r.left > 0
  })
  const p = visible || ps[0]
  if (!p) return null
  if (!visible) p.scrollIntoView({ block: 'center' })
  const r = p.getBoundingClientRect()
  return { x: r.left + 6, y: r.top + r.height / 2, text: p.textContent.slice(0, 18), visible: !!visible }
})
await sleep(200)
/* 键盘选择（Shift+→）比鼠标拖选稳：长文档首屏常有表格/图片，拖选容易落在空白区 */
await page.mouse.click(box.x + 40, box.y)
await sleep(150)
await page.keyboard.down('Shift')
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
await page.keyboard.up('Shift')
await sleep(450)
const diag = await page.evaluate(() => ({
  selected: window.getSelection()?.toString() || '',
  bar: !!document.querySelector('.sel-bar'),
  editable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
}))
console.log('  选择诊断:', JSON.stringify({ box, ...diag }))
await page.waitForSelector('.sel-bar', { timeout: 10000 })
await sleep(250)

const bar = await page.evaluate(() => ({
  split: !!document.querySelector('.color-dd'),
  main: !!document.querySelector('.color-dd > button:first-child'),
  caret: !!document.querySelector('.color-caret'),
  cbar: document.querySelector('.cbar') ? getComputedStyle(document.querySelector('.cbar')).backgroundColor : '',
  title: document.querySelector('.color-dd > button:first-child')?.getAttribute('title') || '',
}))
check('颜色按钮拆成「A 一键上色」+「▾ 换色」', bar.split && bar.main && bar.caret, JSON.stringify(bar))
check('A 下面有颜色横线', !!bar.cbar, bar.cbar)
check('A 按钮提示一键复用上次颜色', bar.title.includes('单击应用上次颜色') || bar.title.includes('字体颜色'), bar.title)

await page.click('.color-caret')
await page.waitForSelector('.sel-colors-grid .swatch', { timeout: 5000 })
const palette = await page.evaluate(() => ({
  swatches: document.querySelectorAll('.sel-colors-grid .swatch').length,
  reset: !!document.querySelector('.sel-colors-reset'),
  title: document.querySelector('.sel-colors-title')?.textContent.trim() || '',
}))
check('色板为「字体颜色」8 色 + 恢复默认', palette.swatches === 8 && palette.reset && palette.title === '字体颜色', JSON.stringify(palette))
await page.keyboard.press('Escape')

check('无 JS 运行时报错 / 资源 4xx', errors.length === 0, errors.slice(0, 3).join(' | '))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} 通过`)
await browser.close()
process.exit(passed === results.length ? 0 : 1)

/**
 * 线上大纲验收（只读，不改任何文档内容）。
 *
 *   node prod-outline-check.mjs <JWT_SECRET> [baseUrl]
 *
 * 覆盖：新前端已上线（大纲工具条存在）、大纲层级缩进、撤销按钮初始不可用、
 *       条目数与正文标题数一致、页面无 JS 报错。不点击任何会改正文的按钮。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const BASE = process.argv[3] || 'http://47.117.110.143/scofendoc/'
if (!secret) {
  console.error('用法: node prod-outline-check.mjs <JWT_SECRET> [baseUrl]')
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

await page.goto(`${BASE}?space=2&doc=22`, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem(
    'scofendoc.user',
    JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
  )
}, token)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.tree-row .tree-no', { timeout: 30000 })
await page.waitForSelector('.outline-item', { timeout: 30000 })
await sleep(1200)

const st = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.outline-item')]
  const tools = [...document.querySelectorAll('.ot-btn')]
  return {
    tools: tools.map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, title: b.title })),
    itemCount: items.length,
    levels: items.map((li) => (li.className.match(/lvl-\d/) || [''])[0]),
    texts: items.slice(0, 3).map((li) => li.querySelector('.outline-text')?.textContent?.trim() || ''),
    acts: document.querySelectorAll('.outline-act').length,
    headCount: document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').length,
    hint: document.querySelectorAll('.outline-toast').length,
  }
})

check('新前端已上线：大纲出现「撤销 / 重做」', st.tools.length === 2 && /撤销/.test(st.tools[0].text) && /重做/.test(st.tools[1].text), st.tools.map((t) => t.text).join(' | '))
check('刚打开文档时两步都不可用', st.tools[0]?.disabled === true && st.tools[1]?.disabled === true)
check('大纲条目已渲染且缩进分级正确', st.itemCount > 3 && st.levels.every((c) => /^lvl-[1-6]$/.test(c)), `${st.itemCount} ${st.levels.slice(0, 6).join('/')}`)
check('每条都有层级按钮', st.acts === st.itemCount * 2, `${st.acts}/${st.itemCount}`)
check('大纲条目不超出正文标题数', st.itemCount <= st.headCount, `${st.itemCount}/${st.headCount}`)
check('没有残留的操作提示', st.hint === 0)
check('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

await page.screenshot({ path: '/tmp/prod-outline.png' })
await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)

/**
 * 线上大纲验收（只读，不改任何文档内容）。
 *
 *   node prod-outline-check.mjs <JWT_SECRET> [baseUrl]
 *
 * 覆盖：新前端已上线（撤销按钮已移除、折叠三角存在）、大纲层级缩进、
 *       折叠/展开可用且不改正文、条目数与正文标题数一致、页面无 JS 报错。
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

// 562「架构 - 学习资料」：91 个标题、H1/H2/H3/H4 都有，才验得出折叠
await page.goto(`${BASE}?space=2&doc=562`, { waitUntil: 'domcontentloaded' })
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
  return {
    tools: document.querySelectorAll('.ot-btn').length,
    itemCount: items.length,
    levels: items.map((li) => (li.className.match(/lvl-\d/) || [''])[0]),
    texts: items.slice(0, 3).map((li) => li.querySelector('.outline-text')?.textContent?.trim() || ''),
    acts: document.querySelectorAll('.outline-act').length,
    carets: document.querySelectorAll('.outline-caret').length,
    headCount: document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').length,
    hint: document.querySelectorAll('.outline-toast').length,
  }
})

check('新前端已上线：撤销 / 重做按钮已移除（只留快捷键）', st.tools === 0, String(st.tools))
check('大纲条目已渲染且缩进分级正确', st.itemCount > 3 && st.levels.every((c) => /^lvl-[1-6]$/.test(c)), `${st.itemCount} ${st.levels.slice(0, 6).join('/')}`)
check('每条都有层级按钮', st.acts === st.itemCount * 2, `${st.acts}/${st.itemCount}`)
check('带子级的条目有折叠三角（不是每条都有）', st.carets > 0 && st.carets < st.itemCount, `${st.carets}/${st.itemCount}`)
check('大纲条目不超出正文标题数', st.itemCount <= st.headCount, `${st.itemCount}/${st.headCount}`)
check('没有残留的操作提示', st.hint === 0)

// 正文标题里有个 HeadingFold 注入的折叠三角（span.fold-caret，真实 DOM 子节点），
// 它不该被 textContent 带进大纲文字里
const caretLeak = await page.evaluate(() => ({
  widgets: document.querySelectorAll('.ProseMirror h1 .fold-caret, .ProseMirror h2 .fold-caret, .ProseMirror h3 .fold-caret').length,
  polluted: [...document.querySelectorAll('.outline-text')].filter((e) => /[▸▾]/.test(e.textContent)).length,
}))
check('大纲文字里没有正文折叠三角', caretLeak.widgets > 0 && caretLeak.polluted === 0, `${caretLeak.widgets}/${caretLeak.polluted}`)

// 折叠只改目录、不动正文：展开/收起后正文标题数必须一致
const foldBefore = await page.evaluate(() => {
  const li = [...document.querySelectorAll('.outline-item')].find((x) => x.querySelector('.outline-caret'))
  if (!li) return null
  const before = {
    items: document.querySelectorAll('.outline-item').length,
    heads: document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').length,
  }
  li.querySelector('.outline-caret').click()
  return before
})
await sleep(400)
const foldAfter = await page.evaluate(() => ({
  items: document.querySelectorAll('.outline-item').length,
  heads: document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').length,
  folded: document.querySelectorAll('.outline-item.folded').length,
  caretAlways: [...document.querySelectorAll('.outline-item.folded > .outline-caret')].every((c) => Number(getComputedStyle(c).opacity) === 1),
}))
check('点三角能折叠：条目变少、正文不变', !!foldBefore && foldAfter.items < foldBefore.items && foldAfter.heads === foldBefore.heads, `${foldBefore?.items}→${foldAfter.items} 正文 ${foldBefore?.heads}/${foldAfter.heads}`)
check('折叠后三角常驻显示', foldAfter.folded === 1 && foldAfter.caretAlways, `${foldAfter.folded} ${foldAfter.caretAlways}`)

// 展开还原，不给下次访问留下折叠态
await page.evaluate(() => {
  document.querySelector('.outline-item.folded > .outline-caret')?.click()
})
await sleep(400)
const restored = await page.evaluate(() => ({
  items: document.querySelectorAll('.outline-item').length,
  folded: document.querySelectorAll('.outline-item.folded').length,
}))
check('再点一次展开、回到原条目数', !!foldBefore && restored.items === foldBefore.items && restored.folded === 0, `${restored.items}/${foldBefore?.items}`)
check('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

await page.screenshot({ path: '/tmp/prod-outline.png' })
await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)

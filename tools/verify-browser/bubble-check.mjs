import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * 选中文字浮动工具条验收：
 *  - 选区一出现，.sel-bar 是否弹出、按钮是否齐全
 *  - 加粗 / 字体颜色 / 标题下拉 / 评论 是否真的写入正文
 *  - 刷新后批注锚点与评论内容是否还在（验证 ydoc 的 comments Map 落盘）
 *
 * 全程在临时文档里操作，跑完删除该文档。
 * 用法：node bubble-check.mjs <JWT_SECRET>
 */

const secret = process.argv[2]
if (!secret) {
  console.error('用法：node bubble-check.mjs <JWT_SECRET>')
  process.exit(1)
}

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '60m' },
)

const ORIGIN = 'http://47.117.110.143'
const BASE = `${ORIGIN}/scofendoc/`
const API = `${ORIGIN}/scofendoc/api`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

// 1) 建临时文档
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.evaluate(
  (t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem(
      'scofendoc.user',
      JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
    )
  },
  token,
)
const created = await page.evaluate(
  async (api, tk) => {
    const r = await fetch(`${api}/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ workspaceId: 2, parentId: null, title: '【临时】选区工具条验收' }),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  },
  API,
  token,
)
out.created = created
const doc = created.body
if (!doc?.id) {
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
  process.exit(1)
}

// 2) 打开并输入三段测试文本
await page.goto(`${BASE}?space=2&doc=${doc.id}`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(1200)
await page.click('.ProseMirror')
await page.keyboard.type('甲段落 测试加粗文字')
await page.keyboard.press('Enter')
await page.keyboard.type('乙段落 测试评论文字')
await page.keyboard.press('Enter')
await page.keyboard.type('丙段落 测试标题转换')
await page.keyboard.press('Enter')
await page.keyboard.type('丁段落 测试链接文字')
await sleep(600)

async function selectText(needle) {
  return page.evaluate((n) => {
    const root = document.querySelector('.ProseMirror')
    if (!root) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf(n)
      if (i >= 0) {
        const r = document.createRange()
        r.setStart(node, i)
        r.setEnd(node, i + n.length)
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(r)
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
    }
    return false
  }, needle)
}

// 3) 选中 → 工具条是否出现
out.selected = await selectText('测试加粗')
try {
  await page.waitForSelector('.sel-bar', { timeout: 4000 })
  out.barVisible = true
} catch {
  out.barVisible = false
}
out.barButtons = await page.$$eval('.sel-bar button', (els) => els.map((e) => e.getAttribute('title') || e.textContent.trim()))
out.barRect = await page.$eval('.sel-bar', (el) => {
  const r = el.getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
})
await page.screenshot({ path: 'bubble-1-bar.png', clip: { x: 0, y: Math.max(0, out.barRect.top - 160), width: 1200, height: 420 } })

// 4) 加粗
await page.click('.sel-bar button[title^="加粗"]')
await sleep(300)
out.boldApplied = await page.$$eval('.ProseMirror strong', (els) => els.map((e) => e.textContent))

// 5) 字体颜色：选中未加粗的「甲段落」
await selectText('甲段落')
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title="字体颜色"]')
await page.waitForSelector('.sel-panel.sel-colors', { timeout: 3000 })
await page.screenshot({ path: 'bubble-2-color.png', clip: { x: 0, y: Math.max(0, out.barRect.top - 160), width: 900, height: 460 } })
await page.evaluate(() => {
  const swatches = document.querySelectorAll('.sel-panel.sel-colors .swatch')
  swatches[5]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(300)
out.colorApplied = await page.$$eval('.ProseMirror span[style*="color"]', (els) =>
  els.map((e) => ({ text: e.textContent, style: e.getAttribute('style') })),
)

// 5.5) 下划线：选中「甲段落」再点 U
await selectText('甲段落')
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title^="下划线"]')
await sleep(250)
out.underlineApplied = await page.$$eval('.ProseMirror u', (els) => els.map((e) => e.textContent))

// 5.6) 链接：选中「测试链接」→ 输入 URL
await selectText('测试链接')
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title="链接"]')
await page.waitForSelector('.sel-panel.sel-link input', { timeout: 3000 })
await page.type('.sel-panel.sel-link input', 'example.com', { delay: 8 })
await page.screenshot({ path: 'bubble-6-link.png', clip: { x: 0, y: Math.max(0, out.barRect.top - 160), width: 1000, height: 460 } })
await page.click('.sel-panel.sel-link .sel-primary')
await sleep(300)
out.linkApplied = await page.$$eval('.ProseMirror a', (els) => els.map((e) => ({ text: e.textContent, href: e.getAttribute('href') })))

// 6) 标题下拉：选中「丙段落」→ 二级标题
await selectText('丙段落')
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title="标题"]')
await page.waitForSelector('.sel-panel', { timeout: 3000 })
await page.screenshot({ path: 'bubble-3-heading.png', clip: { x: 0, y: Math.max(0, out.barRect.top - 160), width: 900, height: 480 } })
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.sel-panel .sel-item')]
  items.find((b) => b.textContent.includes('二级标题'))?.click()
})
await sleep(400)
out.headings = await page.$$eval('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3', (els) =>
  els.map((e) => `${e.tagName}:${e.textContent}`),
)

// 7) 评论：选中「测试评论」→ 写评论
await selectText('测试评论')
await page.waitForSelector('.sel-bar', { timeout: 4000 })
await page.click('.sel-bar button[title="评论"]')
await page.waitForSelector('.sel-panel.sel-comment textarea', { timeout: 3000 })
await page.type('.sel-panel.sel-comment textarea', '这是一条自动化验收评论', { delay: 8 })
await page.screenshot({ path: 'bubble-4-comment.png', clip: { x: 0, y: Math.max(0, out.barRect.top - 160), width: 1000, height: 520 } })
await page.click('.sel-panel.sel-comment .sel-primary')
await sleep(600)
out.commentMark = await page.$$eval('.ProseMirror mark.cmt-mark', (els) =>
  els.map((e) => ({ text: e.textContent, id: e.getAttribute('data-comment-id') })),
)

// 8) 刷新后是否还在（正文 mark + 评论 Map 落盘）
await page.reload({ waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror mark.cmt-mark', { timeout: 30000 })
await sleep(800)
await page.click('.ProseMirror mark.cmt-mark')
await page.waitForSelector('.cmt-pop', { timeout: 4000 })
out.commentAfterReload = await page.$eval('.cmt-pop', (el) => el.innerText.replace(/\s+/g, ' ').trim())
out.commentPersisted = out.commentAfterReload.includes('自动化验收评论')
await page.screenshot({ path: 'bubble-5-thread.png', clip: { x: 0, y: 200, width: 1200, height: 520 } })

// 8.5) 评论回复 / 标记已解决 / 删除
await page.type('.cmt-reply-box input', '收到，稍后改', { delay: 8 })
await page.click('.cmt-reply-box button')
await sleep(400)
out.replyShown = await page.$eval('.cmt-pop', (el) => el.innerText.includes('收到，稍后改'))
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.cmt-actions button')].find((x) => x.textContent.includes('标记已解决'))
  b?.click()
})
await sleep(400)
out.resolvedAttr = await page.$eval('.ProseMirror mark.cmt-mark', (el) => el.getAttribute('data-resolved'))
await page.screenshot({ path: 'bubble-7-resolved.png', clip: { x: 560, y: 150, width: 640, height: 460 } })
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.cmt-actions button')].find((x) => x.textContent.includes('重新打开'))
  b?.click()
})
await sleep(300)
out.reopenedAttr = await page.$eval('.ProseMirror mark.cmt-mark', (el) => el.getAttribute('data-resolved'))
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.cmt-actions button')].find((x) => x.textContent.includes('删除'))
  b?.click()
})
await sleep(400)
out.marksAfterDelete = await page.$$eval('.ProseMirror mark.cmt-mark', (els) => els.length)

out.errors = errors.slice(0, 6)
console.log(JSON.stringify(out, null, 2))

// 9) 清理：软删临时文档
await page.evaluate(
  async (api, tk, id) => {
    await fetch(`${api}/docs/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tk}` } })
  },
  API,
  token,
  doc.id,
)

await browser.close()

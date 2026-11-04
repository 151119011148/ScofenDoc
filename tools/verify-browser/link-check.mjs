/**
 * 外链点击验收：正文里的 http(s) 链接必须真的打开新标签。
 *
 * 背景：浏览器不会在 contenteditable 里激活 <a> 的默认跳转，Link 扩展又配了
 * openOnClick:false，所以编辑器必须自己 window.open —— 否则「CSDN 原文」点了没反应。
 *
 * 用法: node link-check.mjs <JWT_SECRET> [docId] [spaceId]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const docId = process.argv[3] || '19'
const spaceId = process.argv[4] || '2'
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '60m' },
)
const ORIGIN = 'http://47.117.110.143'
const BASE = `${ORIGIN}/scofendoc/`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
})

/* 拦掉真实跳转，只记录 window.open 的调用，避免验收时把浏览器开满 */
const page = await browser.newPage()
await page.evaluateOnNewDocument(() => {
  window.__opened = []
  const raw = window.open
  window.open = function (url, target, feat) {
    window.__opened.push({ url: String(url), target: String(target), feat: String(feat) })
    return null
  }
  window.__rawOpen = raw
})
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem(
    'scofendoc.user',
    JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
  )
}, token)
await page.goto(`${BASE}?space=${spaceId}&doc=${docId}`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(1500)

/* 1) 外链存在 */
const anchors = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  return [...pm.querySelectorAll('a')].map((a) => ({
    href: a.getAttribute('href') || '',
    text: (a.textContent || '').slice(0, 20),
  }))
})
const ext = anchors.filter((a) => /^https?:/i.test(a.href) && !a.href.includes('doc='))
check('正文里有外链可点', ext.length > 0, `共 ${ext.length} 个，如「${ext[0]?.text}」`)

/* 2) 点外链 → 触发新标签 */
const extBox = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const a = [...pm.querySelectorAll('a')].find(
    (x) => /^https?:/i.test(x.getAttribute('href') || '') && !(x.getAttribute('href') || '').includes('doc='),
  )
  if (!a) return null
  a.scrollIntoView({ block: 'center' })
  const r = a.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: a.getAttribute('href') }
})
await page.mouse.click(extBox.x, extBox.y)
await sleep(600)
const opened = await page.evaluate(() => window.__opened)
check(
  '点外链打开新标签',
  opened.length === 1 && opened[0].url === extBox.href,
  `${opened.length} 次 → ${opened[0]?.url || '无'}`,
)
check('外链用 _blank + noopener', opened[0]?.target === '_blank' && /noopener/.test(opened[0]?.feat || ''))

const stayed = page.url()
check('编辑器本身没被顶走', stayed.includes('doc=' + docId), stayed)

/* 3) 站内链接仍然只切文档，不开新标签 */
await page.evaluate(() => {
  window.__opened = []
})
const innerBox = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const a = [...pm.querySelectorAll('a')].find((x) => (x.getAttribute('href') || '').includes('doc='))
  if (!a) return null
  a.scrollIntoView({ block: 'center' })
  const r = a.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: a.getAttribute('href') }
})
if (!innerBox) {
  check('正文里有站内链接', false)
} else {
  await page.mouse.click(innerBox.x, innerBox.y)
  await sleep(1600)
  const openedAfter = await page.evaluate(() => window.__opened)
  check('点站内链接不开新标签', openedAfter.length === 0, `window.open 调用 ${openedAfter.length} 次`)
  check('点站内链接切到了目标文档', page.url() !== stayed, page.url())
}

console.log('')
const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `${bad.length} 项失败` : '全部通过')
await browser.close()
process.exit(bad.length ? 1 : 0)

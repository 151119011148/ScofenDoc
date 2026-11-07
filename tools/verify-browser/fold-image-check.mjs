/**
 * 标题折叠时，小节里的配图必须一起收起来（回归：`.ProseMirror img` 的 display:block
 * 权重高过单个 `.fold-hidden`，曾导致折起小节后图片仍留在页面上）。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5391 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/fold-image-check.mjs [url]
 *
 * 只跑本地冒烟页，不连后端、不写线上数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5391/fold-image-smoke.html'
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
  defaultViewport: { width: 1280, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 300))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await page.waitForSelector('.ProseMirror img', { timeout: 10000 })
await sleep(500)

/** 每张图：是否带 fold-hidden、computed display、可见尺寸 */
const imgs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror img')].map((img) => {
      const r = img.getBoundingClientRect()
      const cs = getComputedStyle(img)
      return {
        alt: img.getAttribute('alt') || '',
        hiddenCls: img.classList.contains('fold-hidden'),
        display: cs.display,
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    }))

const visible = (list) => list.filter((i) => i.display !== 'none' && i.w > 0 && i.h > 0)

/* ---------- 折叠前 ---------- */
const before = await imgs()
check('冒烟页有 3 张配图且初始全部可见', before.length === 3 && visible(before).length === 3, JSON.stringify(before))

/** 点标题三角（HeadingFold 的 widget 监听 mousedown） */
const clickCaret = async (text) => {
  const ok = await page.evaluate((t) => {
    const h = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3')]
      .find((e) => (e.textContent || '').includes(t))
    const c = h?.querySelector('.fold-caret')
    if (!c) return false
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return true
  }, text)
  await sleep(450)
  return ok
}

/* ---------- 折叠一级小节 ---------- */
check('能点到「一、需要折叠的小节」的折叠三角', await clickCaret('一、需要折叠的小节'))
const folded = await imgs()
const secImgs = folded.filter((i) => i.alt === '示意图' || i.alt === '子图')
check(
  '折起后小节内的图片带 fold-hidden 类',
  secImgs.length === 2 && secImgs.every((i) => i.hiddenCls),
  JSON.stringify(secImgs),
)
check(
  '折起后小节内的图片 display:none（不再以 block 留在页面上）',
  secImgs.length === 2 && secImgs.every((i) => i.display === 'none'),
  JSON.stringify(secImgs),
)
check(
  '折起后小节内的图片不可见（占位尺寸为 0）',
  secImgs.length === 2 && secImgs.every((i) => i.w === 0 && i.h === 0),
  JSON.stringify(secImgs.map((i) => `${i.alt}:${i.w}x${i.h}`)),
)
const after = folded.find((i) => i.alt === '另一节的图')
check('同页其他小节的图片不受影响', !!after && after.display !== 'none' && after.w > 0, JSON.stringify(after))

/* 正文段落也一起收起来（真回归点：图片和文字要一起消失） */
const body = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const p = [...pm.querySelectorAll('p')].find((e) => e.textContent.includes('小节正文第一段'))
  const sub = [...pm.querySelectorAll('p')].find((e) => e.textContent.includes('子小节正文'))
  return [p, sub].map((el) => (el ? getComputedStyle(el).display : null))
})
check('折起后小节内段落同样是 display:none', body.every((d) => d === 'none'), JSON.stringify(body))

/* ---------- 展开还原 ---------- */
check('能点回三角展开', await clickCaret('一、需要折叠的小节'))
const unfolded = await imgs()
check('展开后 3 张图全部恢复可见', visible(unfolded).length === 3 && unfolded.every((i) => !i.hiddenCls),
  JSON.stringify(unfolded.map((i) => `${i.alt}:${i.display}/${i.w}x${i.h}`)))

/* ---------- 只读回归 ---------- */
check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n结果：${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

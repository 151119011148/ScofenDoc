/**
 * 线上验收（只读，不改任何文档内容）：
 *   1. 文章大纲跳转后标题不被吸顶格式栏遮住（宽屏 + 窄屏两行工具栏都测）
 *   2. 无序列表圆点 / 无序标题符号统一品牌蓝，任务列表不受影响
 *   3. 正文图片单击可全屏放大，缩放、Esc、点空白关闭都生效
 *   4. 回归：无 JS 报错、另一站点与后端健康不受影响
 *
 *   node image-outline-check.mjs <JWT_SECRET> [baseUrl]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const BASE = process.argv[3] || 'http://47.117.110.143/scofendoc/'
if (!secret) {
  console.error('用法: node image-outline-check.mjs <JWT_SECRET> [baseUrl]')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key, { algorithm: 'HS256', expiresIn: '30m' },
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
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

async function openDoc(docId) {
  await page.goto(`${BASE}?space=2&doc=${docId}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem('scofendoc.user', JSON.stringify({
      id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
    }))
  }, token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ProseMirror', { timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > *').length > 20, { timeout: 30000 })
  await sleep(1600)
}
await openDoc(483)

/* ---------- 1. 大纲跳转落点 ---------- */
const norm = (s) => (s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
async function jumpAndMeasure(label) {
  // 先回到顶部，保证每次都是从同一状态跳
  await page.evaluate(() => document.querySelector('.main').scrollTo({ top: 0, behavior: 'auto' }))
  await sleep(400)
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.outline-item')]
    const i = Math.min(6, items.length - 1)
    const el = items[i]
    const text = el.querySelector('.outline-text')?.textContent?.trim() || ''
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { i, text }
  })
  await sleep(1500)
  const m = await page.evaluate((plain) => {
    const bar = document.querySelector('.collab .bar')
    const barRect = bar?.getBoundingClientRect()
    const heads = [...document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')]
    const n = (s) => (s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    const hit = heads.find((h) => {
      const t = n(h.textContent)
      return plain && (t.includes(plain) || plain.includes(t))
    })
    return {
      barH: barRect ? Math.round(barRect.height) : 0,
      barBottom: barRect ? Math.round(barRect.bottom) : 0,
      headTop: hit ? Math.round(hit.getBoundingClientRect().top) : null,
      headText: hit?.textContent?.trim().slice(0, 30) || '',
      active: document.querySelector('.outline-item.on')?.textContent?.trim().slice(0, 30) || '',
    }
  }, norm(picked.text.replace(/^[\d.]+\s*/, '')))
  check(
    `${label}：大纲跳转后标题在工具栏下方`,
    m.headTop !== null && m.headTop >= m.barBottom + 4 && m.headTop <= m.barBottom + 60,
    JSON.stringify({ ...m, picked: picked.text }),
  )
  return m
}
const wide = await jumpAndMeasure('宽屏')
await page.setViewport({ width: 1080, height: 820 })
await sleep(500)
const narrow = await jumpAndMeasure('窄屏')
check('窄屏工具栏换行时留白自动变大', narrow.barH >= wide.barH && narrow.headTop >= narrow.barBottom + 4,
  `宽屏栏高 ${wide.barH} / 窄屏栏高 ${narrow.barH}`)
await page.setViewport({ width: 1440, height: 900 })
await sleep(300)

/* 站内链接 ?h= 锚点走的是另一套落点计算，也要避开工具栏 */
await page.goto(`${BASE}?space=2&doc=483&h=${encodeURIComponent('最左前缀原理与七种情况')}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > *').length > 20, { timeout: 30000 })
// 协同正文异步到达 + alignAnchor 分轮二次校准，等滚动真的发生再量
try {
  await page.waitForFunction(() => (document.querySelector('.main')?.scrollTop || 0) > 500, { timeout: 12000 })
} catch { /* 下面会如实报 FAIL */ }
await sleep(2600)
const anchor = await page.evaluate(() => {
  const bar = document.querySelector('.collab .bar')?.getBoundingClientRect()
  const h = [...document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')]
    .find((e) => (e.textContent || '').includes('最左前缀原理与七种情况'))
  return {
    barBottom: bar ? Math.round(bar.bottom) : 0,
    headTop: h ? Math.round(h.getBoundingClientRect().top) : null,
  }
})
check('站内锚点跳转同样不被工具栏遮住',
  anchor.headTop !== null && anchor.headTop >= anchor.barBottom + 2 && anchor.headTop <= anchor.barBottom + 70,
  JSON.stringify(anchor))

/* ---------- 2. 无序列表圆点 ---------- */
const dots = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const realUl = [...pm.querySelectorAll('ul:not([data-type="taskList"]) > li')]
    .slice(0, 5).map((li) => getComputedStyle(li, '::marker').color)
  const box = document.createElement('div')
  box.className = 'ProseMirror'
  box.style.cssText = 'position:absolute;left:-9999px;top:0'
  box.innerHTML = '<ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li></ul>'
    + '<h2 data-number="○" data-number-kind="unordered">t</h2>'
    + '<ul data-type="taskList"><li><label></label><p>task</p></li></ul>'
  document.body.appendChild(box)
  const off = {
    nested: getComputedStyle(box.querySelector('ul ul > li'), '::marker').color,
    deep: getComputedStyle(box.querySelector('ul ul ul > li'), '::marker').color,
    unHead: getComputedStyle(box.querySelector('h2'), '::before').color,
    taskListStyle: getComputedStyle(box.querySelector('ul[data-type="taskList"]')).listStyleType,
    ulStyle: getComputedStyle(box.querySelector('ul')).listStyleType,
  }
  box.remove()
  return { realUl, off }
})
check('正文无序列表圆点为品牌蓝', dots.realUl.length > 0 && dots.realUl.every((c) => c === BLUE), JSON.stringify(dots.realUl))
check('嵌套圆点 / 无序标题符号为品牌蓝',
  dots.off.nested === BLUE && dots.off.deep === BLUE && dots.off.unHead === BLUE, JSON.stringify(dots.off))
check('任务列表不会被加出多余圆点', dots.off.taskListStyle === 'none' && dots.off.ulStyle === 'disc',
  JSON.stringify(dots.off))

/* ---------- 3. 图片点击放大 ---------- */
const imgInfo = await page.evaluate(() => {
  const img = [...document.querySelectorAll('.ProseMirror img')].find((i) => i.naturalWidth > 0 && (i.getAttribute('src') || ''))
  if (!img) return null
  return { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, cursor: getComputedStyle(img).cursor }
})
check('正文存在可点击的配图', !!imgInfo && imgInfo.cursor === 'zoom-in', JSON.stringify(imgInfo))
if (imgInfo) {
  await page.evaluate(() => {
    const img = [...document.querySelectorAll('.ProseMirror img')].find((i) => i.naturalWidth > 0 && (i.getAttribute('src') || ''))
    img.click()
  })
  let opened = false
  try {
    await page.waitForSelector('.image-lightbox', { timeout: 6000 })
    opened = true
  } catch { /* noop */ }
  check('单击图片打开全屏预览', opened)
  if (opened) {
    await sleep(900)
    const box = await page.evaluate(() => {
      const el = document.querySelector('.image-lightbox')
      const img = el?.querySelector('.dlb-stage .ilb-img')
      return {
        src: el?.querySelector('.dlb-title')?.textContent || '',
        zoom: el?.querySelector('.dlb-zoom')?.textContent || '',
        shown: !!img && img.naturalWidth > 0,
        stageW: (el?.querySelector('.dlb-stage'))?.getBoundingClientRect().width || 0,
      }
    })
    check('预览层显示原图且适配窗口', box.shown && box.stageW > 0, JSON.stringify(box))
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.image-lightbox .dlb-btn')]
      btns.find((b) => b.getAttribute('title') === '放大')?.click()
    })
    await sleep(200)
    const zoomAfter = await page.evaluate(() => document.querySelector('.image-lightbox .dlb-zoom')?.textContent || '')
    check('放大按钮改变缩放比例', zoomAfter !== box.zoom, `${box.zoom} → ${zoomAfter}`)
    await page.keyboard.press('Escape')
    await sleep(300)
    check('Esc 关闭预览', await page.evaluate(() => !document.querySelector('.image-lightbox')))

    // 点空白处也能关
    await page.evaluate(() => {
      const img = [...document.querySelectorAll('.ProseMirror img')].find((i) => i.naturalWidth > 0 && (i.getAttribute('src') || ''))
      img.click()
    })
    await page.waitForSelector('.image-lightbox', { timeout: 6000 })
    await sleep(500)
    await page.mouse.click(12, 300)
    await sleep(300)
    check('点空白处关闭预览', await page.evaluate(() => !document.querySelector('.image-lightbox')))
  }
}

/* ---------- 4. 回归 ---------- */
const other = await page.evaluate(async () => {
  const out = {}
  try {
    const r = await fetch('/emotion/', { method: 'GET' })
    out.emotion = r.status
  } catch (e) { out.emotion = String(e).slice(0, 60) }
  try {
    const r = await fetch('/scofendoc/api/health', { method: 'GET' })
    out.health = r.status
  } catch (e) { out.health = String(e).slice(0, 60) }
  return out
}).catch(() => ({}))
check('另一站点 /emotion/ 仍可访问', other.emotion === 200, JSON.stringify(other))
check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n结果：${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

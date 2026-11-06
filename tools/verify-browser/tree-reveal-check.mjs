/**
 * 文档树「定位当前文档」验收：打开文档 → 展开祖先 → 滚到可见 → 高亮。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/tree-reveal-check.mjs [url]
 *
 * 只跑本地冒烟页（tree-smoke.html，40 行假数据），不连后端、不写数据。
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
  defaultViewport: { width: 1100, height: 640 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 300))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.__smoke, { timeout: 20000 })
await page.waitForSelector('.tree-row')
await sleep(300)

/** 切当前文档（模拟「从搜索/主页/链接打开一篇文档」） */
const setDoc = async (id) => {
  await page.evaluate((i) => window.__smoke.setDoc(i), id)
  await sleep(420)
}

/** 读某行的可见性、所在行的高亮状态、以及滚动容器的位置 */
const probe = (id) =>
  page.evaluate((id) => {
    const box = document.querySelector('.smoke-side')
    const el = document.querySelector(`[data-doc-id="${id}"]`)
    const b = box.getBoundingClientRect()
    const active = document.querySelector('.tree-row.active')
    const hit = el ? el.getBoundingClientRect() : null
    return {
      exists: !!el,
      visible: !!hit && hit.top >= b.top - 1 && hit.bottom <= b.bottom + 1,
      scrollTop: Math.round(box.scrollTop),
      rows: document.querySelectorAll('.tree-row').length,
      collapsed: document.querySelectorAll('.tree-row.collapsed').length,
      activeId: active ? Number(active.dataset.docId) : null,
      activeBg: active ? getComputedStyle(active).backgroundColor : null,
      activeShadow: active ? getComputedStyle(active).boxShadow : null,
      locating: el ? el.classList.contains('locating') : false,
      winY: window.scrollY,
    }
  }, id)

// 1) 初始：当前是第一行，已在视野里，不该滚动
let st = await probe(1)
check('初始就在视野里：没有多余滚动', st.scrollTop === 0 && st.visible, `scrollTop=${st.scrollTop}`)
check('当前文档行带 active 高亮', st.activeId === 1, String(st.activeId))
check(
  '高亮是蓝底 + 左侧蓝条',
  st.activeBg === 'rgb(228, 237, 255)' && /rgb\(51, 112, 255\)/.test(st.activeShadow),
  `${st.activeBg} / ${st.activeShadow}`,
)

// 2) 打开列表末尾的文档：应滚过去、闪一下
await setDoc(40)
st = await probe(40)
check('打开靠后的文档：自动滚到它', st.scrollTop > 100 && st.visible, `scrollTop=${st.scrollTop}`)
// 闪动期间底色是动画中的颜色，这里只认「高亮的是这条」，颜色等闪完再验
check('滚到的那一行就是高亮行', st.activeId === 40, String(st.activeId))
check('滚过来的行闪一下（locating）', st.locating === true)
check('只滚树、不滚整页', st.winY === 0, String(st.winY))

// 3) 闪动结束：高亮保留、locating 消失
await sleep(1400)
st = await probe(40)
check(
  '闪完仍高亮，不会再闪',
  st.activeId === 40 && st.locating === false && st.activeBg === 'rgb(228, 237, 255)',
  `${st.activeId}/${st.locating}/${st.activeBg}`,
)

// 4) 列表刷新（改名、协同更新、拖动后重拉）不该把用户拽回去
await page.evaluate(() => (document.querySelector('.smoke-side').scrollTop = 0))
await sleep(200)
const beforeTouch = (await probe(40)).scrollTop
await page.evaluate(() => window.__smoke.touchDocs())
await sleep(420)
st = await probe(40)
check('列表刷新不抢滚动（用户停在别处就停着）', st.scrollTop === beforeTouch && st.scrollTop === 0, `${beforeTouch} → ${st.scrollTop}`)
check('刷新后高亮仍在（虽然行在屏幕外）', st.activeId === 40 && st.visible === false)

// 5) 祖先被收起时，目标行不在 DOM 里：打开文档要先把祖先展开
await setDoc(1)
await page.evaluate(() => document.querySelector('[data-doc-id="1"] > .twist').click())
await sleep(300)
st = await probe(4)
check('收起第一章后，里面的文档确实不在树里', st.exists === false && st.collapsed === 1)
await setDoc(4)
st = await probe(4)
check('打开被收起的文档：祖先自动展开', st.exists && st.visible && st.collapsed === 0, `rows=${st.rows}`)
check('打开的那一行高亮正确', st.activeId === 4, String(st.activeId))
check('缩进层级没被展开动作弄乱（仍是二级子项）', await page.evaluate(() => {
  const el = document.querySelector('[data-doc-id="4"]')
  return el.querySelector('.title').getBoundingClientRect().left > document.querySelector('[data-doc-id="2"] .title').getBoundingClientRect().left
}))

// 6) 手动滚走后，仍可主动定位回来（手机抽屉拉开时走这条路）
await setDoc(40)
await page.evaluate(() => (document.querySelector('.smoke-side').scrollTop = 0))
await sleep(200)
const away = (await probe(40)).scrollTop
await page.evaluate(() => window.__smoke.reveal())
await sleep(420)
st = await probe(40)
check('手动定位能滚回当前文档', away === 0 && st.scrollTop > 0 && st.visible, `${away} → ${st.scrollTop}`)

// 7) 点视野内的另一行（正常浏览）：只切文档，不额外滚动
const beforeClick = (await probe(40)).scrollTop
await page.evaluate(() => document.querySelector('[data-doc-id="41"]').click())
await sleep(400)
st = await probe(41)
check(
  '点视野内的行只切文档、不额外滚动',
  st.activeId === 41 && st.scrollTop === beforeClick && st.visible,
  `${beforeClick} → ${st.scrollTop}`,
)

check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)

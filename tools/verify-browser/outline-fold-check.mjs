/**
 * 文章大纲「折叠 / 展开」验收（对齐飞书：悬停出三角、折起后常驻）。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/outline-fold-check.mjs [url]
 *
 * 只跑本地冒烟页，不连后端、不写线上数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/outline-collab-smoke.html'
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
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 300))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await page.waitForSelector('.outline-item', { timeout: 10000 })
await sleep(350)

const state = () =>
  page.evaluate(() => {
    const lis = [...document.querySelectorAll('.outline-item')]
    return {
      count: lis.length,
      items: lis.map((li) => li.querySelector('.outline-text')?.textContent?.trim() || ''),
      cls: lis.map((li) => li.className.replace('outline-item ', '')),
      folded: lis.filter((li) => li.classList.contains('folded')).length,
      carets: document.querySelectorAll('.outline-caret').length,
      caretOpacity: lis.map((li) => {
        const c = li.querySelector('.outline-caret')
        return c ? Number(getComputedStyle(c).opacity) : null
      }),
      // ▶（未展开箭头）还是 ▼（已展开）：靠 open 类判断
      open: lis.map((li) => {
        const c = li.querySelector('.outline-caret')
        return c ? c.classList.contains('open') : null
      }),
      bodyHeads: [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4')]
        .map((h) => h.tagName.toLowerCase())
        .join(','),
    }
  })

/** 点第 n 条的折叠三角 */
const clickCaret = async (n) => {
  await page.evaluate((i) => {
    const li = document.querySelectorAll('.outline-item')[i - 1]
    li.querySelector('.outline-caret').click()
  }, n)
  await sleep(260)
}

/** 点第 n 条右侧的第 idx 个层级按钮（0=提升 1=降低） */
const clickAct = async (n, idx) => {
  await page.evaluate(
    ({ n, idx }) => {
      const li = document.querySelectorAll('.outline-item')[n - 1]
      li.querySelectorAll('.outline-act')[idx].click()
    },
    { n, idx },
  )
  await sleep(300)
}

// 1) 初始：7 条，只有带子级的 3 条有三角
let st = await state()
check('初始列出 7 条', st.count === 7, st.count)
check('只有带子级的 3 条有折叠三角', st.carets === 3, st.carets)
check('未悬停时三角不显示', st.caretOpacity.filter((o) => o === 0).length === 3, st.caretOpacity.join(','))

// 2) 悬停出现、移开消失（飞书行为：hover 才露出）
await page.hover('.outline-item:nth-child(2)')
await sleep(220)
st = await state()
check('悬停时该条三角浮出', st.caretOpacity[1] === 1, st.caretOpacity.join(','))
check('其它条的三角仍不显示', st.caretOpacity[0] === 0 && st.caretOpacity[4] === 0, st.caretOpacity.join(','))
await page.mouse.move(1320, 40)
await sleep(260)
st = await state()
check('鼠标移开后三角消失', st.caretOpacity[1] === 0, st.caretOpacity.join(','))

// 3) 折起「小节 A」：其下 2 条隐藏，三角常驻且转成 ▶
await clickCaret(2)
st = await state()
check('折叠「小节 A」后只剩 5 条', st.count === 5, st.items.join('|'))
check('被折叠的子级从大纲消失', !st.items.includes('细节 a1') && !st.items.includes('细节 a2'), st.items.join('|'))
check('该条带 folded 标记', st.folded === 1 && st.cls[1].includes('folded'), st.cls.join('|'))
check('折叠后三角常驻（无需悬停）', st.caretOpacity[1] === 1, st.caretOpacity.join(','))
check('折叠后三角方向是 ▶（不展开）', st.open[1] === false, String(st.open[1]))
check('正文标题不受影响（仍是 7 个）', st.bodyHeads === 'h1,h2,h3,h3,h2,h3,h2', st.bodyHeads)

// 4) 点条目本身只跳转，不会顺手展开
await page.evaluate(() => {
  const li = document.querySelectorAll('.outline-item')[1]
  for (const type of ['mousedown', 'mouseup', 'click']) {
    li.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
})
await sleep(220)
st = await state()
check('点折叠项只跳转、不展开', st.count === 5 && st.folded === 1, `${st.count}/${st.folded}`)

// 5) 再点一次展开
await clickCaret(2)
st = await state()
check('再点三角展开回 7 条', st.count === 7 && st.folded === 0, `${st.count}/${st.folded}`)

// 6) 折叠 H1：整篇收成一条
await clickCaret(1)
st = await state()
check('折叠一级标题后只剩 1 条', st.count === 1 && st.items[0].includes('第一章'), st.items.join('|'))
await clickCaret(1)

// 7) 折叠状态下改层级：三角与折叠态都要留住（改层级会重建 h 元素）
st = await state()
check('重新展开后回到 7 条', st.count === 7, st.count)
await clickCaret(2)
await clickAct(2, 1)
st = await state()
check('折叠项可以正常降级（H2→H3，子级藏起来）', st.bodyHeads === 'h1,h3,h4,h4,h2,h3,h2', st.bodyHeads)
check('降级后折叠态仍在（元素重建后按序号搬回）', st.folded === 1 && st.cls[1].includes('folded'), st.cls.join('|'))
check('降级后仍只列 5 条', st.count === 5, st.count)

check('页面无 JS 报错', errors.length === 0, errors.join(' | ').slice(0, 200))

await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)

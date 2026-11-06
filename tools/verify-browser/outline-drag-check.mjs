/**
 * 文章大纲「拖拽调整顺序 / 层级」验收（对齐文档树的 before / inside / after 三段落点）。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/outline-drag-check.mjs [url]
 *
 * 只跑本地冒烟页（真 Yjs + Collaboration），不连后端、不写线上数据。
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
    // 正文里「块」的先后顺序（标题 + 段落），用来确认整节连同正文一起搬走
    const blocks = [...document.querySelectorAll('.ProseMirror > h1,.ProseMirror > h2,.ProseMirror > h3,.ProseMirror > h4,.ProseMirror > p')].map(
      (n) => `${n.tagName.toLowerCase()}:${(n.textContent || '').replace(/\s+/g, ' ').trim()}`,
    )
    return {
      items: lis.map((li) => li.querySelector('.outline-text')?.textContent?.trim() || ''),
      levels: lis.map((li) => (li.className.match(/lvl-\d/) || [''])[0]),
      draggable: lis.every((li) => li.draggable === true),
      blocks,
      toast: document.querySelector('.outline-toast')?.textContent?.trim() || '',
      cls: lis.map((li) => li.className.replace('outline-item ', '')),
    }
  })

/**
 * 合成一次 HTML5 拖放：从第 from 条拖到第 to 条的上/中/下三段。
 * 分三步走、每步之间让出一拍：落点指示是 Vue 渲染出来的，同一帧里读不到。
 */
const dragTo = async (from, to, zone) => {
  const prevented = await page.evaluate(
    ({ from, to, zone }) => {
      const lis = [...document.querySelectorAll('.outline-item')]
      const dt = new DataTransfer()
      window.__dt = dt
      lis[from].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const dst = lis[to]
      const r = dst.getBoundingClientRect()
      const cy = zone === 'before' ? r.top + r.height * 0.1 : zone === 'after' ? r.bottom - r.height * 0.1 : r.top + r.height / 2
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: cy, clientX: r.left + 40 })
      dst.dispatchEvent(over)
      return over.defaultPrevented
    },
    { from, to, zone },
  )
  await sleep(140)
  const indicator = await page.evaluate(
    ({ to }) => {
      const dst = document.querySelectorAll('.outline-item')[to]
      return {
        before: dst.classList.contains('drop-before'),
        after: dst.classList.contains('drop-after'),
        inside: dst.classList.contains('drop-inside'),
      }
    },
    { to },
  )
  await page.evaluate(
    ({ to, zone }) => {
      const dst = document.querySelectorAll('.outline-item')[to]
      const r = dst.getBoundingClientRect()
      const cy = zone === 'before' ? r.top + r.height * 0.1 : zone === 'after' ? r.bottom - r.height * 0.1 : r.top + r.height / 2
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientY: cy, clientX: r.left + 40 }))
    },
    { to, zone },
  )
  await sleep(340)
  return { prevented, indicator }
}

/** 悬停某条后点它右侧的层级按钮（0=提升 1=降低） */
const clickAct = async (n, idx) => {
  await page.evaluate(
    ({ n, idx }) => document.querySelectorAll('.outline-item')[n - 1].querySelectorAll('.outline-act')[idx].click(),
    { n, idx },
  )
  await sleep(300)
}

// 初始：h1, h2 A, h3 a1, h3 a2, h2 B, h3 b1, h2 C（大纲条目的 lvl-N 类）
const BASE_ORDER = ['第一章 总览', '小节 A', '细节 a1', '细节 a2', '小节 B', '细节 b1', '小节 C']
const BASE_LEVELS = 'lvl-1,lvl-2,lvl-3,lvl-3,lvl-2,lvl-3,lvl-2'
let st = await state()
check('初始 7 条、顺序正确', st.items.join('|') === BASE_ORDER.join('|'), st.items.join('|'))
check('每条都可拖拽', st.draggable)

// 1) 拖「小节 C」到「小节 A」前面：同层级调顺序，正文跟着走
let r = await dragTo(6, 1, 'before')
st = await state()
check('落点上边缘出现插入线', r.indicator.before === true && r.prevented === true, JSON.stringify(r.indicator))
check('拖到前面：C 排到 A 之前', st.items.join('|') === '第一章 总览|小节 C|小节 A|细节 a1|细节 a2|小节 B|细节 b1', st.items.join('|'))
check('层级不变（H2 移到 H2 之前）', st.levels.join(',') === 'lvl-1,lvl-2,lvl-2,lvl-3,lvl-3,lvl-2,lvl-3', st.levels.join(','))
check(
  '正文里 C 的段落跟着一起搬家',
  st.blocks.indexOf('p:C 的正文，用来验证同级不会被前面的级联带走。') < st.blocks.indexOf('h2:小节 A'),
  st.blocks.slice(0, 6).join(' / '),
)

// 2) 一次撤销就回到原样（删 + 插 + 改层级在同一个事务里）
await page.evaluate(() => window.ed.commands.undo())
await sleep(340)
st = await state()
check('一次撤销还原整次拖拽', st.items.join('|') === BASE_ORDER.join('|') && st.levels.join(',') === BASE_LEVELS, st.items.join('|') + ' ' + st.levels.join(','))

// 3) 拖到某条中间 = 变成它的子节：C 拖进 B → H3，落在 b1 之后
r = await dragTo(6, 4, 'inside')
st = await state()
check('落点中间高亮为「成为子节」', r.indicator.inside === true, JSON.stringify(r.indicator))
check('拖进 B：C 排到 b1 之后', st.items.join('|') === '第一章 总览|小节 A|细节 a1|细节 a2|小节 B|细节 b1|小节 C', st.items.join('|'))
check('层级跟着落点改：C 由 H2 变 H3', st.levels.join(',') === 'lvl-1,lvl-2,lvl-3,lvl-3,lvl-2,lvl-3,lvl-3', st.levels.join(','))
check('反馈里写清层级变化', /2→3/.test(st.toast), st.toast)

// 4) 拖完还能继续用 ↑↓ 调层级（说明节点是真的搬进正文了）
await clickAct(7, 0)
st = await state()
check('拖完仍可用 ↑ 把它提回 H2', st.levels.join(',') === BASE_LEVELS, st.levels.join(','))
await page.evaluate(() => window.ed.commands.undo())
await sleep(320)

// 5) 不能拖进自己的后代里（会成环）
st = await state()
const beforeBad = st.items.join('|')
const levelsBad = st.levels.join(',')
r = await dragTo(1, 2, 'inside')
st = await state()
check('拖进自己的子节被拦下（无插入线、不 preventDefault）', r.prevented === false && r.indicator.inside === false && r.indicator.before === false, JSON.stringify(r.indicator))
check('结构没有被破坏', st.items.join('|') === beforeBad && st.levels.join(',') === levelsBad, `${st.items.join('|')} ${st.levels.join(',')}`)

// 6) 只在只读稿的「拖拽中」样式：拖起后源条目变淡
await page.evaluate(() => {
  const lis = [...document.querySelectorAll('.outline-item')]
  const dt = new DataTransfer()
  window.__dt = dt
  lis[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
})
await sleep(160)
const dimmed = await page.evaluate(() => document.querySelectorAll('.outline-item.dragging').length)
await page.evaluate(() => document.querySelector('.outline-list').dispatchEvent(new DragEvent('dragend', { bubbles: true })))
await sleep(160)
const afterEnd = await page.evaluate(() => document.querySelectorAll('.outline-item.dragging').length)
check('拖起时源条目变淡、松手后恢复', dimmed === 1 && afterEnd === 0, `${dimmed}/${afterEnd}`)

check('页面无 JS 报错', errors.length === 0, errors.join(' | ').slice(0, 200))

await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)

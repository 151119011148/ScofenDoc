/**
 * 文章大纲「级联升降级 + 撤销重做」验收（协同栈：Yjs UndoManager）。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node tools/verify-browser/outline-cascade-check.mjs [url]
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
await sleep(300)

const state = () =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4')]
    return {
      levels: heads.map((h) => h.tagName.toLowerCase()).join(','),
      texts: heads.map((h) => h.textContent.trim()),
      items: [...document.querySelectorAll('.outline-item')].map((li) => li.querySelector('.outline-text')?.textContent?.trim() || ''),
      lvl4: document.querySelectorAll('.outline-item.lvl-4').length,
      selCount: document.querySelectorAll('.outline-item.sel').length,
      countText: document.querySelector('.ob-count')?.textContent?.trim() || '',
      toast: document.querySelector('.outline-toast')?.textContent?.trim() || '',
      // 面板上不再放「撤销 / 重做」按钮，直接问编辑器的撤销栈
      undoable: window.ed.can().undo(),
      redoable: window.ed.can().redo(),
    }
  })

/** 悬停某条大纲后点它右侧的第 idx 个层级按钮（0=提升 1=降低） */
const clickAct = async (n, idx) => {
  await page.evaluate(
    ({ n, idx }) => {
      const li = document.querySelectorAll('.outline-item')[n - 1]
      li.querySelectorAll('.outline-act')[idx].click()
    },
    { n, idx },
  )
  await sleep(260)
}

/** 点第 n 条大纲（普通点击） */
const clickItem = async (n, mods = {}) => {
  await page.evaluate(
    ({ n, mods }) => {
      const li = document.querySelectorAll('.outline-item')[n - 1]
      for (const type of ['mousedown', 'mouseup', 'click']) {
        li.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...mods }))
      }
    },
    { n, mods },
  )
  await sleep(160)
}

/** 撤销（0）/ 重做（1）：没有按钮了，直接走编辑器命令 */
const clickTool = async (idx) => {
  await page.evaluate((i) => (i === 0 ? window.ed.commands.undo() : window.ed.commands.redo()), idx)
  await sleep(280)
}

/** 初始：h1, h2 A, h3 a1, h3 a2, h2 B, h3 b1, h2 C */
const BASE = 'h1,h2,h3,h3,h2,h3,h2'
let st = await state()

check('大纲列出 7 条（文档最深层级 H3）', st.items.length === 7, st.items.length)
check('初始没有可撤销的操作', st.undoable === false && st.redoable === false, `${st.undoable}/${st.redoable}`)

// 1) 单条提升：连同子树一起升（H2 + H3,H3 → H1 + H2,H2）
await clickAct(2, 0)
st = await state()
check('提升「小节 A」：自己 H2→H1', st.levels === 'h1,h1,h2,h2,h2,h3,h2', st.levels)
check('级联：其下 2 条 H3 一起升为 H2', st.texts[2] === '细节 a1' && st.texts[3] === '细节 a2', st.texts.join('|'))
check('同级「小节 B / C」不受影响', st.levels.split(',')[4] === 'h2' && st.levels.split(',')[6] === 'h2', st.levels)
check('反馈里说明连带条数', /及 2 条子级/.test(st.toast), st.toast)
check('操作后可撤销、不可重做', st.undoable === true && st.redoable === false)

// 2) 撤销：整组回退
await clickTool(0)
st = await state()
check('撤销后整组回到原层级', st.levels === BASE, st.levels)
check('撤销后可重做', st.redoable === true)

// 3) 重做
await clickTool(1)
st = await state()
check('重做后回到级联后的层级', st.levels === 'h1,h1,h2,h2,h2,h3,h2', st.levels)

// 4) 键盘撤销（焦点在大纲里，Ctrl+Z 要能撤回层级调整）
//    点完 ↑↓ / 折叠三角后焦点落在按钮上，键盘事件到不了正文编辑器，面板内部接管一次
await page.evaluate(() => document.querySelector('.outline-item .outline-caret').focus())
await page.keyboard.down('Control')
await page.keyboard.press('z')
await page.keyboard.up('Control')
await sleep(300)
st = await state()
check('焦点在大纲时 Ctrl+Z 可撤销', st.levels === BASE, st.levels)

// 5) 降低也级联：H2 小节 B（含 H3）→ H3 + H4，大纲跟着显示到 H4
await clickAct(5, 1)
st = await state()
check('降低「小节 B」：H2→H3，子级 H3→H4', st.levels === 'h1,h2,h3,h3,h3,h4,h2', st.levels)
check('出现 H4 后大纲列到 H4（标题不消失）', st.items.length === 7 && st.lvl4 === 1 && st.items[5] === '细节 b1', `${st.items.length} lvl4=${st.lvl4} ${st.items.join('|')}`)

await clickTool(0)
st = await state()
check('撤销回退到 H3 以内的结构', st.levels === 'h1,h1,h2,h2,h2,h3,h2' || st.levels === BASE, st.levels)

// 6) 边界：H1 不能再提升（按钮置灰）
const h1Disabled = await page.evaluate(() => document.querySelectorAll('.outline-item')[0].querySelectorAll('.outline-act')[0].disabled)
check('H1 的「提升」置灰', h1Disabled === true)

// 7) 父子同选批量提升：子级不该被升两级（子树取并集）
await page.keyboard.press('Escape')
await clickItem(2, { ctrlKey: true })
await clickItem(3, { ctrlKey: true })
st = await state()
check('父子同时选中 2 条', st.selCount === 2, st.selCount)
await page.evaluate(() => document.querySelectorAll('.ob-btn')[0].click())
await sleep(300)
st = await state()
check('父子同选提升：父 H2→H1、子 H3→H2（不是 H2）', st.levels.startsWith('h1,h1,h2'), st.levels)
// 选中「小节 A」与其中的「细节 a1」：并集是 A + a1 + a2，共 3 条（子级不会被升两级、也不重复计数）
check('批量条反馈调整条数（子树取并集）', /已提升\s*3\s*条/.test(st.countText), st.countText)

// 8) 一次撤销回退整组批量
await page.evaluate(() => window.ed.commands.undo())
await sleep(320)
st = await state()
check('一次撤销回退整组批量', st.levels === BASE, st.levels)

// 9) 撤销栈为空时按钮置灰（回到初始状态后再撤一次也不该崩）
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.ed.commands.undo())
  await sleep(120)
}
st = await state()
check('撤到底后撤销栈为空且正文还在', st.undoable === false && st.texts.length >= 7, `${st.undoable} ${st.texts.length}`)

// 10) 连点两次降级互不吞并：一次撤销只退一步（Yjs 会把 500ms 内的改动并成一步，
//     大纲每次改完都主动封口，所以这里 120ms 的连点也应该是两个撤销步）
const fastDown = () =>
  page.evaluate(() => {
    const li = document.querySelectorAll('.outline-item')[6]
    li.querySelectorAll('.outline-act')[1].click()
  })
await fastDown()
await sleep(120)
await fastDown()
await sleep(320)
st = await state()
check('连点两次「降低」各自生效（小节 C H2→H4）', st.levels.endsWith(',h4'), st.levels)
await page.evaluate(() => window.ed.commands.undo())
await sleep(300)
st = await state()
check('一次撤销只退一步（两次连点没被并成一步）', st.levels.endsWith(',h3'), st.levels)
check('页面无 JS 报错', errors.length === 0, errors.join(' | ').slice(0, 200))

await browser.close()
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)

/**
 * 文章大纲「多选批量升降层级」验收。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node outline-batch-check.mjs [url]
 *
 * 只跑本地冒烟页，不连后端、不写线上数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/outline-smoke.html'
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await page.waitForSelector('.outline-item', { timeout: 10000 })

/**
 * 点第 n 条大纲。
 * 用 dispatchEvent 而不是 page.click：修饰键（Ctrl/Shift）要精确可控，
 * 而且元素中心可能落到右侧的 ↑↓ 按钮上，误触单条操作。
 */
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
  await sleep(150)
}

/** 批量条第 idx 个按钮：0=提升 1=降低 2=全选 3=取消 */
const clickBatch = async (idx) => {
  await page.evaluate((i) => document.querySelectorAll('.ob-btn')[i].click(), idx)
  await sleep(220)
}

const state = () =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4')]
    const btns = [...document.querySelectorAll('.ob-btn')]
    return {
      levels: heads.map((h) => h.tagName.toLowerCase()),
      texts: heads.map((h) => h.textContent.trim()),
      sel: [...document.querySelectorAll('.outline-item')].map((li) => li.classList.contains('sel')),
      selCount: document.querySelectorAll('.outline-item.sel').length,
      batch: !!document.querySelector('.outline-batch'),
      countText: document.querySelector('.ob-count')?.textContent?.trim() || '',
      raiseDisabled: btns[0] ? btns[0].disabled : null,
      lowerDisabled: btns[1] ? btns[1].disabled : null,
      raiseTitle: btns[0]?.title || '',
      lowerTitle: btns[1]?.title || '',
      batchBtnCount: btns.length,
    }
  })

const undo = async () => {
  await page.evaluate(() => window.ed.commands.undo())
  await sleep(220)
}

// 1) 初始：没有选中就没有批量条
let st = await state()
check('未选中时不出现批量条', !st.batch && st.selCount === 0, `batch=${st.batch}`)
check('初始 5 条大纲 / 正文标题 H1-H4', st.levels.length === 6 && st.levels[0] === 'h1', st.levels.join(','))

// 2) Ctrl 点击逐条加选
await clickItem(2, { ctrlKey: true })
st = await state()
check('Ctrl 点击后出现批量条', st.batch, st.countText)
check('选中 1 条，条目有选中态', st.selCount === 1 && st.sel[1] === true, `selCount=${st.selCount}`)
check('选中 1 条时两个方向都可用', st.raiseDisabled === false && st.lowerDisabled === false)

await clickItem(3, { ctrlKey: true })
st = await state()
check('再 Ctrl 点击加到 2 条', st.countText.includes('2'), st.countText)

// 3) Shift 点范围
await clickItem(5, { shiftKey: true })
st = await state()
check('Shift 点击选中连续范围（2–5 共 4 条）', st.selCount === 4, st.sel.join(','))
check('Shift 范围选不跳走批量条', st.batch === true)

// 4) Esc 清空
await page.keyboard.press('Escape')
await sleep(150)
st = await state()
check('Esc 清空选择并收起批量条', !st.batch && st.selCount === 0)

// 5) 整组提升：H2 + H3 → H1 + H2（组内相对关系不变）
await clickItem(2, { ctrlKey: true })
await clickItem(3, { ctrlKey: true })
await clickBatch(0)
st = await state()
check('整组提升：H2,H3 → H1,H2', st.levels[1] === 'h1' && st.levels[2] === 'h2', st.levels.slice(0, 4).join(','))
check('提升后选中态保留（可继续调）', st.selCount === 2, `selCount=${st.selCount}`)
check('批量条反馈已调整条数', /已提升\s*2\s*条/.test(st.countText), st.countText)

// 6) 一次撤销回退整组（关键：批量合并成单个事务）
await undo()
st = await state()
check('一次 Ctrl+Z 回退整组（不是逐条退）', st.levels[1] === 'h2' && st.levels[2] === 'h3', st.levels.slice(0, 4).join(','))

// 7) 全选后的边界：含 H1 不能提升；最深才 H4，所以还能继续降低
await clickBatch(2)
st = await state()
check('全选选中全部 6 条（含 H4）', st.selCount === 6, `selCount=${st.selCount}`)
check('含 H1 时「提升」置灰', st.raiseDisabled === true, st.raiseTitle)
check('置灰原因写进 title', /H1/.test(st.raiseTitle), st.raiseTitle)
check('最深才 H4，整组仍可降低（上限是 H6）', st.lowerDisabled === false, st.lowerTitle)

// 8) 混合层级整组降低：H1 + H2 → H2 + H3
await clickBatch(3) // 清空
await clickItem(1, { ctrlKey: true })
await clickItem(4, { ctrlKey: true })
st = await state()
check('选中 H1 与 H2 两条', st.selCount === 2 && st.levels[0] === 'h1', st.sel.join(','))
check('含 H1 时不能提升', st.raiseDisabled === true)
check('含 H1 时仍可降低', st.lowerDisabled === false)
await clickBatch(1)
st = await state()
check('整组降低：H1,H2 → H2,H3', st.levels[0] === 'h2' && st.levels[3] === 'h3', st.levels.join(','))
check('降低时子级跟着降（细节 b1 → H4）', st.levels[4] === 'h4', st.levels.join(','))
await undo()
st = await state()
check('降低后可整组撤销', st.levels[0] === 'h1' && st.levels[3] === 'h2', st.levels.join(','))

// 9) 普通点击（无修饰键）退出选择并跳转
await clickItem(2)
st = await state()
check('普通点击清空选择', !st.batch && st.selCount === 0)

// 10) 只读空间不提供批量
await page.evaluate(() => window.ed.setEditable(false))
await sleep(200)
await clickItem(2, { ctrlKey: true })
st = await state()
const readOnlyHidden = await page.evaluate(() => document.querySelectorAll('.outline-batch').length === 0)
check('只读状态不出现批量条、也不留选中态', readOnlyHidden && st.selCount === 0, `batch=${st.batch} sel=${st.selCount}`)
await page.evaluate(() => window.ed.setEditable(true))
await sleep(150)

check('无运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

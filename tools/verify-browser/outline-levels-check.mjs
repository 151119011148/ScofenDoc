/**
 * 文章大纲「层级提升 / 降低」验收。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node outline-levels-check.mjs [url]
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

/** 正文顶层块 → ['heading:1', 'paragraph:', ...] */
const outlineState = () =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.outline-item')].map((el) => ({
      cls: el.className,
      text: el.querySelector('.outline-text')?.textContent?.trim() || '',
    }))
    const blocks = window.ed.state.doc.content.content.map((n) =>
      n.type.name === 'heading' ? `h${n.attrs.level}` : n.type.name,
    )
    return { items, blocks }
  })

const hoverItem = async (n) => {
  await page.hover(`.outline-item:nth-child(${n})`)
  await sleep(120)
}
const clickAct = async (n, which) => {
  await hoverItem(n)
  await page.evaluate(
    ({ n, which }) => {
      const li = document.querySelectorAll('.outline-item')[n - 1]
      const btns = li.querySelectorAll('.outline-act')
      btns[which === 'up' ? 0 : 1].click()
    },
    { n, which },
  )
  await sleep(180)
}

// 1) 初始：大纲列到文档实际用到的最深层级（这篇有 H4，所以列 6 条）
let st = await outlineState()
check('大纲列 6 条（含 H4，不再被截断在 H3）', st.items.length === 6, `实际 ${st.items.length}`)
check(
  '大纲层级缩进正确',
  /lvl-1/.test(st.items[0].cls) && /lvl-2/.test(st.items[1].cls) && /lvl-3/.test(st.items[2].cls),
  st.items.map((i) => i.cls.replace('outline-item ', '')).join(' / '),
)

// 2) 悬停才出现按钮
const actsHidden = await page.evaluate(() => {
  const li = document.querySelector('.outline-item')
  return getComputedStyle(li.querySelector('.outline-acts')).display === 'none'
})
check('未悬停时按钮隐藏', actsHidden)
await hoverItem(2)
const actsShown = await page.evaluate(() => {
  const li = document.querySelectorAll('.outline-item')[1]
  return getComputedStyle(li.querySelector('.outline-acts')).display !== 'none'
})
check('悬停后按钮出现', actsShown)

// 3) 降低层级：小节 A（h2）→ h3
await clickAct(2, 'down')
st = await outlineState()
check('降低层级后正文标题变 h3', st.blocks[2] === 'h3', st.blocks.slice(0, 5).join(','))
check('大纲条目缩进同步变 lvl-3', /lvl-3/.test(st.items[1].cls), st.items[1].cls)
check('条目顺序与文字不变', st.items[1].text.includes('小节 A') && st.items.length === 6, st.items[1].text)

// 4) 提升层级：再 ↑ 两次 → h1，且 H1 的 ↑ 置灰
await clickAct(2, 'up')
st = await outlineState()
check('提升层级后回到 h2', st.blocks[2] === 'h2', st.blocks[2])
await clickAct(2, 'up')
st = await outlineState()
check('再提升到 h1', st.blocks[2] === 'h1', st.blocks[2])
const topDisabled = await page.evaluate(() => {
  const li = document.querySelectorAll('.outline-item')[1]
  return li.querySelectorAll('.outline-act')[0].disabled === true
})
check('H1 的「提升」按钮置灰', topDisabled)

/** 按标题文字查正文里的层级（比按下标更稳，段落会插在中间） */
const levelOf = (text) =>
  page.evaluate((t) => {
    const h = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6')].find(
      (n) => n.textContent.includes(t),
    )
    return h ? h.tagName.toLowerCase() : null
  }, text)

// 4b) 级联：小节 A 连升两次时，其下的「细节 a1」跟着一起升到 H2
check('级联：子级跟着父级一起提升', (await levelOf('细节 a1')) === 'h2', await levelOf('细节 a1'))
check('同级 / 别家的子级不受影响', (await levelOf('小节 B')) === 'h2' && (await levelOf('细节 b1')) === 'h3')

// 5) 边界：可以一路降到 H6，之后 ↓ 置灰
await clickAct(3, 'down')
check('H2 可以降到 H3', (await levelOf('细节 a1')) === 'h3', await levelOf('细节 a1'))
await clickAct(3, 'down')
check('再降到 H4（不再卡在三级）', (await levelOf('细节 a1')) === 'h4', await levelOf('细节 a1'))
st = await outlineState()
check('大纲缩进跟着变 lvl-4', /lvl-4/.test(st.items[2].cls), st.items[2].cls)
// 中间隔开一点：ProseMirror 的 history 会把 500ms 内的连续改动并成一步，
// 这里要验的是「撤销最近一次」，不是撤销的分组策略（那在协同栈那边单独验）
await clickAct(3, 'down')
await sleep(700)
await clickAct(3, 'down')
check('可以一路降到 H6', (await levelOf('细节 a1')) === 'h6', await levelOf('细节 a1'))
const bottomDisabled = await page.evaluate(() => {
  const li = document.querySelectorAll('.outline-item')[2]
  return li.querySelectorAll('.outline-act')[1].disabled === true
})
check('H6 的「降低」按钮置灰', bottomDisabled)

// 6) 撤销：Ctrl/Cmd+Z 能回退层级变更（退一级，不是退全部）
await page.click('.ProseMirror')
await page.keyboard.down('Meta')
await page.keyboard.press('z')
await page.keyboard.up('Meta')
await sleep(220)
check('Ctrl+Z 撤销最后一次层级变更', (await levelOf('细节 a1')) === 'h5', await levelOf('细节 a1'))

// 7) 编号标题：改层级后章节号跟着重排
await page.evaluate(() => window.ed.chain().setAllHeadingsNumbered(true).run())
await sleep(220)
const nums1 = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4')]
    .map((h) => h.getAttribute('data-number') || '-')
    .join(','),
)
await clickAct(2, 'down')
await sleep(220)
const nums2 = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4')]
    .map((h) => h.getAttribute('data-number') || '-')
    .join(','),
)
const outlineNums = await page.evaluate(() =>
  [...document.querySelectorAll('.outline-item .outline-text')].map((n) => n.textContent.trim()).join(' | '),
)
check('编号在层级变更后重新计算', nums1 !== nums2 && nums2.split(',').every((n) => n === '-' || /^\d+(\.\d+)*\.$/.test(n)), `${nums1} → ${nums2}`)
check('大纲文字带编号', /^\d/.test(outlineNums), outlineNums.slice(0, 40))

// 8) 只读时不显示层级按钮
await page.evaluate(() => window.ed.setEditable(false))
await sleep(220)
await hoverItem(2)
const readOnlyHidden = await page.evaluate(() => document.querySelectorAll('.outline-act').length === 0)
check('只读状态不渲染层级按钮', readOnlyHidden)
await page.evaluate(() => window.ed.setEditable(true))

check('无运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

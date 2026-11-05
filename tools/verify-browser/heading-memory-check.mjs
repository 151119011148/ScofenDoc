/**
 * 标题「格式刷」验收：选一次级别，之后选中别的行单击一下就套用。
 *
 *   cd frontend && ./node_modules/.bin/vite --port 5388 --host 127.0.0.1 --strictPort
 *   node heading-memory-check.mjs [url]
 *
 * 验收项：
 *  1. 首次没有记忆 → 主键退化成打开面板
 *  2. 面板里选级别 → 生效 + 写进 localStorage
 *  3. 选中另一行 → 主键显示上次级别，单击直接生效，且不再展开面板（少一次选择）
 *  4. 已是该级别时再点主键 → 保持不降级（幂等，不会打回正文）
 *  5. 面板里「上次」角标落在记忆项上
 *  6. 选「正文」同样被记住，之后一键恢复正文
 *  7. 无运行时报错
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/color-tab-smoke.html'
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
  defaultViewport: { width: 1440, height: 960 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})

await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
// 清掉上一次跑留下的记忆，保证「首次」这条断言是真的首次
await page.evaluate(() => localStorage.removeItem('scofendoc:lastHeading'))
await page.reload({ waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await sleep(200)

/** 换内容并清掉残留选区 / 面板 */
async function reset(html) {
  await page.keyboard.press('Escape')
  await page.evaluate((html) => {
    window.ed.commands.setContent(html)
    localStorage.removeItem('scofendoc:lastHeading')
  }, html)
  await sleep(160)
}

async function dragSelect(text, width = 70) {
  await page.keyboard.press('Escape')
  await sleep(80)
  const box = await page.evaluate((text) => {
    const el = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3')].find(
      (x) => x.textContent.includes(text),
    )
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + 2, y: r.top + r.height / 2 }
  }, text)
  if (!box) return ''
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x + width, box.y, { steps: 10 })
  await page.mouse.up()
  await sleep(320)
  return page.evaluate(() => window.getSelection()?.toString() || '')
}

const mainBtn = '.heading-dd > button:first-child'
const caretBtn = '.heading-dd .heading-caret'

const mainLabel = () => page.$eval(mainBtn, (el) => el.textContent.trim())
const panelOpen = () => page.$$eval('.sel-panel', (els) => els.length > 0)
const storedLevel = () => page.evaluate(() => localStorage.getItem('scofendoc:lastHeading'))
/** 某段落在正文里的标签名（H1/H2/P） */
const tagOf = (text) =>
  page.evaluate((text) => {
    for (const el of document.querySelectorAll('.ProseMirror > *')) {
      if (el.textContent.includes(text)) return el.tagName
    }
    return ''
  }, text)

/* ---------- 1) 首次：没有记忆时主键退化成打开面板 ---------- */
await reset('<p>第一段用来设标题</p><p>第二段照抄上次级别</p><p>第三段恢复成正文</p>')
const sel1 = await dragSelect('第一段用来设标题')
check('拖选能唤起浮动工具条', !!sel1 && !!(await page.$(mainBtn)), JSON.stringify(sel1))
check('没有记忆时主键显示当前级别 T', (await mainLabel()) === 'T', await mainLabel())

await page.click(mainBtn)
await sleep(200)
check('没有记忆时单击主键打开面板（不会毫无反应）', await panelOpen())

/* ---------- 2) 选一次级别 → 生效并记住 ---------- */
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.sel-panel .sel-item')].find((b) => b.textContent.includes('二级标题'))
  item.click()
})
await sleep(250)
check('面板选二级标题后本段变 H2', (await tagOf('第一段用来设标题')) === 'H2', await tagOf('第一段用来设标题'))
check('级别写入 localStorage', (await storedLevel()) === '2', String(await storedLevel()))

/* ---------- 3) 选中另一行：主键直接套用，少一次展开 ---------- */
const sel2 = await dragSelect('第二段照抄上次级别')
check('能选中第二段', !!sel2, JSON.stringify(sel2))
check('主键改显示上次的级别 H2', (await mainLabel()) === 'H2', await mainLabel())

await page.click(mainBtn)
await sleep(250)
check('单击主键直接变 H2（不用再展开面板）', (await tagOf('第二段照抄上次级别')) === 'H2', await tagOf('第二段照抄上次级别'))
check('这一步没有弹出面板', !(await panelOpen()))

/* ---------- 4) 已是该级别时再点：幂等，不打回正文 ---------- */
await dragSelect('第二段照抄上次级别')
await page.click(mainBtn)
await sleep(220)
check('已是 H2 再点一次仍是 H2（不会降级成正文）', (await tagOf('第二段照抄上次级别')) === 'H2', await tagOf('第二段照抄上次级别'))

/* ---------- 5) 面板里「上次」角标 ---------- */
await dragSelect('第二段照抄上次级别')
await page.click(caretBtn)
await sleep(200)
const badges = await page.$$eval('.sel-panel .sel-item', (els) =>
  els.filter((b) => b.querySelector('.sel-last')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
)
check('面板里只有「二级标题」带「上次」角标', badges.length === 1 && badges[0].includes('二级标题'), JSON.stringify(badges))

/* ---------- 6) 「正文」也被记住，之后一键恢复 ---------- */
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.sel-panel .sel-item')].find((b) => b.textContent.includes('正文'))
  item.click()
})
await sleep(220)
check('面板选「正文」后本段回到 P', (await tagOf('第二段照抄上次级别')) === 'P', await tagOf('第二段照抄上次级别'))
check('正文同样被记住（存 0）', (await storedLevel()) === '0', String(await storedLevel()))

await dragSelect('第三段恢复成正文')
check('主键跟着显示 T', (await mainLabel()) === 'T', await mainLabel())
// 先把第三段手动设成标题，才能验证「一键恢复正文」
await page.evaluate(() => {
  window.ed.chain().focus().toggleHeading({ level: 3 }).run()
})
await sleep(160)
const beforeReset = await tagOf('第三段恢复成正文')
await dragSelect('第三段恢复成正文')
await page.click(mainBtn)
await sleep(240)
check('一键套用「正文」把标题打回段落', beforeReset === 'H3' && (await tagOf('第三段恢复成正文')) === 'P', `${beforeReset} → ${await tagOf('第三段恢复成正文')}`)

/* ---------- 7) 一次选中多行：整片都套用同一级别 ---------- */
await reset('<p>甲段落</p><p>乙段落</p><p>丙段落</p>')
await page.evaluate(() => {
  // 选中从第一段开头到第三段结尾，模拟「拖选好几行」
  const ed = window.ed
  let from = -1
  let to = -1
  ed.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    if (from < 0) from = pos + 1
    to = pos + node.nodeSize - 1
  })
  ed.chain().focus().setTextSelection({ from, to }).run()
  localStorage.setItem('scofendoc:lastHeading', '2')
})
await sleep(200)
await page.click(mainBtn)
await sleep(260)
const multi = await page.evaluate(() =>
  [...document.querySelectorAll('.ProseMirror > *')].map((el) => el.tagName).join(','),
)
check('跨多行选中时主键一次把整片都刷成 H2', multi === 'H2,H2,H2', multi)

/* ---------- 8) 跨刷新仍然记得 ---------- */
await page.reload({ waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await sleep(200)
check('刷新后记忆仍在', (await storedLevel()) === '2', String(await storedLevel()))

check('无运行时报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)

/**
 * 查找替换面板验收（本地冒烟页，不连后端）
 *   node find-replace-check.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] || 'http://127.0.0.1:5388/find-smoke.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server'],
  defaultViewport: { width: 1200, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
page.on('console', (m) => {
  // 冒烟页没有 favicon，浏览器会报一条 404，与功能无关
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 160))
})

await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.waitForSelector('.find-panel')
await page.waitForFunction(() => !!window.ed)

const count = () => page.$eval('.fr-count', (el) => el.textContent.trim())
const hits = () =>
  page.evaluate(() => ({
    all: document.querySelectorAll('.ProseMirror .fr-hit').length,
    cur: document.querySelectorAll('.ProseMirror .fr-cur').length,
  }))
const text = () => page.evaluate(() => window.ed.getText())
const type = async (sel, value) => {
  await page.click(sel, { clickCount: 3 })
  await page.type(sel, value, { delay: 12 })
  await sleep(220)
}

check('面板默认打开且聚焦查找框', await page.evaluate(() => document.activeElement?.classList.contains('fr-input')))

await type('.find-panel .fr-input', 'Java')
check('命中计数 1/3', (await count()) === '1/3', await count())
let h = await hits()
check('高亮 3 处、当前项 1 处', h.all === 3 && h.cur === 1, JSON.stringify(h))

await page.keyboard.press('Enter')
await sleep(180)
check('Enter 跳到下一个 2/3', (await count()) === '2/3', await count())
await page.keyboard.down('Shift')
await page.keyboard.press('Enter')
await page.keyboard.up('Shift')
await sleep(180)
check('Shift+Enter 回到上一个 1/3', (await count()) === '1/3', await count())

// 跨块：两个块之间不能匹配
await type('.find-panel .fr-input', 'Map。list')
check('不跨块匹配', (await count()) === '无结果', await count())

// 大小写
await type('.find-panel .fr-input', 'list')
const insensitive = await count()
await page.click('.find-panel .fr-ic[title="区分大小写"]')
await sleep(200)
const sensitive = await count()
check('默认忽略大小写（list 命中 List/LIST/list）', insensitive === '1/3', insensitive)
check('开启后区分大小写（只剩 1 处）', sensitive === '1/1', sensitive)
await page.click('.find-panel .fr-ic[title="区分大小写"]')
await sleep(150)

// 单次替换
await type('.find-panel .fr-input', 'Java')
await page.click('.find-panel .fr-ic[title="替换"]')
await sleep(200)
await page.click('.find-panel .fr-replace', { clickCount: 3 })
await page.type('.find-panel .fr-replace', 'Kotlin', { delay: 10 })
await sleep(150)
await page.click('.find-panel .fr-btn:nth-of-type(1)')
await sleep(260)
const afterOne = await text()
check('替换 1 处后计数变 2', (await count()).startsWith('1/2') || (await count()) === '2/2', await count())
check('正文出现 Kotlin、Java 少一个', /Kotlin/.test(afterOne) && (afterOne.match(/Java/g) || []).length === 2, afterOne.replace(/\s+/g, ' ').slice(0, 60))

await page.evaluate(() => window.ed.commands.undo())
await sleep(220)
check('撤销恢复被替换的那处', (await text()).match(/Java/g)?.length === 3, (await text()).replace(/\s+/g, ' ').slice(0, 60))

// 全部替换 + 一次撤销
await type('.find-panel .fr-input', 'Java')
await page.click('.find-panel .fr-btn:nth-of-type(2)')
await sleep(280)
const afterAll = await text()
check('全部替换后无残留 Java', !/Java/.test(afterAll) && (afterAll.match(/Kotlin/g) || []).length === 3, afterAll.replace(/\s+/g, ' ').slice(0, 70))
check('替换后计数显示无结果', (await count()) === '无结果' || (await count()) === '', await count())

await page.evaluate(() => window.ed.commands.undo())
await sleep(220)
check('一次撤销回退整批替换', (await text()).match(/Java/g)?.length === 3, (await text()).replace(/\s+/g, ' ').slice(0, 60))

// Esc 关闭
await page.keyboard.press('Escape')
await sleep(200)
check('Esc 关闭面板', (await page.$('.find-panel')) === null)
check('无运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)

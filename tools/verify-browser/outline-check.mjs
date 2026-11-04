#!/usr/bin/env node
/**
 * 大纲跳转体检（只读）：反复点同一个大纲节点，确认滚动位置稳定。
 *
 * 用法: node outline-check.mjs <jwtSecret> <userId> [docTitle] [outDir]
 *
 * 判定标准：
 *   1) 三次点击后的 scrollTop 基本一致（差值 < 4px）
 *   2) 点击落点处标题距滚动容器顶部 ≈ 12px（jump 的留白）
 * 旧实现的 bug：绝对偏移里又叠加了一次 scrollTop，每点一次就多滚一屏。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, docTitle = '6.1-agent开发', outDir = '/tmp/outline-shots'] = process.argv.slice(2)
if (!secret || !userId) {
  console.error('usage: node outline-check.mjs <jwtSecret> <userId> [docTitle] [outDir]')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)
fs.mkdirSync(outDir, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto('http://47.117.110.143/scofendoc/?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem(
    'scofendoc.user',
    JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }),
  )
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await wait(1200)

// 打开目标文档（先等文档树渲染出来，否则点击会落空）
await page.waitForFunction(
  (title) => [...document.querySelectorAll('.tree-row')].some((n) => n.textContent.includes(title)),
  { timeout: 20000 },
  docTitle,
)
await page.evaluate((title) => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes(title))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, docTitle)
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror').length > 0, { timeout: 30000 })
// 等正文与大纲都就绪（协同内容是异步到达的）
await page.waitForFunction(
  () => {
    const pm = document.querySelector('.ProseMirror')
    return !!pm && pm.querySelectorAll('h1, h2, h3').length > 0 && document.querySelectorAll('.outline-item').length > 0
  },
  { timeout: 30000 },
)
await wait(1200)

/** 校准：把容器滚到中部，确保点第 3 个标题时上下都有空间（否则会被 clamp 掩盖问题） */
await page.evaluate(() => {
  const main = document.querySelector('.main')
  if (main) main.scrollTop = 1500
})
await wait(400)

const before = await page.evaluate(() => {
  const main = document.querySelector('.main')
  const items = [...document.querySelectorAll('.outline-item')]
  return { outlineCount: items.length, scrollTop: main?.scrollTop ?? -1, maxScroll: (main?.scrollHeight ?? 0) - (main?.clientHeight ?? 0) }
})
console.log('初始:', JSON.stringify(before))

const target = 3 // 第 4 个节点，索引固定，避免多次点击时被高亮重排影响
const rounds = []
for (let n = 1; n <= 3; n++) {
  const clickedText = await page.evaluate((i) => {
    const items = [...document.querySelectorAll('.outline-item')]
    const el = items[i]
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (el?.textContent || '').replace(/\s+/g, ' ').trim()
  }, target)
  await wait(1100) // 等 smooth 滚动结束
  const snap = await page.evaluate(
    (want) => {
      const main = document.querySelector('.main')
      const pm = document.querySelector('.ProseMirror')
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const heads = [...(pm?.querySelectorAll('h1, h2, h3') ?? [])].filter((h) => !h.closest('.fold-hidden'))
      // 按文字定位被点的那个标题，避免「大纲过滤空标题」导致的索引错位
      const h = heads.find((x) => norm(x.textContent) === want) ?? null
      const off = h && main ? h.getBoundingClientRect().top - main.getBoundingClientRect().top : null
      const active = document.querySelector('.outline-item.on')?.textContent?.trim() ?? ''
      return {
        scrollTop: main ? Math.round(main.scrollTop) : -1,
        headingTopInView: off === null ? null : Math.round(off),
        headingText: norm(h?.textContent).slice(0, 20),
        matched: !!h,
        active: active.slice(0, 20),
      }
    },
    clickedText,
  )
  rounds.push(snap)
  console.log(`第 ${n} 次点击 [${clickedText.slice(0, 16)}]:`, JSON.stringify(snap))
  await page.screenshot({ path: `${outDir}/outline-${n}.png` })
}

const tops = rounds.map((r) => r.scrollTop)
const spread = Math.max(...tops) - Math.min(...tops)
const headingTop = rounds[rounds.length - 1].headingTopInView
const matched = rounds.every((r) => r.matched)
const ok = matched && spread < 4 && headingTop !== null && Math.abs(headingTop - 12) <= 6

console.log('\n判定:')
console.log('  标题按文字匹配:', matched ? 'OK' : 'FAIL(没找到对应标题，脚本需调整)')
console.log('  scrollTop 三次:', tops.join(' / '), `极差=${spread}px`, spread < 4 ? 'OK(稳定)' : 'FAIL(越点越偏)')
console.log('  标题距容器顶部:', headingTop, 'px（期望≈12）', headingTop !== null && Math.abs(headingTop - 12) <= 6 ? 'OK' : 'FAIL')
console.log(ok ? '\n✅ PASS 同一节点多次点击落点一致' : '\n❌ FAIL 跳转位置不稳定')
await browser.close()
process.exit(ok ? 0 : 1)

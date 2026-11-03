#!/usr/bin/env node
/**
 * 团队空间「技术栈」树核对（只读）
 * 用法: node verify-techstack.mjs <jwtSecret> <userId> <outPrefix>
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const [secret, userId, outPrefix = '/tmp/techstack', keyword = 'Redis'] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '20m' })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto('http://47.117.110.143/lightdoc/', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('lightdoc.token', t)
  localStorage.setItem('lightdoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)

// ?space=2 = 团队空间，App 启动时按 URL 参数选空间
await page.goto('http://47.117.110.143/lightdoc/?space=2', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.tree .title, .tree .rename-input').length > 0, { timeout: 30000 })
await new Promise((r) => setTimeout(r, 1200))

const tree = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tree > div')].filter((d) => d.querySelector('.title'))
  return rows.map((r) => ({
    depth: Number(getComputedStyle(r.querySelector('.title')).paddingLeft.replace('px', '')) || 0,
    title: r.querySelector('.title').textContent.trim(),
    indent: r.style.paddingLeft || getComputedStyle(r).paddingLeft,
  }))
})
console.log('树行数：', tree.length)
tree.slice(0, 6).forEach((t) => console.log('  ', JSON.stringify(t)))
console.log('   …')
tree.slice(-3).forEach((t) => console.log('  ', JSON.stringify(t)))

// 展开状态：子项是否真的缩进在 技术栈 之下
const uniq = [...new Set(tree.map((t) => t.indent))]
console.log('缩进层级取值：', uniq)

await page.screenshot({ path: `${outPrefix}-tree.png` })

// 打开一篇正文，确认渲染
const target = keyword
await page.evaluate((kw) => {
  const rows = [...document.querySelectorAll('.tree > div')]
  const hit = rows.find((r) => r.querySelector('.title')?.textContent.includes(kw))
  hit?.querySelector('.title')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, target)
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length > 0, { timeout: 30000 }).catch(() => {})
await new Promise((r) => setTimeout(r, 2000))

const doc = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  return {
    status: document.querySelector('.collab .status')?.textContent?.trim(),
    headings: [...(pm?.querySelectorAll('h2,h3') || [])].map((h) => h.innerText.slice(0, 30)).slice(0, 8),
    tables: pm?.querySelectorAll('table').length || 0,
    chars: pm?.innerText.length || 0,
    breadcrumb: document.querySelector('.breadcrumb')?.innerText?.trim() || '',
  }
})
console.log('打开文档：', JSON.stringify(doc))
await page.screenshot({ path: `${outPrefix}-doc.png` })

if (errors.length) console.log('页面错误：', [...new Set(errors)].slice(0, 5))
await browser.close()

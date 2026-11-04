#!/usr/bin/env node
/** 探针：悬停图块时，图块各层盒子与 ＋ 的实际坐标 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const [secret, userId, docTitle = '6.1-agent开发'] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.goto('http://47.117.110.143/scofendoc/?space=2', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await wait(1200)
await page.evaluate((title) => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes(title))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, docTitle)
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror').length > 0, { timeout: 30000 })
await wait(2200)

const info = await page.evaluate(() => {
  const wrap = document.querySelector('.mermaid-block')
  const r = wrap.getBoundingClientRect()
  const kids = [...wrap.children].map((c) => {
    const cr = c.getBoundingClientRect()
    return { tag: c.tagName + '.' + String(c.className).split(' ')[0], top: Math.round(cr.top), h: Math.round(cr.height) }
  })
  const parent = wrap.parentElement
  const pr = parent.getBoundingClientRect()
  return {
    wrap: { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height) },
    parent: { tag: parent.tagName + '.' + String(parent.className).split(' ')[0], top: Math.round(pr.top), h: Math.round(pr.height) },
    kids,
  }
})
console.log(JSON.stringify(info, null, 2))

const target = await page.evaluate(() => {
  const r = document.querySelector('.mermaid-block').getBoundingClientRect()
  return { x: Math.round(r.left + 200), y: Math.round(r.top + r.height / 2) }
})
await page.mouse.move(target.x, target.y, { steps: 6 })
await wait(300)
const dot = await page.evaluate(() => {
  const d = document.querySelector('.plus-dot')
  if (!d) return null
  const r = d.getBoundingClientRect()
  return { top: Math.round(r.top), left: Math.round(r.left) }
})
console.log('鼠标', target, '→ ＋', dot)
await browser.close()

import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
const [secret, userId] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '30m' })
const BASE = 'http://47.117.110.143/scofendoc/'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 } })
const page = await browser.newPage()
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.goto(BASE + '?space=2&doc=19', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror a[href*="doc="]').length > 5, { timeout: 40000 })
await new Promise((r) => setTimeout(r, 2500))
// 滚到第一张表（文档清单）
await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  const s = document.querySelector('.main')
  if (t && s) s.scrollTop = s.scrollTop + t.getBoundingClientRect().top - s.getBoundingClientRect().top - 120
})
await new Promise((r) => setTimeout(r, 1200))
await page.screenshot({ path: '/tmp/index-table.png' })
const info = await page.evaluate(() => {
  const t = document.querySelector('.ProseMirror table')
  return {
    rows: t?.querySelectorAll('tr').length,
    linksInTable: t?.querySelectorAll('a').length,
    sample: [...(t?.querySelectorAll('a') || [])].slice(0, 3).map((a) => a.textContent + ' → ' + a.getAttribute('href')),
  }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()

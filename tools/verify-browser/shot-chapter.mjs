import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
const [secret, userId, docId] = process.argv.slice(2)
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
await page.goto(BASE + '?space=2&doc=' + docId, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror a[href*="doc="]').length > 0, { timeout: 40000 })
await new Promise((r) => setTimeout(r, 1500))
const info = await page.evaluate(() => ({
  title: document.querySelector('.title-input')?.value,
  links: document.querySelectorAll('.ProseMirror a[href*="doc="]').length,
  rows: document.querySelectorAll('.ProseMirror table tr').length,
  sample: [...document.querySelectorAll('.ProseMirror a[href*="doc="]')].slice(0, 4).map((a) => a.textContent.trim() + ' → ' + a.getAttribute('href')),
}))
console.log(JSON.stringify(info, null, 1))
await page.screenshot({ path: `/tmp/chapter-${docId}.png` })
await browser.close()

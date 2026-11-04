import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
const [secret, userId] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '30m' })
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 200)))
page.on('pageerror', (e) => logs.push('ERR ' + String(e).slice(0, 300)))
const BASE = 'http://47.117.110.143/scofendoc/'
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.goto(BASE + '?space=2&doc=19', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 8000))
const info = await page.evaluate(() => ({
  url: location.search,
  title: document.querySelector('.title-input')?.value,
  status: document.querySelector('.status')?.textContent,
  pm: !!document.querySelector('.ProseMirror'),
  anchors: document.querySelectorAll('.ProseMirror a').length,
  innerAnchors: document.querySelectorAll('.ProseMirror a[href*="doc="]').length,
  firstHrefs: [...document.querySelectorAll('.ProseMirror a')].slice(0, 5).map((a) => a.getAttribute('href')),
  html: document.querySelector('.ProseMirror')?.innerHTML.slice(0, 400),
  hints: document.querySelector('.hint')?.textContent,
}))
console.log(JSON.stringify(info, null, 1))
console.log('logs:', logs.slice(-8))
await page.screenshot({ path: '/tmp/diag-jump.png' })
await browser.close()

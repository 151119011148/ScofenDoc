import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
const [secret, userId, docId] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '30m' })
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
const BASE = 'http://47.117.110.143/scofendoc/'
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.goto(BASE + '?space=2&doc=' + docId, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 6000))
const info = await page.evaluate(() => ({
  title: document.querySelector('.title-input')?.value,
  h2: [...document.querySelectorAll('.ProseMirror h2')].map((h) => h.textContent.trim().slice(0, 20)),
  a: document.querySelectorAll('.ProseMirror a').length,
  href: document.querySelectorAll('.ProseMirror [href]').length,
  htmlHasDoc: document.querySelector('.ProseMirror')?.innerHTML.includes('doc='),
  textLen: (document.querySelector('.ProseMirror')?.innerText || '').length,
}))
console.log(JSON.stringify(info, null, 1))
await browser.close()

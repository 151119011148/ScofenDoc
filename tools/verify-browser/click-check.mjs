import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
const [secret, userId] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '30m' })
const BASE = 'http://47.117.110.143/scofendoc/'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } })
const page = await browser.newPage()
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.goto(BASE + '?space=2&doc=19', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror a[href*="doc="]').length > 5, { timeout: 40000 })
await new Promise((r) => setTimeout(r, 600))
const result = await page.evaluate(async () => {
  window.__mark = 'alive'
  const a = document.querySelector('.ProseMirror a[href*="doc=21"]')
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 1200))
  return {
    reloaded: window.__mark !== 'alive',
    url: location.search,
    title: document.querySelector('.title-input')?.value,
    navType: performance.getEntriesByType('navigation')[0]?.type,
  }
})
console.log(JSON.stringify(result))
// 再看外链是否 target=_blank
const ext = await page.evaluate(() => document.querySelector('.ProseMirror a[href^="http"]')?.outerHTML.slice(0, 160))
console.log('外链示例:', ext)
await browser.close()

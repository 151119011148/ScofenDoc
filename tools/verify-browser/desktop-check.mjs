#!/usr/bin/env node
/**
 * 桌面端回归（只读）：确认移动端改造没有把桌面布局带偏
 * 用法: node desktop-check.mjs <jwtSecret> <userId> [outDir]
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, outDir = '/tmp/desktop-shots'] = process.argv.slice(2)
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
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await wait(1200)
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.tree-row')].find((n) => n.textContent.includes('6.1-agent开发'))
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror').length > 0, { timeout: 30000 })
await wait(2000)

const m = await page.evaluate(() => {
  const rail = document.querySelector('.nav-rail')
  const topbar = document.querySelector('.m-topbar')
  const handle = document.querySelector('.resize-handle')
  const rr = rail?.getBoundingClientRect()
  return {
    topbarDisplay: topbar ? getComputedStyle(topbar).display : 'missing',
    rail: rr ? { left: Math.round(rr.left), width: Math.round(rr.width), position: getComputedStyle(rail).position } : null,
    resizeHandle: !!handle && getComputedStyle(handle).display !== 'none',
    outlineCol: (() => {
      const el = document.querySelector('.outline-col')
      return el ? getComputedStyle(el).display : 'none'
    })(),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    docWidth: document.documentElement.scrollWidth,
  }
})
console.log(JSON.stringify(m, null, 2))
await page.screenshot({ path: `${outDir}/desktop-doc.png` })
console.log('shot', `${outDir}/desktop-doc.png`)
await browser.close()

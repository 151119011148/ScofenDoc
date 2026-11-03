#!/usr/bin/env node
/**
 * 长文档分段截图 + 版面体检（只读）
 * 用法: node shots.mjs <jwtSecret> <userId> <docKeyword> <outDir>
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, keyword, outDir = '/tmp/scofendoc-shots'] = process.argv.slice(2)
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
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
await page.goto('http://47.117.110.143/scofendoc/', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate((kw) => {
  const hit = [...document.querySelectorAll('div,li')].find((n) => n.textContent.includes(kw) && n.children.length <= 3)
  hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}, keyword)
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length > 0, { timeout: 30000 })
await new Promise((r) => setTimeout(r, 2000))

const metrics = await page.evaluate(() => {
  const main = document.querySelector('.main')
  const pm = document.querySelector('.ProseMirror')
  const tables = [...document.querySelectorAll('.ProseMirror table')]
  const overflow = tables
    .map((t, i) => ({ i, sw: t.scrollWidth, cw: t.parentElement?.clientWidth || 0 }))
    .filter((x) => x.sw > x.cw + 2)
  return {
    mainScrollHeight: main?.scrollHeight || 0,
    mainClientHeight: main?.clientHeight || 0,
    pmHeight: pm?.getBoundingClientRect().height || 0,
    docScrollWidth: document.documentElement.scrollWidth,
    tables: tables.length,
    tablesOverflowing: overflow.length,
    codeBlocks: document.querySelectorAll('.ProseMirror pre').length,
    listItems: document.querySelectorAll('.ProseMirror li').length,
    hr: document.querySelectorAll('.ProseMirror hr').length,
  }
})
console.log(JSON.stringify(metrics, null, 2))

const offsets = [800, 3000, 7000, 12000, 18000]
for (let i = 0; i < offsets.length; i++) {
  const y = Math.min(offsets[i], metrics.mainScrollHeight - 900)
  await page.evaluate((target) => {
    const main = document.querySelector('.main')
    if (main) main.scrollTop = target
  }, y)
  await new Promise((r) => setTimeout(r, 600))
  await page.screenshot({ path: `${outDir}/${String(i + 1).padStart(2, '0')}-${y}.png` })
  console.log('shot', `${outDir}/${String(i + 1).padStart(2, '0')}-${y}.png`)
}
await browser.close()

#!/usr/bin/env node
/** 表格/内容溢出诊断：逐层量容器宽度，找出是谁把表格裁掉了 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const [secret, userId] = process.argv.slice(2)
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign({ sub: String(userId), typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' }, key, { algorithm: 'HS256', expiresIn: '20m' })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
await page.goto('http://47.117.110.143/lightdoc/', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('lightdoc.token', t)
  localStorage.setItem('lightdoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('div,li')].find((n) => n.textContent.includes('个人履历详解') && n.children.length <= 3)
  hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length > 0, { timeout: 30000 })
await new Promise((r) => setTimeout(r, 1500))

const info = await page.evaluate(() => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { cls: el.className?.toString?.().slice(0, 40), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), clientW: el.clientWidth, scrollW: el.scrollWidth, overflowX: cs.overflowX, padding: cs.padding, boxSizing: cs.boxSizing }
  }
  const tables = [...document.querySelectorAll('.ProseMirror table')]
  const widest = tables.map((t) => ({ w: Math.round(t.getBoundingClientRect().width), right: Math.round(t.getBoundingClientRect().right), wrapperW: t.parentElement.clientWidth, scrollW: t.scrollWidth }))
  widest.sort((a, b) => b.w - a.w)
  return {
    chain: ['.main', '.collab', '.collab .content', '.ProseMirror'].map((s) => ({ sel: s, ...rect(document.querySelector(s)) })),
    tables: tables.length,
    widest5: widest.slice(0, 5),
    wrapper: rect(document.querySelector('.ProseMirror .tableWrapper')),
  }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()

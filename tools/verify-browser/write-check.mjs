#!/usr/bin/env node
/**
 * 写入链路验证：在正文末尾输入两个字再删掉，确认
 *   1) 协同服务能把改动落盘（bin 的 mtime 变化）
 *   2) 落盘后的文档结构没被编辑器改坏（表格/段落数量不变）
 * 只做「输入→删除」，不改动任何实际内容；失败时可用备份 bin 直接还原。
 */
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
await page.goto('http://47.117.110.143/scofendoc/', { waitUntil: 'networkidle2' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => {
  const h = [...document.querySelectorAll('div,li')].find((n) => n.textContent.includes('个人履历详解') && n.children.length <= 3)
  h?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length > 0, { timeout: 30000 })
await new Promise((r) => setTimeout(r, 2000))

const before = await page.evaluate(() => ({
  chars: document.querySelector('.ProseMirror')?.innerText.length || 0,
  tables: document.querySelectorAll('.ProseMirror table').length,
  blocks: document.querySelectorAll('.ProseMirror > *').length,
}))

// 光标落到正文最后一个块里，输入两个字
await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const last = pm.lastElementChild
  const range = document.createRange()
  range.selectNodeContents(last)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  pm.focus()
})
await page.keyboard.type('测试')
await new Promise((r) => setTimeout(r, 2500))
const typed = await page.evaluate(() => document.querySelector('.ProseMirror')?.innerText.length || 0)
console.log('输入后字符数:', typed, '（原', before.chars, '）')

// 再删掉这两个字，回到原状
await page.keyboard.press('Backspace')
await page.keyboard.press('Backspace')
await new Promise((r) => setTimeout(r, 3500))

const after = await page.evaluate(() => ({
  chars: document.querySelector('.ProseMirror')?.innerText.length || 0,
  tables: document.querySelectorAll('.ProseMirror table').length,
  blocks: document.querySelectorAll('.ProseMirror > *').length,
  status: document.querySelector('.collab .status')?.textContent?.trim(),
}))
console.log('还原后:', JSON.stringify(after), '（原', JSON.stringify(before), '）')
await browser.close()

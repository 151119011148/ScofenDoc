#!/usr/bin/env node
/**
 * 线上页面核对脚本（只读，不改任何数据）
 *
 * 为什么要自己签 token：注册已收紧，手上没有用户密码，但又要看真实渲染结果。
 * 这里用与后端完全相同的派生方式（JWT_SECRET 先 SHA-256 再作 HS256 密钥）
 * 签一个 typ=auth 的短期登录态，注入 localStorage 后打开页面截图；
 * 不开写权限、不碰数据库，用完即弃。
 *
 * 用法：
 *   NODE_PATH=. node verify-doc.mjs <jwtSecret> <userId> <userName> <docTitleKeyword> <outPrefix>
 */

import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'

const [secret, userId, userName, titleKeyword, outPrefix] = process.argv.slice(2)
if (!secret || !userId || !titleKeyword) {
  console.error('用法: node verify-doc.mjs <jwtSecret> <userId> <userName> <docTitleKeyword> <outPrefix>')
  process.exit(1)
}

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: String(userId), typ: 'auth', pv: 0, uname: userName, dn: userName, color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '20m' },
)

const BASE = process.env.BASE_URL || 'http://47.117.110.143/lightdoc/'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
})

const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

const log = (...a) => console.log(...a)

await page.goto(BASE, { waitUntil: 'networkidle2' })

// 先落地登录态，再刷新让应用以已登录身份启动
await page.evaluate(
  (t, u) => {
    localStorage.setItem('lightdoc.token', t)
    localStorage.setItem('lightdoc.user', JSON.stringify({ id: Number(u), username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
  },
  token,
  userId,
)

await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1500))

// 目录里点开目标文档
const clicked = await page.evaluate((kw) => {
  const nodes = [...document.querySelectorAll('.doc-item, .tree-item, li, div')]
  const hit = nodes.find((n) => n.textContent && n.textContent.includes(kw) && n.children.length <= 3)
  if (!hit) return false
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return true
}, titleKeyword)
log('点击目标文档：', clicked)

// 等协同连接 + 首屏渲染
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length > 0, { timeout: 30000 }).catch(() => {})
await new Promise((r) => setTimeout(r, 2500))

const report = await page.evaluate(() => {
  const root = document.querySelector('.ProseMirror')
  const text = root ? root.innerText : ''
  return {
    status: document.querySelector('.collab .status')?.textContent?.trim() || '',
    headings: [...(root?.querySelectorAll('h1,h2,h3,h4') || [])].map((h) => h.tagName + ' ' + h.innerText.slice(0, 40)),
    tables: root?.querySelectorAll('table').length || 0,
    rows: root?.querySelectorAll('table tr').length || 0,
    firstTable: root?.querySelector('table')?.innerText?.slice(0, 200) || '',
    chars: text.length,
    empty: text.trim().length === 0,
    title: document.querySelector('.title-input, input[type="text"]')?.value || '',
    tree: [...document.querySelectorAll('.doc-title, .doc-name')].map((n) => n.textContent.trim()).slice(0, 10),
  }
})

log('协同状态：', report.status)
log('标题数量：', report.headings.length, report.headings.slice(0, 6))
log('表格数：', report.tables, '行数：', report.rows)
log('首表内容：', report.firstTable.replace(/\n/g, ' | ').slice(0, 160))
log('正文字符数：', report.chars, report.empty ? '（空！）' : '')
log('目录：', report.tree)

await page.screenshot({ path: `${outPrefix}-top.png` })
// 滚到中段再截一张，确认长文与表格滚动表现
await page.evaluate(() => {
  const el = document.querySelector('.content') || document.querySelector('.ProseMirror')
  if (el) el.scrollTop = 2200
  window.scrollTo(0, 2200)
})
await new Promise((r) => setTimeout(r, 800))
await page.screenshot({ path: `${outPrefix}-mid.png` })

if (errors.length) {
  log('页面错误：')
  ;[...new Set(errors)].slice(0, 8).forEach((e) => log('  ', e.slice(0, 200)))
}

fs.writeFileSync(`${outPrefix}-report.json`, JSON.stringify(report, null, 2))
await browser.close()

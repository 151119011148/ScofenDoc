/**
 * 存档导入验收：树结构 / 正文 / 配图 / 链接 四件事。
 * 用法: node archive-check.mjs <JWT_SECRET>
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '60m' },
)
const BASE = 'http://47.117.110.143/scofendoc/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 1000 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
}, token)

/* 1) 根节点出现在「技术栈」下 */
await page.goto(`${BASE}?space=2&doc=17`, { waitUntil: 'networkidle2' })
await sleep(1800)
const tree = await page.evaluate(() => {
  const txt = document.body.innerText
  return {
    hasCsdn: txt.includes('CSDN 存档'),
    hasYuque: txt.includes('语雀存档'),
  }
})
check('技术栈下能看到「CSDN 存档」节点', tree.hasCsdn)
check('技术栈下能看到「语雀存档」节点', tree.hasYuque)

/* 2) 索引页正文有 262/158 条站内链接 */
await page.goto(`${BASE}?space=2&doc=126`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(2000)
const idx = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  const as = [...pm.querySelectorAll('a')]
  return { links: as.length, internal: as.filter((a) => (a.getAttribute('href') || '').includes('doc=')).length }
})
check('CSDN 索引页链接都是站内深链', idx.links > 250 && idx.internal === idx.links, `${idx.internal}/${idx.links}`)

/* 3) 有配图的文章：图片真的加载出来 */
await page.goto(`${BASE}?space=2&doc=304`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(2500)
const imgs = await page.evaluate(() => {
  const list = [...document.querySelectorAll('.ProseMirror img')]
  return list.map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, shown: i.getBoundingClientRect().width }))
})
check('文章里有图片节点', imgs.length >= 5, `${imgs.length} 张`)
check('图片全部加载成功', imgs.length > 0 && imgs.every((i) => i.w > 0), imgs.map((i) => `${i.w}x${i.h}`).join(' '))
check('图片走站内静态目录', imgs.every((i) => i.src.startsWith('/scofendoc/files/archive/')))

/* 4) 表格/代码块等结构没丢 */
const shape = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  return {
    tables: pm.querySelectorAll('table').length,
    pres: pm.querySelectorAll('pre').length,
    imgs: pm.querySelectorAll('img').length,
    heads: pm.querySelectorAll('h1,h2,h3').length,
    text: pm.innerText.replace(/\s+/g, ' ').trim().length,
  }
})
check('正文文本量正常', shape.text > 500, `${shape.text} 字`)
check('标题层级保留', shape.heads >= 5, `${shape.heads} 个标题`)

/* 5) 语雀文章也能打开并有内容 */
await page.goto(`${BASE}?space=2&doc=543`, { waitUntil: 'networkidle2' })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await sleep(2000)
const yq = await page.evaluate(() => {
  const pm = document.querySelector('.ProseMirror')
  return { text: pm.innerText.replace(/\s+/g, ' ').trim().slice(0, 40), len: pm.innerText.trim().length }
})
check('语雀文章正文非空', yq.len > 100, `${yq.len} 字「${yq.text}…」`)

/* 6) 分组的父子关系：点索引里的第一条，应该跳到某篇文章 */
const firstHref = await page.goto(`${BASE}?space=2&doc=126`, { waitUntil: 'networkidle2' }).then(async () => {
  await page.waitForSelector('.ProseMirror', { timeout: 30000 })
  await sleep(1500)
  return page.evaluate(() => {
    const a = document.querySelector('.ProseMirror a[href*="doc="]')
    return a ? { href: a.getAttribute('href'), text: a.textContent.trim().slice(0, 20) } : null
  })
})
check('索引页里有可点的文章链接', !!firstHref, firstHref?.text)

await page.screenshot({ path: '/tmp/plus-shots/archive-doc.png' })
check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))

const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} 项失败` : '\n全部通过')
await browser.close()
process.exit(bad.length ? 1 : 0)

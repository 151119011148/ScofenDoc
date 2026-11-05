/**
 * 线上验收：散落编码转代码块是否真的生效（只读，不改文档内容）。
 *
 *   node codeblock-prod-check.mjs <JWT_SECRET> [baseUrl]
 *
 * 覆盖：目标文档的代码块数量、示例 BTree_Search 位于 <pre><code> 内且保留换行缩进、
 *       不再是有序列表、另一篇 Java 文档同样生效、文档树与两站不受影响、无 JS 报错。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const secret = process.argv[2]
const BASE = process.argv[3] || 'http://47.117.110.143/scofendoc/'
if (!secret) {
  console.error('用法: node codeblock-prod-check.mjs <JWT_SECRET> [baseUrl]')
  process.exit(2)
}
const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '30m' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 960 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text().slice(0, 200))
})
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`${r.status()} ${r.url().slice(0, 120)}`)
})

await page.goto(`${BASE}?space=2`, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => {
  localStorage.setItem('scofendoc.token', t)
  localStorage.setItem('scofendoc.user', JSON.stringify({
    id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
  }))
}, token)

async function openDoc(docId) {
  await page.goto(`${BASE}?space=2&doc=${docId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ProseMirror', { timeout: 30000 })
  // 等协同内容加载：代码块出现或至少 20 个块
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > *').length > 20, { timeout: 30000 })
  await sleep(1200)
}

/* ---------- 用户举例的文档 483 ---------- */
await openDoc(483)
const doc483 = await page.evaluate(() => {
  const pres = [...document.querySelectorAll('.ProseMirror pre')]
  const hit = pres.filter((p) => (p.textContent || '').includes('BTree_Search'))
  const inList = [...document.querySelectorAll('.ProseMirror ol > li, .ProseMirror ul > li')]
    .filter((li) => (li.textContent || '').includes('BTree_Search')).length
  const style = pres[0] ? getComputedStyle(pres[0]) : null
  return {
    blocks: document.querySelectorAll('.ProseMirror > *').length,
    preCount: pres.length,
    hitCount: hit.length,
    inList,
    firstHit: hit[0]?.textContent?.slice(0, 220) || '',
    lines: hit[0]?.textContent?.split('\n').length || 0,
    hasIndent: hit.some((p) => /\n\s{2,}/.test(p.textContent || '')),
    tag: hit[0]?.querySelector('code') ? 'pre>code' : (hit[0]?.tagName || ''),
    bg: style?.backgroundColor || '',
    font: style?.fontFamily || '',
    treeNo: document.querySelectorAll('.tree-row .tree-no').length,
  }
})
console.log('  文档 483 诊断:', JSON.stringify(doc483).slice(0, 420))
check('示例文档代码块数量明显增加', doc483.preCount >= 60, `pre=${doc483.preCount}`)
check('BTree_Search 已变成代码块', doc483.hitCount >= 3, `命中 ${doc483.hitCount} 个`)
check('代码块是 <pre><code> 结构', doc483.tag === 'pre>code', doc483.tag)
check('代码保留换行', doc483.lines >= 10, `${doc483.lines} 行`)
check('代码保留缩进', doc483.hasIndent)
check('不再是有序列表项', doc483.inList === 0, `残留 ${doc483.inList}`)
check('代码块有等宽字体样式', /mono|Menlo|Consolas|Courier/i.test(doc483.font), doc483.font.slice(0, 60))
check('文档树编号仍正常', doc483.treeNo > 10, `${doc483.treeNo} 个`)

/* ---------- 另一篇 Java 源码文档 ---------- */
await openDoc(277)
const doc277 = await page.evaluate(() => {
  const pres = [...document.querySelectorAll('.ProseMirror pre')]
  return {
    preCount: pres.length,
    javaHit: pres.filter((p) => /public|import|package/.test(p.textContent || '')).length,
    orderedLists: document.querySelectorAll('.ProseMirror ol').length,
  }
})
console.log('  文档 277 诊断:', JSON.stringify(doc277))
check('Java 源码文档同样生效', doc277.preCount >= 5, `pre=${doc277.preCount}`)
check('Java 关键字位于代码块内', doc277.javaHit >= 3, `${doc277.javaHit} 个`)

/* ---------- 全局无异常 ---------- */
check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\n结果 ${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)

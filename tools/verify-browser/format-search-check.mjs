import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * 验收两件事：
 *  A. 搜索支持文档内容（标题 + 正文命中摘要）
 *  B. 选中跨多行文字能一次性统一调整格式（对齐 / 行高 / 字号 / 清除格式 / 混合态）
 *
 * 用法：node format-search-check.mjs <JWT_SECRET>
 * 写操作全部在临时文档里做，跑完删除；搜索部分是只读的。
 */
const secret = process.argv[2]
if (!secret) {
  console.error('用法：node format-search-check.mjs <JWT_SECRET>')
  process.exit(1)
}

const key = crypto.createHash('sha256').update(secret).digest()
const token = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  key,
  { algorithm: 'HS256', expiresIn: '60m' },
)
const ORIGIN = 'http://47.117.110.143'
const BASE = `${ORIGIN}/scofendoc/`
const API = `${ORIGIN}/scofendoc/api`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}

async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/* ================= A. 内容搜索（只读） ================= */
console.log('=== A. 文档内容搜索 ===')
{
  const r = await api('/docs/search?q=' + encodeURIComponent('最左前缀') + '&limit=30')
  const hits = Array.isArray(r.body) ? r.body : []
  const bt = hits.find((h) => h.id === 483)
  check('正文关键词「最左前缀」能命中 B+树文档', r.status === 200 && !!bt, `共 ${hits.length} 条`)
  check('正文命中带上下文片段', !!bt?.snippet && bt.snippet.includes('最左前缀'),
    bt?.snippet ? `摘要: ${bt.snippet.slice(0, 60)}…` : '无 snippet')
  check('正文命中带「正文命中」标记所需字段', !!bt?.snippet && !hits.some((h) => h.snippet && !String(h.snippet).length))

  const r2 = await api('/docs/search?q=' + encodeURIComponent('磁盘 I/O') + '&limit=30')
  const h2 = Array.isArray(r2.body) ? r2.body : []
  check('含空格的英文/中文混合词也能命中正文', h2.length > 0, `共 ${h2.length} 条`)

  const r3 = await api('/docs/search?q=' + encodeURIComponent('synchronized详解') + '&limit=30')
  const h3 = Array.isArray(r3.body) ? r3.body : []
  check('标题命中仍然有效', h3.some((h) => h.title.includes('synchronized')), `共 ${h3.length} 条`)

  const r4 = await api('/docs/search?q=' + encodeURIComponent('zzz绝对不存在的词xyz') + '&limit=30')
  check('无匹配时返回空列表', Array.isArray(r4.body) && r4.body.length === 0)

  const r5 = await api('/docs/search?q=1.1&limit=30')
  check('章节号查询仍可用', Array.isArray(r5.body) && r5.body.length > 0, `${(r5.body || []).length} 条`)
}

/* ================= B. 跨多行选区统一格式 ================= */
console.log('=== B. 跨多行选区统一格式 ===')
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--no-proxy-server'],
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    errors.push(m.text().slice(0, 200))
  }
})

let docId = null
try {
  const created = await api('/docs', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 2, parentId: null, title: '【临时】跨行格式验收' }),
  })
  docId = created.body?.id || null
  check('创建临时文档', !!docId, `id=${docId}`)
  if (!docId) throw new Error('临时文档创建失败')

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    localStorage.setItem('scofendoc.token', t)
    localStorage.setItem('scofendoc.user', JSON.stringify({
      id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true,
    }))
  }, token)
  await page.goto(`${BASE}?space=2&doc=${docId}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.ProseMirror', { timeout: 30000 })
  await sleep(1200)
  await page.click('.ProseMirror')
  for (const t of ['第一段 跨行格式测试', '第二段 跨行格式测试', '第三段 跨行格式测试', '第四段 跨行格式测试']) {
    await page.keyboard.type(t)
    await page.keyboard.press('Enter')
  }
  await sleep(700)

  const barHeight = await page.$eval('.collab .bar', (el) => Math.round(el.getBoundingClientRect().height))
  check('顶部格式栏保持单行（不遮挡正文）', barHeight < 60, `高度 ${barHeight}px`)

  /** 用 DOM Range 跨 1~3 段建立选区（ProseMirror 会同步成 TextSelection） */
  const selectAcross = () =>
    page.evaluate(() => {
      const ps = [...document.querySelectorAll('.ProseMirror > p')].filter((p) => p.textContent.trim())
      if (ps.length < 3) return 0
      const r = document.createRange()
      r.setStart(ps[0].firstChild, 0)
      const last = ps[2].lastChild
      r.setEnd(last, last.textContent.length)
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new Event('selectionchange'))
      return ps.length
    })

  const paragraphs = () =>
    page.$$eval('.ProseMirror > p', (els) =>
      els.filter((p) => p.textContent.trim()).map((p) => ({
        text: p.textContent.trim(),
        align: p.getAttribute('data-text-align'),
        line: p.getAttribute('data-line-height'),
        size: p.getAttribute('data-font-size'),
        style: p.getAttribute('style') || '',
      })),
    )

  const n = await selectAcross()
  check('成功建立跨 3 个段落的选区', n >= 3, `${n} 段`)
  await sleep(400)
  try {
    await page.waitForSelector('.sel-bar', { timeout: 4000 })
    check('跨多行选区仍会浮出格式条', true)
  } catch {
    check('跨多行选区仍会浮出格式条', false)
  }

  // 浮条应该跟着光标那一行，而不是贴在整片选区最顶端
  const anchor = await page.evaluate(() => {
    const bar = document.querySelector('.sel-bar')?.getBoundingClientRect()
    const sel = window.getSelection()
    if (!bar || !sel?.rangeCount) return null
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width || r.height)
    const last = rects[rects.length - 1]
    return { barTop: Math.round(bar.top), lastLineTop: Math.round(last?.top ?? -1) }
  })
  check('跨行时工具条锚在选区收尾行', !!anchor && Math.abs(anchor.lastLineTop - anchor.barTop) < 120,
    anchor ? `bar=${anchor.barTop} 末行=${anchor.lastLineTop}` : '量不到')

  const openPara = async () => {
    await page.click('.sel-bar button[title^="段落排版"]')
    await page.waitForSelector('.sel-panel.sel-para', { timeout: 3000 })
  }
  const clickChip = async (label) =>
    page.evaluate((l) => {
      const b = [...document.querySelectorAll('.sel-para .sel-chip')].find((x) => x.textContent.includes(l))
      if (!b) return false
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    }, label)

  await openPara()
  const hint = await page.$eval('.sel-para .sel-hint', (e) => e.textContent.trim())
  check('段落面板识别出选中的所有段落', /3 个段落/.test(hint), hint)
  check('点「居中」成功', await clickChip('居中'))
  await sleep(350)
  let ps = await paragraphs()
  check('对齐一次性作用于全部 3 段', ps.slice(0, 3).every((p) => p.align === 'center'),
    ps.slice(0, 3).map((p) => p.align).join('/'))

  await selectAcross()
  await sleep(300)
  await openPara()
  check('点行高「宽松」成功', await clickChip('宽松'))
  await sleep(350)
  ps = await paragraphs()
  check('行高一次性作用于全部 3 段', ps.slice(0, 3).every((p) => p.line === '2'),
    ps.slice(0, 3).map((p) => p.line).join('/'))

  await selectAcross()
  await sleep(300)
  await openPara()
  check('点字号「大」成功', await clickChip('大'))
  await sleep(350)
  ps = await paragraphs()
  check('字号一次性作用于全部 3 段', ps.slice(0, 3).every((p) => p.size === '18'),
    ps.slice(0, 3).map((p) => p.size).join('/'))
  check('三个属性可叠加（inline style 合并）',
    ps.slice(0, 3).every((p) => /text-align/.test(p.style) && /line-height/.test(p.style) && /font-size/.test(p.style)),
    ps[0]?.style.slice(0, 90) || '')

  // 顶部固定格式栏的「¶」下拉：右对齐 + 清除格式
  const barMenuClick = async (label) => {
    await page.click('.para-dd .num-main')
    await page.waitForSelector('.para-dd-menu', { timeout: 3000 })
    return page.evaluate((l) => {
      const b = [...document.querySelectorAll('.para-dd-menu button')].find((x) => x.textContent.includes(l))
      if (!b) return false
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    }, label)
  }
  await selectAcross()
  await sleep(300)
  check('顶部栏下拉能点「右对齐」', await barMenuClick('右对齐'))
  await sleep(350)
  ps = await paragraphs()
  check('顶部栏右对齐同样覆盖 3 段', ps.slice(0, 3).every((p) => p.align === 'right'),
    ps.slice(0, 3).map((p) => p.align).join('/'))

  // 混合格式：只给第一段的一小段加粗，再跨行选中
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror > p')].find((x) => x.textContent.trim())
    const r = document.createRange()
    r.setStart(p.firstChild, 0)
    r.setEnd(p.firstChild, 3)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await sleep(400)
  await page.click('.sel-bar button[title^="加粗"]')
  await sleep(300)
  await selectAcross()
  await sleep(400)
  const mixed = await page.$$eval('.sel-bar button.mixed', (els) => els.length)
  check('跨段混合格式时按钮显示第三态', mixed > 0, `${mixed} 个 mixed 按钮`)

  check('顶部栏下拉能点「清除格式」', await barMenuClick('清除选中内容的格式'))
  await sleep(400)
  ps = await paragraphs()
  const strongLeft = await page.$$eval('.ProseMirror strong', (els) => els.length)
  check('清除格式同时清掉段落属性与加粗',
    ps.slice(0, 3).every((p) => !p.align && !p.line && !p.size) && strongLeft === 0,
    `残留属性 ${ps.slice(0, 3).filter((p) => p.align || p.line || p.size).length} 段 / strong ${strongLeft}`)

  check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  check('验收流程未抛异常', false, String(e))
} finally {
  if (docId) {
    const d = await api(`/docs/${docId}`, { method: 'DELETE' })
    console.log(`临时文档已清理：${d.status}`)
  }
  await browser.close()
}

const passed = results.filter(Boolean).length
console.log(`\n通过 ${passed}/${results.length}`)
process.exit(passed === results.length ? 0 : 1)

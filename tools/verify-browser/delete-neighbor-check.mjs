/**
 * 删除文档后的落点验收：必须定位到「下一篇」，没有下一篇再回退「上一篇」。
 *
 * 用一棵临时树把三种情况都摆出来（P 下挂 A、B、C）：
 *   删 B（中间）  → 下一篇 C
 *   删 C（最后）  → 上一篇 A
 *   删 A（唯一首个子）→ 回退到父级 P
 * 再验一次「删的不是当前文档时不动当前」。
 */
import puppeteer from 'puppeteer-core'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const SECRET = process.argv[2]
if (!SECRET) {
  console.error('用法：node delete-neighbor-check.mjs <JWT_SECRET>')
  process.exit(1)
}
const KEY = crypto.createHash('sha256').update(SECRET).digest()
const TOKEN = jwt.sign(
  { sub: '5', typ: 'auth', pv: 0, uname: 'gaofeng', dn: 'gaofeng', color: '#3370ff' },
  KEY,
  { algorithm: 'HS256', expiresIn: '30m' },
)
const BASE = 'http://47.117.110.143/scofendoc/'
const API = 'http://47.117.110.143/scofendoc/api'
const SPACE = 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `   ${extra}` : ''}`)
}

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const createDoc = (title, parentId = null) =>
  call('/docs', { method: 'POST', body: JSON.stringify({ workspaceId: SPACE, parentId, title }) })
const removeDoc = (id) => call(`/docs/${id}`, { method: 'DELETE' })

const stamp = Date.now().toString().slice(-5)
const P_TITLE = `ZZ删除落点-父-${stamp}`
const titles = ['A', 'B', 'C'].map((x) => `ZZ删除落点-${x}-${stamp}`)
const D_TITLE = `ZZ删除落点-旁支-${stamp}`

let parent
const created = []
try {
  // 旁支先建：新建文档追加在同层末尾，如果它排在 P 之后，删 C 时的「下一篇」
  // 就变成旁支了，测不到「没有下一篇才回退上一篇」这条
  const aside = await createDoc(D_TITLE)
  created.push(aside)
  parent = await createDoc(P_TITLE)
  created.push(parent)
  const kids = []
  for (const t of titles) {
    const d = await createDoc(t, parent.id)
    created.push(d)
    kids.push(d)
  }
  const [A, B, C] = kids

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--no-proxy-server'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(m.text().slice(0, 200))
  })
  page.on('dialog', (d) => d.accept())

  const currentDocId = () =>
    page.evaluate(() => Number(new URLSearchParams(location.search).get('doc')) || null)

  const boot = async () => {
    await page.goto(`${BASE}?space=2`, { waitUntil: 'domcontentloaded' })
    await page.evaluate((t) => {
      localStorage.setItem('scofendoc.token', t)
      localStorage.setItem('scofendoc.user', JSON.stringify({ id: 5, username: 'gaofeng', displayName: 'gaofeng', color: '#3370ff', admin: true }))
    }, TOKEN)
    await page.goto(`${BASE}?space=2`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('.tree-row', { timeout: 30000 })
    await sleep(1200)
    // 目录是折叠树：把所有能展开的都展开，测试文档才点得到
    for (let pass = 0; pass < 6; pass++) {
      const n = await page.evaluate(() => {
        const closed = [...document.querySelectorAll('.tree-row .twist:not(.placeholder):not(.open)')]
        closed.forEach((t) => t.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        return closed.length
      })
      await sleep(350)
      if (!n) break
    }
  }

  /** 点开某一篇（按标题精确匹配树节点） */
  const openDoc = async (title) => {
    const ok = await page.evaluate((kw) => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (r) => r.querySelector('.title')?.textContent.trim() === kw,
      )
      if (!row) return false
      row.scrollIntoView({ block: 'center' })
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    }, title)
    await sleep(1600)
    return ok
  }

  /** 右键 → 删除；accept 由 page.on('dialog') 统一处理 */
  const deleteFromTree = async (title) => {
    const ok = await page.evaluate((kw) => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (r) => r.querySelector('.title')?.textContent.trim() === kw,
      )
      if (!row) return false
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 60, clientY: r.top + 12 }))
      return true
    }, title)
    if (!ok) return { clicked: false, toast: '' }
    await sleep(400)
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.ctx-menu .ctx-item.danger')
      if (!btn) return false
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })
    // 提示条只活 2.6 秒，早点读，别等它消失
    await sleep(1300)
    const toast = await page.evaluate(() => document.querySelector('.toast.notice')?.textContent?.trim() ?? '')
    await sleep(1000)
    return { clicked, toast }
  }

  await boot()

  /* 1. 删中间那篇 → 下一篇 */
  check('能打开 B', await openDoc(titles[1]), `doc=${await currentDocId()}`)
  check('当前确实是 B', (await currentDocId()) === B.id, `${await currentDocId()} vs ${B.id}`)
  const delB = await deleteFromTree(titles[1])
  check('删 B 后定位到下一篇 C', (await currentDocId()) === C.id, `当前 ${await currentDocId()}，期望 ${C.id}`)
  check('有「定位到」提示', /定位到/.test(delB.toast), delB.toast)

  /* 2. 删最后一篇 → 上一篇 */
  check('当前停在 C（删 B 后自动过来）', (await currentDocId()) === C.id)
  await deleteFromTree(titles[2])
  check('删 C 后回退到上一篇 A', (await currentDocId()) === A.id, `当前 ${await currentDocId()}，期望 ${A.id}`)

  /* 3. 删的不是当前文档 → 当前不动 */
  check('当前是 A', (await currentDocId()) === A.id)
  await deleteFromTree(D_TITLE)
  check('删旁支文档不影响当前所在 A', (await currentDocId()) === A.id, `当前 ${await currentDocId()}`)

  /* 4. 删唯一首个子 → 回退到父级 */
  await deleteFromTree(titles[0])
  check('删 A 后回退到父级 P', (await currentDocId()) === parent.id, `当前 ${await currentDocId()}，期望 ${parent.id}`)

  /* 5. 批量删除、且父子同时被选：不能「先删父、再删已被带走子的」报 404 */
  const P2_TITLE = `ZZ批量-父-${stamp}`
  const A2_TITLE = `ZZ批量-A2-${stamp}`
  const B2_TITLE = `ZZ批量-B2-${stamp}`
  const X2_TITLE = `ZZ批量-X-${stamp}`
  const Y2_TITLE = `ZZ批量-Y-${stamp}`
  const x2 = await createDoc(X2_TITLE)
  const y2 = await createDoc(Y2_TITLE)
  const p2 = await createDoc(P2_TITLE)
  const a2 = await createDoc(A2_TITLE, p2.id)
  const b2 = await createDoc(B2_TITLE, p2.id)
  created.push(x2, y2, p2, a2, b2)
  await boot()
  // 打开父文档后 Ctrl 加选它自己和其中一个子文档
  await openDoc(P2_TITLE)
  for (const t of [A2_TITLE, P2_TITLE]) {
    await page.evaluate((kw) => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (r) => r.querySelector('.title')?.textContent.trim() === kw,
      )
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    }, t)
    await sleep(400)
  }
  const picked = await page.evaluate(
    () => document.querySelector('.tree-batch-bar .batch-count')?.textContent?.trim() ?? '',
  )
  check('父子同时被勾选（2 篇）', /2/.test(picked), picked)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tree-batch-bar .batch-btn')].find((b) =>
      b.textContent.includes('删除所选'),
    )
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(2800)
  const batchErr = await page.evaluate(() => document.querySelector('.toast.error')?.textContent?.trim() ?? '')
  const afterBatch = await currentDocId()
  check('批量删父子不报「文档不存在」', batchErr === '', batchErr)
  check('批量删后定位到 Y2（P2 子树之后无文档，回退上一篇）', afterBatch === y2.id, `当前 ${afterBatch}，期望 ${y2.id}`)

  /* 6. 撤销删除 → 回到被删的那篇（删错了不用再手动找回来） */
  const Z1_TITLE = `ZZ撤销-Z1-${stamp}`
  const Z2_TITLE = `ZZ撤销-Z2-${stamp}`
  const z1 = await createDoc(Z1_TITLE)
  const z2 = await createDoc(Z2_TITLE)
  created.push(z1, z2)
  await boot()
  await openDoc(Z1_TITLE)
  await deleteFromTree(Z1_TITLE)
  check('删 Z1 后跳到下一篇 Z2', (await currentDocId()) === z2.id, `当前 ${await currentDocId()}，期望 ${z2.id}`)
  // 焦点留在正文里的话，Ctrl+Z 会被编辑器自己的撤销栈接走，先挪开
  await page.evaluate(() => {
    document.activeElement?.blur?.()
    document.body.focus?.()
  })
  await sleep(250)
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await sleep(2200)
  check('撤销删除后回到 Z1', (await currentDocId()) === z1.id, `当前 ${await currentDocId()}，期望 ${z1.id}`)

  /* 5. 提示语 */
  check('全程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '))

  await browser.close()
} catch (e) {
  check('脚本执行未抛错', false, String(e).slice(0, 300))
} finally {
  // 收尾：逐个删掉本次创建的文档（已删过的会 404，忽略即可）
  for (const d of created) {
    try {
      await removeDoc(d.id)
    } catch {}
  }
  const left = await call(`/workspaces/${SPACE}/docs`).catch(() => [])
  const leaked = left.filter((d) => d.title.startsWith('ZZ删除落点') || d.title.startsWith('ZZ批量'))
  console.log(leaked.length ? `⚠ 残留测试文档 ${leaked.length} 篇` : '临时文档已清理')
}

const passed = results.filter((r) => r.ok).length
console.log(`\n通过 ${passed}/${results.length}`)
process.exit(passed === results.length ? 0 : 1)

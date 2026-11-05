/**
 * H1 与有序 / 无序列表共存验收。
 *
 *   cd frontend && ./node_modules/.bin/vite --config vite.smoke.config.ts --port 5388 --host 127.0.0.1 --strictPort
 *   cd tools/verify-browser && node h1-list-check.mjs
 *
 * 只在本地冒烟页做内存操作，不连后端、不写线上数据。
 */
import puppeteer from 'puppeteer-core'

const URL = process.argv[2] || 'http://127.0.0.1:5388/color-tab-smoke.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '   ' + detail : ''}`)
}
const BLUE = 'rgb(51, 112, 255)'

const H1 = '<h1>一级标题</h1><p>后面的正文</p>'
const OL = '<ol><li><p>列表项一</p></li><li><p>列表项二</p></li></ol>'
const P = '<p>普通段落文字</p>'

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
await page.goto(URL, { waitUntil: 'networkidle2' })
await page.waitForFunction(() => !!window.ed, { timeout: 20000 })
await sleep(200)

const run = (html, target, command) =>
  page.evaluate(
    ({ html, target, command }) => {
      const ed = window.ed
      ed.commands.setContent(html)
      let pos = -1
      ed.state.doc.descendants((node, p) => {
        if (pos < 0 && node.isTextblock && node.textContent.includes(target)) pos = p + 1
      })
      if (pos < 0) return { error: 'target not found' }
      ed.commands.setTextSelection(pos)
      let ok = false
      try {
        ok = new Function('ed', `return (${command})(ed)`)(ed)
      } catch (e) {
        return { error: String(e) }
      }
      const h = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6')]
      return {
        ok,
        html: ed.getHTML(),
        tags: h.map((el) => el.tagName),
        nums: h.map((el) => el.getAttribute('data-number') || ''),
        kinds: h.map((el) => el.getAttribute('data-number-kind') || ''),
        ol: document.querySelectorAll('.ProseMirror ol').length,
        ul: document.querySelectorAll('.ProseMirror ul').length,
        li: document.querySelectorAll('.ProseMirror li').length,
        inList: h.filter((el) => el.closest('li')).length,
        markerColor: (() => {
          const li = document.querySelector('.ProseMirror li')
          return li ? getComputedStyle(li, '::marker').color : ''
        })(),
        prefixColor: (() => {
          const el = document.querySelector('.ProseMirror [data-number]')
          return el ? getComputedStyle(el, '::before').color : ''
        })(),
        nestedMargin: (() => {
          const el = document.querySelector('.ProseMirror li > h1')
          return el ? parseFloat(getComputedStyle(el).marginTop) : null
        })(),
        topMargin: (() => {
          const el = document.querySelector('.ProseMirror > h1')
          return el ? parseFloat(getComputedStyle(el).marginTop) : null
        })(),
      }
    },
    { html, target, command },
  )

/* 1) H1 上点有序 / 无序列表：标题不再被降级 */
const a = await run(H1, '一级标题', 'ed => ed.chain().focus().toggleOrderedList().run()')
check('H1 + 有序列表 → ol > li > h1（不降级成 p）', a.ok && a.tags[0] === 'H1' && a.inList === 1 && a.ol === 1, `${a.html} | inList=${a.inList}`)
check('有序列表 marker 是品牌蓝', a.markerColor === BLUE, a.markerColor)

const b = await run(H1, '一级标题', 'ed => ed.chain().focus().toggleBulletList().run()')
check('H1 + 无序列表 → ul > li > h1', b.ok && b.tags[0] === 'H1' && b.inList === 1 && b.ul === 1, b.html)
check('无序列表 marker 也是品牌蓝', b.markerColor === BLUE, b.markerColor)
check('列表内 H1 的 margin 收敛（不与 marker 撑开）', b.nestedMargin !== null && b.nestedMargin < 12, String(b.nestedMargin))

/* 2) 列表项里设 H1：保留在列表内 */
const c = await run(OL, '列表项一', 'ed => ed.chain().focus().toggleHeading({level:1}).run()')
check('列表项 → H1 仍留在 ol 里（不再被拆出去）', c.ok && c.tags[0] === 'H1' && c.inList === 1 && c.li === 2, c.html)

const d = await run(OL, '列表项一', "ed => ed.chain().focus().toggleHeadingNumber(true,'ordered').run()")
check('列表项 → 有序标题：就地变 H1 且保留列表', d.ok && d.tags[0] === 'H1' && d.inList === 1 && d.li === 2, d.html)
check('列表内标题不再重复显示第二套编号', !d.nums.some((n) => n), JSON.stringify(d.nums))

const e = await run(OL, '列表项一', "ed => ed.chain().focus().toggleHeadingNumber(true,'unordered').run()")
check('列表项 → 无序标题：列表类型同步切成 ul', e.ok && e.ul === 1 && e.ol === 0 && e.tags[0] === 'H1' && e.inList === 1, e.html)

/* 3) 独立标题加前缀：H1 级别不再被改成 H2 */
const f = await run(P, '普通段落文字', "ed => ed.chain().focus().toggleHeadingNumber(true,'ordered').run()")
check('普通段落 → 有序标题得到 H1（不再强制 H2）', f.ok && f.tags[0] === 'H1' && f.nums[0] === '1.', JSON.stringify({ tags: f.tags, nums: f.nums }))
check('独立标题前缀仍是品牌蓝', f.prefixColor === BLUE, f.prefixColor)

const g = await run(H1, '一级标题', "ed => ed.chain().focus().toggleHeadingNumber(true,'unordered').run()")
check('H1 + 无序标题：H1 保留且显示 ●', g.ok && g.tags[0] === 'H1' && g.nums[0] === '●' && g.kinds[0] === 'unordered', JSON.stringify({ tags: g.tags, nums: g.nums }))

const h = await run(H1, '一级标题', "ed => ed.chain().focus().toggleHeadingNumber(true,'ordered').toggleHeadingNumber(true,'unordered').run()")
check('H1 上切换有序→无序仍是 H1', h.ok && h.tags[0] === 'H1' && h.nums[0] === '●', h.html)

/* 4) 旧文档与后续编辑动作不回归 */
const i = await run('<ol><li><p>旧列表</p></li><li><p>第二项</p></li></ol>', '旧列表', 'ed => true')
check('旧文档 ol > li > p 仍可正常解析', i.ok && i.li === 2 && i.tags.length === 0, i.html)

const j = await run('<ol><li><h1>标题项</h1></li><li><p>第二项</p></li></ol>', '标题项', "ed => ed.chain().focus().splitListItem('listItem').run()")
check('列表内 H1 回车换行不报错、结构合法', !j.error && j.ok !== false && j.li >= 2 && j.html.includes('<ol'), JSON.stringify({ ok: j.ok, error: j.error, li: j.li, html: j.html.slice(0, 160) }))

const k = await run('<ol><li><h1>标题项</h1></li><li><p>第二项</p></li></ol>', '标题项', "ed => ed.chain().focus().sinkListItem('listItem').run()")
check('列表内 H1 的 Tab 缩进不报错', !k.error && k.html.includes('<ol'), JSON.stringify({ ok: k.ok, error: k.error, html: k.html.slice(0, 160) }))

const l = await run('<ol><li><h1 data-numbered="1">标题项</h1></li></ol>', '标题项', "ed => ed.chain().focus().toggleHeadingNumber(false).run()")
check('列表内标题可关闭编号前缀', l.ok && l.tags[0] === 'H1' && l.inList === 1, l.html)

/* 5) 六级标题都能进列表 */
const levels = await page.evaluate(() => {
  const ed = window.ed
  const out = []
  for (let lv = 1; lv <= 6; lv++) {
    ed.commands.setContent(`<ol><li><p>第${lv}级</p></li></ol>`)
    let pos = -1
    ed.state.doc.descendants((n, p) => { if (pos < 0 && n.isTextblock) pos = p + 1 })
    ed.commands.setTextSelection(pos)
    ed.chain().focus().toggleHeading({ level: lv }).run()
    out.push({ lv, tag: document.querySelector(`.ProseMirror li > h${lv}`)?.tagName || '', inList: !!document.querySelector('.ProseMirror li > h' + lv) })
  }
  return out
})
check('H1–H6 六级都能作为列表项标题', levels.every((x) => x.tag === `H${x.lv}` && x.inList), JSON.stringify(levels))

check('全程无 JS 报错', errors.length === 0, errors.join(' | '))

console.log(`\n结果：${results.filter(Boolean).length}/${results.length} 通过`)
await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)

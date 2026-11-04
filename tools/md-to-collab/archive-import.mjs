#!/usr/bin/env node
/**
 * 批量导入「技术栈 / CSDN存档 / 语雀存档」到 scofenDoc
 * ---------------------------------------------------------------------------
 * 数据源：/Users/gaoying/Desktop/study/人生/职业规划/技术栈
 *   ・CSDN存档/CSDN存档索引.html   按「技术栈哪一篇引用了它」分组，给出每篇标题
 *   ・语雀/语雀全库索引.html       按「技术栈归属」列分组，给出每篇标题（第一列目录名）
 *
 * 产出的文档树（space=2，挂在 技术栈(17) 下）：
 *   技术栈
 *   ├─ CSDN 存档 (索引正文)         → 分组节点 × N → 文章 doc × 263
 *   └─ 语雀存档 (索引正文)           → 分组节点 × N → 文章 doc × 159
 *
 * 分四个阶段，必须按顺序跑：
 *   node archive-import.mjs plan      # 解析两个索引，生成 archive-plan.json
 *   node archive-import.mjs insert    # 建 doc 记录（SQL 一次性灌），回读 id → archive-manifest.json
 *   node archive-import.mjs convert   # HTML → .bin，输出到 out/
 *   node archive-import.mjs upload    # 上传 .bin + 图片，重启协同服务
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import * as cheerio from 'cheerio'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from 'y-prosemirror'
import { convertHtml, schema } from './html-to-ydoc-core.mjs'

const SRC = '/Users/gaoying/Desktop/study/人生/职业规划/技术栈'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLAN = path.join(HERE, 'archive-plan.json')
const MANIFEST = path.join(HERE, 'archive-manifest.json')
const MD_MANIFEST = path.join(HERE, 'link-manifest.json')
const OUT = path.join(HERE, 'archive-out')

const HOST = 'root@47.117.110.143'
const DB = 'scofen_doc'
const DB_USER = 'scofendoc'
const DB_PASS = 'ScofenDoc@2026'
const DATA_DIR = '/opt/scofendoc/collab/data'
const SPACE_ID = 2
const PARENT_ID = 17 // 技术栈

const IMG_BASE_CSDN = '/scofendoc/files/archive/csdn/'
const IMG_BASE_YUQUE = '/scofendoc/files/archive/yuque/'

const stage = process.argv[2] || 'plan'

const sql = (q) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, `mysql -u${DB_USER} -p'${DB_PASS}' ${DB} -N -B -e "${q}"`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/* ============================ plan ============================ */

function parseCsdnIndex() {
  const file = path.join(SRC, 'CSDN存档/CSDN存档索引.html')
  const $ = cheerio.load(fs.readFileSync(file, 'utf8'))
  const groups = []
  // 每个分组是 <h2>标题 <span>N 篇</span></h2> 紧跟一个 <ul>
  $('h2').each((_, h) => {
    const title = $(h).text().replace(/（?\d+\s*篇）?/g, '').replace(/\s+/g, ' ').trim()
    const ul = $(h).nextAll('ul').first()
    if (!ul.length) return
    const items = []
    ul.find('li > a').each((__, a) => {
      const href = $(a).attr('href') || ''
      if (!href.endsWith('.html')) return
      items.push({ file: `CSDN存档/${href}`, title: $(a).text().trim() })
    })
    if (items.length) groups.push({ title, items })
  })
  return { key: 'csdn', title: 'CSDN 存档', indexFile: 'CSDN存档/CSDN存档索引.html', imgBase: IMG_BASE_CSDN, groups }
}

function parseYuqueIndex() {
  const file = path.join(SRC, '语雀/语雀全库索引.html')
  const $ = cheerio.load(fs.readFileSync(file, 'utf8'))
  const groups = []
  // 每个分组是 <h2>语雀目录 <span>（节点 N，本地页 M）</span></h2> 紧跟一个 <table>
  $('h2').each((_, h) => {
    const title = $(h).text().replace(/（[^）]*）/g, '').replace(/\s+/g, ' ').trim()
    const table = $(h).nextAll('table').first()
    if (!table.length) return
    const items = []
    table.find('tr').each((__, tr) => {
      const cells = $(tr).find('td')
      if (cells.length < 3) return
      const a = $(cells).find('a[href$=".html"]').first()
      if (!a.length) return // 空节头 / 未本地化
      const href = a.attr('href') || ''
      const name = $(cells[0]).text().replace(/\s+/g, ' ').trim()
      if (!name || href.includes('语雀全库索引')) return
      items.push({ file: `语雀/${href}`, title: name })
    })
    if (items.length) groups.push({ title, items })
  })
  return { key: 'yuque', title: '语雀存档', indexFile: '语雀/语雀全库索引.html', imgBase: IMG_BASE_YUQUE, groups }
}

if (stage === 'plan') {
  const roots = [parseCsdnIndex(), parseYuqueIndex()]
  // 去重（同一篇可能被同一分组重复列出）
  for (const root of roots) {
    for (const g of root.groups) {
      const seen = new Set()
      g.items = g.items.filter((it) => (seen.has(it.file) ? false : (seen.add(it.file), true)))
    }
    root.groups = root.groups.filter((g) => g.items.length > 0)
    const total = root.groups.reduce((n, g) => n + g.items.length, 0)
    console.log(`${root.title}: ${root.groups.length} 组 / ${total} 篇`)
  }
  // 同一篇出现在多个分组时，只挂在第一组（避免重复文档）
  const owner = new Map()
  for (const root of roots) {
    for (const g of root.groups) {
      for (const it of g.items) if (!owner.has(it.file)) owner.set(it.file, g.title)
    }
  }
  const plan = {
    spaceId: SPACE_ID,
    parentId: PARENT_ID,
    roots: roots.map((r) => ({
      ...r,
      groups: r.groups.map((g) => ({
        ...g,
        items: g.items.filter((it) => owner.get(it.file) === g.title),
      })).filter((g) => g.items.length > 0),
    })),
  }
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 1))
  const n = plan.roots.reduce((s, r) => s + r.groups.reduce((a, g) => a + g.items.length, 0), 0)
  console.log(`plan 已写入 ${PLAN}：${plan.roots.length} 个根节点 / ${n} 篇文章`)
}

/* ============================ insert ============================ */

if (stage === 'insert') {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'))
  const rows = []
  const uuid = () => crypto.randomUUID()

  const nextSort = Number(sql(`select coalesce(max(sort_order),0)+1 from doc where workspace_id=${SPACE_ID} and parent_id=${PARENT_ID} and deleted=0`))

  plan.roots.forEach((root, ri) => {
    root.collabKey = uuid()
    root.sortOrder = nextSort + ri
    rows.push({
      key: root.collabKey,
      title: root.title,
      parent: PARENT_ID,
      sort: root.sortOrder,
      file: root.indexFile,
    })
    root.groups.forEach((g, gi) => {
      g.collabKey = uuid()
      g.sortOrder = gi + 1
      rows.push({ key: g.collabKey, title: g.title, parent: `{{${root.collabKey}}}`, sort: g.sortOrder })
      g.items.forEach((it, ii) => {
        it.collabKey = uuid()
        it.sortOrder = ii + 1
        rows.push({ key: it.collabKey, title: it.title, parent: `{{${g.collabKey}}}`, sort: it.sortOrder })
      })
    })
  })

  // 父子 id 靠 collab_key 回填：先全部插成 0，再两条 UPDATE 按 key 关联
  const values = rows
    .map((r) => `(${SPACE_ID},0,'${esc(r.title)}','${r.key}',${r.sort},0,now(),now())`)
    .join(',\n')
  const sqlText = [
    'START TRANSACTION;',
    `insert into doc (workspace_id,parent_id,title,collab_key,sort_order,deleted,created_at,updated_at) values\n${values};`,
    'COMMIT;',
  ].join('\n')

  const tmp = '/tmp/archive-insert.sql'
  fs.writeFileSync(tmp, sqlText)
  execFileSync('scp', ['-q', tmp, `${HOST}:/tmp/archive-insert.sql`])
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, `mysql -u${DB_USER} -p'${DB_PASS}' ${DB} < /tmp/archive-insert.sql`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`已插入 ${rows.length} 条 doc 记录，回填父子关系…`)

  // 回读 id，建立 key → id
  const dump = sql(`select id, collab_key from doc where workspace_id=${SPACE_ID} and deleted=0`)
  const idByKey = new Map()
  for (const line of dump.split('\n')) {
    const [id, key] = line.split('\t')
    if (id && key) idByKey.set(key.trim(), Number(id))
  }

  // 两轮 UPDATE：先组，再文章（组的 parent 是根，文章的 parent 是组）
  const setParent = (r, parentId) => `update doc set parent_id=${parentId} where id=${idByKey.get(r.key)};`
  const updates = []
  plan.roots.forEach((root) => {
    root.docId = idByKey.get(root.collabKey)
    // 根节点挂到「技术栈」下面（插入时统一先写 parent=0，这里回填）
    updates.push(`update doc set parent_id=${PARENT_ID} where id=${root.docId};`)
    root.groups.forEach((g) => {
      g.docId = idByKey.get(g.collabKey)
      updates.push(`update doc set parent_id=${root.docId} where id=${g.docId};`)
      g.items.forEach((it) => {
        it.docId = idByKey.get(it.collabKey)
        updates.push(`update doc set parent_id=${g.docId} where id=${it.docId};`)
      })
    })
  })
  const fixFile = '/tmp/archive-parent.sql'
  fs.writeFileSync(fixFile, updates.join('\n'))
  execFileSync('scp', ['-q', fixFile, `${HOST}:/tmp/archive-parent.sql`])
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, `mysql -u${DB_USER} -p'${DB_PASS}' ${DB} < /tmp/archive-parent.sql`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`父子关系已回填（${updates.length} 条）`)

  // 生成链接表：相对路径 → {docId, spaceId}
  const manifest = {}
  for (const root of plan.roots) {
    manifest[root.indexFile] = { docId: root.docId, spaceId: SPACE_ID }
    for (const g of root.groups) {
      for (const it of g.items) manifest[it.file] = { docId: it.docId, spaceId: SPACE_ID }
    }
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1))
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 1))
  console.log(`链接表已写入 ${MANIFEST}（${Object.keys(manifest).length} 条）`)
}

/* ============================ convert ============================ */

if (stage === 'convert') {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'))
  const archiveMap = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const mdMap = JSON.parse(fs.readFileSync(MD_MANIFEST, 'utf8'))
  const mdByName = {}
  for (const [abs, hit] of Object.entries(mdMap)) mdByName[path.basename(abs).replace(/\.md$/i, '')] = hit

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const failures = []
  let done = 0
  let bytes = 0
  const totals = { links: 0, internal: 0, external: 0, dropped: 0, imgs: 0, remoteImgs: 0 }

  for (const root of plan.roots) {
    for (const g of root.groups) {
      for (const it of g.items) {
        const abs = path.join(SRC, it.file)
        try {
          if (!fs.existsSync(abs)) throw new Error('源文件不存在')
          const { json, stats } = convertHtml(abs, {
            selfDocId: it.docId,
            spaceId: SPACE_ID,
            archiveMap,
            mdByName,
            imgBase: root.imgBase,
            title: it.title,
            dirPrefix: `${root.key === 'csdn' ? 'CSDN存档' : '语雀'}/`,
          })
          const ydoc = prosemirrorJSONToYDoc(schema, json, 'default')
          const buf = Buffer.from(Y.encodeStateAsUpdate(ydoc))
          fs.writeFileSync(path.join(OUT, `${it.collabKey}.bin`), buf)
          bytes += buf.length
          done += 1
          totals.links += stats.links
          totals.internal += stats.internal
          totals.external += stats.external
          totals.dropped += stats.dropped
          totals.imgs += stats.imgs
          totals.remoteImgs += stats.remoteImgs
        } catch (err) {
          failures.push({ file: it.file, err: String(err?.message || err) })
        }
      }
    }
  }

  // 索引页本身也导入，作为两个根节点的正文
  for (const root of plan.roots) {
    const abs = path.join(SRC, root.indexFile)
    try {
      const { json, stats } = convertHtml(abs, {
        selfDocId: root.docId,
        spaceId: SPACE_ID,
        archiveMap,
        mdByName,
        imgBase: root.imgBase,
        title: '',
        dirPrefix: `${root.key === 'csdn' ? 'CSDN存档' : '语雀'}/`,
        stripMeta: true,
      })
      const ydoc = prosemirrorJSONToYDoc(schema, json, 'default')
      const buf = Buffer.from(Y.encodeStateAsUpdate(ydoc))
      fs.writeFileSync(path.join(OUT, `${root.collabKey}.bin`), buf)
      bytes += buf.length
      done += 1
      totals.links += stats.links
      totals.internal += stats.internal
      totals.external += stats.external
      totals.dropped += stats.dropped
      console.log(`${root.title} 索引页：链接 ${stats.links}(内 ${stats.internal}/外 ${stats.external}/降级 ${stats.dropped})`)
    } catch (err) {
      failures.push({ file: root.indexFile, err: String(err?.message || err) })
    }
  }

  console.log(`\n转换完成 ${done} 篇，共 ${(bytes / 1024 / 1024).toFixed(1)}MB`)
  console.log(`合计 链接 ${totals.links}（站内 ${totals.internal} / 外链 ${totals.external} / 降级 ${totals.dropped}）  图 ${totals.imgs} 本地 + ${totals.remoteImgs} 远程`)
  if (failures.length) {
    console.log(`\n失败 ${failures.length} 篇：`)
    for (const f of failures.slice(0, 20)) console.log(`  ${f.file} :: ${f.err}`)
    fs.writeFileSync(path.join(HERE, 'archive-failures.json'), JSON.stringify(failures, null, 1))
  } else {
    console.log('无失败')
  }
}

/* ============================ upload ============================ */

if (stage === 'upload') {
  const bins = fs.readdirSync(OUT).filter((f) => f.endsWith('.bin'))
  if (!bins.length) {
    console.error('out/ 里没有 .bin，先跑 convert')
    process.exit(1)
  }
  // 房间从没被加载过，直接写文件是安全的；写完重启一次，确保内存里没有旧状态
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, 'systemctl stop scofendoc-collab || true'], { stdio: 'inherit' })
  execFileSync('rsync', ['-az', `${OUT}/`, `${HOST}:${DATA_DIR}/`], { stdio: 'inherit' })
  // 图片：CSDN 与 语雀的 img 目录同名不同内容，分开放
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, 'mkdir -p /var/www/scofendoc-files/archive/csdn /var/www/scofendoc-files/archive/yuque'], { stdio: 'inherit' })
  execFileSync('rsync', ['-az', path.join(SRC, 'CSDN存档/img/'), `${HOST}:/var/www/scofendoc-files/archive/csdn/`], { stdio: 'inherit' })
  execFileSync('rsync', ['-az', path.join(SRC, '语雀/img/'), `${HOST}:/var/www/scofendoc-files/archive/yuque/`], { stdio: 'inherit' })
  execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, 'systemctl start scofendoc-collab && sleep 2 && systemctl is-active scofendoc-collab'], { stdio: 'inherit' })
  console.log(`已上传 ${bins.length} 个 .bin 与图片目录`)
}

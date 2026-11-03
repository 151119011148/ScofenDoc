// 协同链路验证脚本：两个客户端经同一入口连接，验证实时同步是否真的通
//
// 现在协同服务要求 JWT 鉴权，脚本必须带一个「后端为本篇文档签发的」协同 token：
//
//   本地/生产通用（先向接口申请 token，再验证）：
//     TOKEN=$(curl -s -X GET "$API/docs/$DOC_ID/collab-token" -H "Authorization: Bearer $JWT" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
//     COLLAB_URL=ws://47.117.110.143/lightdoc/collab \
//     COLLAB_TOKEN=$TOKEN DOC_NAME=<该文档的 collabKey> node scripts/verify-collab.mjs
//
// 退出码 0 表示同步成功，可用于发布后的自动化校验。
import WS from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

globalThis.WebSocket = WS

const URL = process.env.COLLAB_URL || 'ws://localhost:1234'
const TOKEN = process.env.COLLAB_TOKEN
const DOC = process.env.DOC_NAME

if (!TOKEN || !DOC) {
  console.error('缺少 COLLAB_TOKEN / DOC_NAME：协同服务已开启 JWT 鉴权，token 必须由后端为指定文档签发')
  process.exit(2)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function makeClient(label) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: URL, name: DOC, document: doc, token: TOKEN })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 连接超时：${URL}`)), 12000)
    provider.on('status', ({ status }) => {
      if (status === 'connected') {
        clearTimeout(t)
        resolve()
      }
    })
    // 鉴权失败要立刻报错，否则只能干等到超时，看不出是权限问题
    provider.on('authenticationFailed', () => {
      clearTimeout(t)
      reject(new Error(`${label} 协同鉴权失败：token 无效、已过期，或与文档 ${DOC} 不匹配`))
    })
  })
  return { doc, provider }
}

let a
let b
try {
  a = await makeClient('A')
  console.log('A 已连接：', URL, '| 文档：', DOC)
  b = await makeClient('B')
  console.log('B 已连接')
} catch (e) {
  console.error('❌', e.message)
  process.exit(1)
}

await wait(600)
const content = '协同验证 OK'
a.doc.getText('content').insert(0, content)
await wait(1200)

const received = b.doc.getText('content').toString()
console.log('B 端收到：', JSON.stringify(received))

await wait(1000)
a.provider.destroy()
b.provider.destroy()
console.log(received === content ? '✅ 实时同步通过' : '❌ 同步失败')
process.exit(received === content ? 0 : 1)

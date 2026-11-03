/**
 * 生产/开发环境地址解析。
 *
 * 开发：直连本地协同服务 ws://localhost:1234
 * 生产：走同源反向代理（Nginx 将 /scofendoc/collab/ 转发到 127.0.0.1:1234），
 *       因此前端不写死 IP，也不依赖端口是否对外开放——换域名/换机器都不用改代码。
 */
const base = import.meta.env.BASE_URL || '/'

/** 协同服务 WebSocket 地址（不含文档名，文档名由 provider 追加） */
export const COLLAB_URL =
  import.meta.env.VITE_COLLAB_URL ||
  (import.meta.env.DEV
    ? 'ws://localhost:1234'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base.replace(/\/$/, '')}/collab`)

/** Java 后端 API 前缀 */
export const API_BASE = import.meta.env.VITE_API_BASE || `${base.replace(/\/$/, '')}/api`

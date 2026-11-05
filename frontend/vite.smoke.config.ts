import { defineConfig } from 'vite'
import base from './vite.config'

// 本地冒烟专用：独立缓存目录，避免新增依赖触发的 deps 重优化删除临时缓存
// （WorkBuddy 的 safe-delete 守卫会拦下批量 rm，导致 dev 服务崩溃）。
export default defineConfig({
  ...base,
  cacheDir: 'node_modules/.vite-smoke-h1',
  optimizeDeps: {
    include: [
      '@tiptap/extension-list-item',
      '@tiptap/starter-kit',
      '@tiptap/vue-3',
      '@tiptap/core',
      'yjs',
    ],
  },
  server: {
    port: 5388,
    host: '127.0.0.1',
    strictPort: true,
  },
})

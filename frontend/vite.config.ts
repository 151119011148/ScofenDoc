import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 由环境变量控制：
//   本地开发/预览：不设置 → '/'
//   生产部署（挂在 /lightdoc/ 前缀下）：VITE_BASE=/lightdoc/ npm run build
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [vue()],
  server: {
    port: 5173,
    host: true, // 允许同网段/服务器访问
    proxy: {
      // 本地开发时把 /api 转到 Java 后端，避免跨域；生产由 Nginx 反代，不走这里
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})

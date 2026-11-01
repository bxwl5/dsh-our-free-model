import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/vite'
import { standaloneSharedUi } from '../../scripts/lib/standalone-shared-ui.mjs'

const root = fileURLToPath(new URL('./frontend', import.meta.url))
export default {
  root, base: '/assets/',
  plugins: [tailwind(), standaloneSharedUi()],
  build: {
    outDir: fileURLToPath(new URL('./web', import.meta.url)),
    emptyOutDir: false, write: false, assetsDir: '', target: 'es2022',
    // ⚠️ CSS 按 chunk 拆分（2026-11-01 复审）：false 会把 models/settings/usage
    // 三个懒页的样式（~198KB）全并进首屏 app.css，而首屏 overview 用不到它们。
    // 拆开后 vite 运行时 helper 会在对应懒 chunk 首次 import() 时注入 <link>；
    // entry 的 CSS 仍固定命名 app.css，懒页 CSS 用 [name]-[hash].css 区分
    //（此前固定 app.css 正是因为不拆分时所有 CSS 同名会互相覆盖）。
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name]-[hash].js',
        // entry 的 CSS 原名 index.css（跟随 index.html 引用），固定改回 app.css
        //（scripts/standalone-frontend-test.mjs 与运行时清单都按 app.css 契约），
        // 懒页 CSS 用 [name]-[hash].css 区分。
        assetFileNames: asset => asset.names?.includes('index.css') ? 'app.css'
          : asset.names?.some(name => path.extname(name) === '.css') ? '[name]-[hash].css'
          : '[name]-[hash][extname]',
      },
    },
  },
}

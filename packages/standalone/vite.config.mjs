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
    /**
     * CSS 全部并进 app.css（2026-11-16 修正，止血）。
     *
     * 此前是 `cssCodeSplit: true`，原意是「懒页样式不进首屏」。但实测（Chrome
     * CDP 抓 `document.styleSheets`）发现问题：拆分后 Vite 虽然产出了
     * `models-*.css` / `settings-*.css` / `usage-*.css`，**却没有把注入 `<link>`
     * 的运行时 helper 打进懒 chunk** —— 三个懒 chunk 里 `createElement` 出现
     * 0 次。结果：
     *
     * - 模型清单页：`.model-table-row` 的 `display:grid` / `position:absolute`
     *   全部失效 → computed style 是 `block`/`static`、`gridTemplateColumns:none`
     *   → 表格塌成一柱文字、卡片消失（用户：「连卡片都不见了」）
     * - 服务设置页：grid 布局失效 → 右侧栏撑满（用户：「右边太宽」）
     * - 只有 settings-*.css 侥幸被加载，models/usage 的 CSS 从未生效
     *
     * 代价：首屏多载 ~198KB CSS。对本地/局域网面板可接受，布局正确优先于这点体积。
     * 若要恢复拆分，前提是先确认 vite 版本把 CSS 注入 helper 正确合入懒 chunk。
     */
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name]-[hash].js',
        // entry 的 CSS 原名 index.css（跟随 index.html 引用），固定改回 app.css
        //（scripts/standalone-frontend-test.mjs 与运行时清单都按 app.css 契约），
        // 懒页 CSS 用 [name]-[hash].css 区分。
        /**
         * CSS 一律固定命名 `app.css`（2026-11-16）。
         *
         * `cssCodeSplit: false` 之后所有样式并成**一个** CSS 资源，但它的
         * `asset.names` 变成 `style.css`（不再是 entry 的 `index.css`），
         * 于是旧规则把它命名为 `style-<hash>.css` —— 而 management.mjs 与
         * 前端 HTML 都按 `app.css` 这个契约取资源，取不到就是整站无样式。
         * 这里让所有 CSS 都落到 `app.css`（只有一个 CSS 资源，不存在覆盖）。
         */
        assetFileNames: asset => asset.names?.some(name => path.extname(name) === '.css') ? 'app.css'
          : '[name]-[hash][extname]',
      },
    },
  },
}

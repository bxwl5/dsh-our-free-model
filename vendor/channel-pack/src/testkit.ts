/**
 * 测试专用导出面（**不随插件发布**）。
 *
 * ## 为什么需要它
 * 有些回归用例要直接调内部函数（`classifyTraeError` 的码值分类、
 * `fetchTokenRates` 的重试次数），而这些函数在 `pack.js` 里被 `__export`
 * 到内层命名空间，顶层拿不到。
 *
 * ## 为什么不用「测试自己临时打包」
 * 第一版让 `scripts/upstream-parity-test.mjs` 在运行时调 esbuild 打包源码，
 * 本机（Node 24 能直接吃 `.ts`）通过，但 CI 的 `offline` job 只跑
 * `npm install --ignore-scripts` —— esbuild 的二进制没装，用例直接
 * `ERR_MODULE_NOT_FOUND` 挂掉。构建期产出一个小文件即可，运行期零依赖。
 *
 * ## 为什么不会被发布
 * `package.json` 的 `files` 只列了 `vendor/channel-pack/pack.js`（不是整个目录），
 * 所以本文件是**仓库内测试资产**，不进发布清单。改这里的导出不影响插件体积。
 *
 * ⚠️ 新增导出时同步 `scripts/build-channel-pack.mjs` 的 testkit 构建段 ——
 * 那个脚本会做 `--check` 新鲜度比对，忘了重建会让 CI 报「testkit 与 src 不一致」。
 */

export {
  classifyTraeError,
  classifyTraeStreamCode,
  recordsTraeRateLimit,
  shouldRotateTraeAccount,
} from './trae-errors.js'
export { fetchTokenRates, resetOfficeAceTokenRatesCache } from './officeace.js'

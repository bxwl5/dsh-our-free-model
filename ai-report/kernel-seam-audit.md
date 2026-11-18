# 任务 1：内核接缝边界审计报告

日期：2026-11-19
验收命令：`grep -rE "(require|import).*['\"]dsh" src/ index.js` → **无结果 ✓**

## 结论：接缝边界完整，无需修改

### 1. 静态 import 扫描

| 范围 | `dsh` 内核 import | `@deepseek-ai/*` import |
|---|---|---|
| `src/**`（含 src/core、src/route、src/token-saver） | 0 | **0** |
| `index.js` | 0 | **0** |
| `client.js`（浏览器端） | 0 | 0 |
| `adapter/kernel.js`（唯一接缝） | 0 | 1（设计如此） |

### 2. 动态 import 扫描

`import('@deepseek-ai/...')` / `import('dsh...')` 在 `src/`、`index.js`、`client.js` 中零出现。
唯一的动态内核 import 位于 `adapter/kernel.js:39`（`await import('@deepseek-ai/dsh-llm')`），
且带完整降级路径：模块缺失或形状不符时回落到字面量 UA，符合接缝注释的契约。

### 3. 唯一接缝的内容核对

`adapter/kernel.js`（51 行）只导出一个函数：

- `resolveAttributionUserAgent(logger)` —— 惰性 import 内核 attribution 头，
  失败回落 `'deepseek-harness/0.1.7 (...)'` 字面量。
- 旁边有 `dsh-llm.d.ts` 手写窄类型（比内核真实 surface 窄），注释说明这是有意的。

`index.js:31` 通过 `import { resolveAttributionUserAgent } from './adapter/kernel.js'`
消费，是接缝的唯一入口，符合「adapter/ 之外不得触碰内核」。

### 4. vendor 豁免确认

`vendor/channel-pack/src/*.ts` 中存在 `@deepseek-ai` import（account-pool、
account-probe、antigravity-adapter 等）。这是**按字节携带的第三方插件**
（见 vendor/channel-pack/NOTICE.md），catalog-test.mjs 的隔离规则明确豁免
vendor/ 前缀：

    check('only adapter/ and the vendored pack may name an @deepseek-ai module',
      own.filter(f => !f.startsWith('vendor/')), [])

不属于违规。

### 5. instanceof 内核类检查（约束 2）

全 `src/` + `index.js` 的 instanceof 扫描只发现三类：

- `instanceof UpstreamError`（src/http.js:52 自有类，`export class UpstreamError extends Error`）—— 非内核类 ✓
- `url instanceof Request`（src/egress.js:109）—— Web 标准 API，跨内核稳定 ✓
- 标准错误类型（Error/TypeError/…）—— 通用 ✓

**没有对内核提供类的 instanceof 检查**，鸭子类型契约未被破坏。

### 6. 验收标准复核

```
$ grep -rE "(require|import).*['\"]dsh" src/ index.js
（无输出）
```

验收标准满足。任务 1 状态：**通过，零修改**。

# 任务 3 成功报告：探测与路由性能优化

状态：✅ 成功（1e8b659，后续 integrity 刷新 24adb92）

## 改动
- `src/probe.js`：`PROBE_TIMEOUT_MS = 5000`（原 45s）、`PROBE_CONCURRENCY = 5`（原 2），原生常量导出
- `src/core/runtime.js`：`PROBE_CACHE_TTL_MS = 10 * 60_000`；`refreshAvailability` 非 force 路径加 TTL 门（以持久化 `availability.at` 为缓存时间戳，重启后仍有效）；`/reprobe`（force=true）绕过 TTL 并在轮末刷新 `at`

## 验证
- 静态断言：三常量值、TTL 门只在 `!force` 分支、每轮结束写 `at`
- 86→87 套件全绿（当时口径）；typecheck 0 错误
- 无新增第三方依赖（git diff 确认 0 个新增 require/import）

## 风险点（需人工观察）
- 冷启动首 delta 超过 5s 的渠道会被判 unknown（不摘出选择器，但计数会上升）
- 重启后 10 分钟内不自动重探（启动路径走 force 不受影响）

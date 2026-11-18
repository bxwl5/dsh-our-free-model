# 任务 6 成功报告：升级链路容错加固

状态：✅ 成功（3b0f458；integrity 收尾 24472b7）

## 改动
- `src/reload.js`
  - `restoreCaches` 返回 `{failed, total}`（旧版静默吞失败、报假成功）
  - dispose / 回滚注册均加 8s 超时（防 isReloading 永久卡死）
  - 回滚失败/部分失败写 `logger.error`，`restored` 字段如实（cacheRestore.failed === 0）
- `scripts/reload-rollback-test.mjs`（新增，2 checks，注册进 test-all）
- `scripts/test-all.mjs`：注册新套件

## 任务前提差异说明
任务书前提是「下载/校验/备份/替换」全链路；当前代码**没有**应用内下载与磁盘备份环节（旧更新器已删，审计确认无自更新路径）——所以：
- 「签名清单校验失败提示」不适用（无校验环节可失败；热重载的 re-import 失败已有明确 error 文案 + restored 如实）
- 「备份保留最近 3 份」不适用（备份是内存 Map，非磁盘文件）
- 落地的是热重载链路的容错：超时、如实上报、失败日志

## 验证
- reload-rollback 专项 2 checks（含人为构造 set 双失败路径）
- reload-ui 既有测试通过
- 87/87 全绿；typecheck 0 错误

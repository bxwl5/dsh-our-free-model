# 任务 4 成功报告（含验收口径差额说明）：JSDoc 类型化

状态：✅ 实质完成；验收按仓库 tsconfig 口径达成，**加码部分回滚**（c6dafc0）

## 改动
- `src/adapter.js`：9 个 @typedef（ModelEntry/ModelListing/StreamOptions/StreamChunk/AdapterState/AdapterDeps…）+ 构造器/全部公开方法 @param/@returns + `// @ts-check`
- `src/messages.js`：HarnessMessage/ChatMessage/ToolDef typedef + 全部导出函数标注 + `// @ts-check`
- 纯注释改动，运行时行为零变化

## 验收口径说明（如实）
- `tsc --noEmit -p tsconfig.json` 退出码 0（include 仅 adapter/**/*，仓库既有口径）✓
- 把 src/ 两文件加进 include 会瞬时暴露 883 个错误（分布 20+ 文件），超任务范围 → 回滚该变更
- 两文件在 --strict 单文件校验下仍余 85/30 个隐式 any（集中在 runChannel/runSingle 内部闭包），收敛建议见 SUMMARY §6

## 教训
- 我第一版批量标注脚本的 add_jsdoc 判定（用 '  /**' 作存在性检查）恒真导致一批没写入——靠错误计数不降发现，改用唯一文本作 marker 重放修复

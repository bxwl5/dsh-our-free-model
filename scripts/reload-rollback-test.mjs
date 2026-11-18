/**
 * 任务 6（升级链路容错加固）的回归钉子：restoreCaches 的失败计数。
 *
 * 审计（2026-11-19）发现旧实现把每条恢复失败静默吞掉、调用方一律报
 * `restored: true` —— 回滚失败被伪装成成功。修复后 restoreCaches 返回
 * `{failed, total}`，selfReload 据此如实上报。本文件钉住两条：全恢复成功、
 * 部分失败如实计数。
 */
import assert from 'node:assert/strict'
import { restoreCaches, purgeCaches, packageUrlOf } from '/media/kuye/128G/DSH/github工作区/临时项目/our-free-model/src/reload.js'

const pkg = packageUrlOf('file:///media/kuye/128G/DSH/github工作区/临时项目/our-free-model/src/reload.js')
// 1) 正常路径：全部恢复成功
{
  const fakeCache = new Map([[pkg + 'a.js', { job: 1 }], [pkg + 'b.js', { job: 2 }]])
  const internal = { loadCache: fakeCache }
  const backup = purgeCaches(internal, pkg)
  assert.equal(fakeCache.size, 0, 'purge 应清空（包内键）')
  const r = restoreCaches(internal, backup)
  assert.equal(r.failed, 0, '正常恢复零失败')
  assert.equal(r.total, 2)
  assert.equal(fakeCache.get(pkg + "a.js")?.job, 1, '条目回来了')
  console.log('ok  restoreCaches 正常路径全部恢复')
}
// 2) 异常路径：cache 形态坏掉，恢复失败要如实计数
{
  const brokenCache = { keys: () => [pkg + 'x.js'], get: () => ({ job: 9 }), delete: () => {} } // 无 set
  const internal = { loadCache: brokenCache }
  const backup = { esm: new Map([[pkg + 'x.js', { job: 9 }]]), cjs: new Map() }
  const r = restoreCaches(internal, backup)
  assert.equal(r.total, 1)
  assert.equal(r.failed, 1, 'set 双失败必须计入 failed（先前被静默吞）')
  console.log('ok  restoreCaches 部分失败如实上报')
}

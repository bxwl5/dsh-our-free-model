/** Hold stream metadata until content arrives or the first heartbeat is due. */
export function deferStreamResponse(res, heartbeatMs) {
  let pending = true
  let head
  let writes = []
  let bytes = 0
  let timer
  const clear = () => { clearTimeout(timer); timer = undefined }
  const commit = () => {
    if (!pending) return
    /**
     * 已断开的响应不能写，但状态必须一起释放（2026-11-26 修复）。
     *
     * 原先这里是 `if (!pending || res.destroyed) return`：destroyed 时 `pending`
     * 与 `buffered writes` / `head` 永不释放，`dispose()` 又只清定时器 ——
     * 一整个回合的缓冲（可能到 64KB 未提交的 writes）就这么挂在闭包里直到
     * 条目被回收。现在 destroyed 分支同样走清零路径，只是不碰 socket。
     */
    const headArgs = head
    const buffered = writes
    pending = false
    clear()
    writes = []
    head = undefined
    if (res.destroyed === true) return
    if (headArgs) res.writeHead(...headArgs)
    for (const row of buffered) res.write(...row)
  }
  const response = new Proxy(res, {
    get(target, key) {
      if (key === 'writeHead') return (...args) => {
        if (!pending) return target.writeHead(...args)
        head = args
        if (args[0] >= 400) { writes = []; bytes = 0 }
        if (!timer && heartbeatMs > 0) { timer = setTimeout(commit, heartbeatMs); timer.unref?.() }
        return response
      }
      if (key === 'flushHeaders') return () => { if (!pending) target.flushHeaders() }
      if (key === 'write') return (...args) => {
        if (!pending) return target.write(...args)
        const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
        writes.push(args)
        bytes += Buffer.byteLength(args[0])
        if (callback) queueMicrotask(callback)
        if (bytes >= 64 * 1024) commit()
        return true
      }
      if (key === 'end') return (...args) => { commit(); return target.end(...args) }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  res.once('finish', clear)
  res.once('close', clear)
  return { response, commit, dispose: clear }
}

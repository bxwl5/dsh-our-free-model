/**
 * 「按模型合并」的广告抑制层（2026-11-18）。
 *
 * ## 它做什么
 *
 * 把适配器的 `listModels()` 换成恒返回 `[]`，让宿主模型选择器里那一组
 * 整个消失（空组被 `buildModelCatalog` 丢弃）。**其余成员一律原样透传**。
 *
 * ## 为什么只抑制一个方法
 *
 * 宿主在建选择器目录时对每个 provider 只调 `listModels()`；但同一条路由上
 * 还有另外三处消费者，它们各自要的东西完全不同：
 *
 * | 方法 | 谁在用 | 抑制的后果 |
 * | --- | --- | --- |
 * | `listModels` | 选择器 `buildModelCatalog`、`modelAvailable` 校验 | **正是要的**：分组消失 |
 * | `listAllModels` | 渠道设置页（完整目录 + 黑名单开关） | 抑制后设置页全空，用户再也打不开被关的模型 |
 * | `resolveModel` | 宿主的元数据解析、内置网关 `/v1/models` | 抑制后容量/档位全部退化成默认值 |
 * | `prepareCall` / `stream` | 实际下发 | 抑制后直接发不出请求 |
 *
 * 所以这里**只碰 `listModels`**，而且刻意连 `providerInfo` 都不动：供应商名
 * 与身份仍原样上报，别处按 id 查询的代码不受影响。
 *
 * ## 与「失效模型剔除」包装的叠加顺序
 *
 * 叠加顺序**不影响结果**：那层把 `listModels` 过滤成子集，这层把结果换成
 * 空数组，先过滤后清空与先清空后过滤都是 `[]`。但两层的 `prepareCall` 包装
 * 必须都保留 —— 这里用 Proxy 只拦截 `listModels`，其余键走 `Reflect.get`，
 * 下层包装原样生效。
 *
 * ## 开关是热读的（2026-11-18 改版）
 *
 * 包装**始终**接在注册漏斗上，但 `listModels` 每次被调用时才读
 * `mergedAdvertisementSuppressed()`：标志关着就透传原实现。设置页的
 * 「关闭渠道分组」因此可以在运行时来回切，不需要注销/重注册任何适配器。
 *
 * @module merged-advertisement
 */

/**
 * 本进程是否正在做「按模型合并」的广告抑制。
 *
 * 开关放在模块级（而不是逐次传入 `registerAdapterIdempotent`）：注册漏斗在
 * 20 处被调用，逐处传参会漏；而 `ctx.llm.registerAdapter` 的注册项在插件
 * 卸载后才清空，期间只会有「合并开/关」这一个全局口径。
 *
 * ⚠️ 由渠道包 `apply()` 在挂载任何适配器**之前**设置一次；热重载时新实例
 * 会按新配置重置，旧实例的 dispose 不负责复位（它的路由已随之注销）。
 */
let suppressed = false

/** 读当前开关（`registerAdapterIdempotent` 每次注册时问一次）。 */
export function mergedAdvertisementSuppressed(): boolean {
  return suppressed
}

/** 设置开关；返回旧值，便于调用方在卸载时精确复位而不是盲写 false。 */
export function suppressMergedAdvertisement(enabled: boolean): boolean {
  const previous = suppressed
  suppressed = enabled
  return previous
}

/** 只抑制 `listModels` 的包装器。 */export function withMergedAdvertisementSuppression<T extends object>(adapter: T): T {
  const bound = new Map<PropertyKey, unknown>()
  /**
   * 每次访问返回同一个函数实例：下游若按函数身份做缓存或比较
   * （`dsh-llm` 的注册表会逐方法取一次），每次都新建会让比较失配。
   */
  const wrapOnce = <K extends PropertyKey>(key: K, make: () => unknown): unknown => {
    if (!bound.has(key)) bound.set(key, make())
    return bound.get(key)
  }

  return new Proxy(adapter, {
    get(obj, prop, receiver) {
      if (prop === 'listModels') {
        return wrapOnce(prop, () => async (...args: unknown[]): Promise<readonly unknown[]> => {
          if (mergedAdvertisementSuppressed()) return []
          const original = Reflect.get(obj, prop, obj)
          if (typeof original !== 'function') return []
          return (original as (...a: unknown[]) => unknown).apply(obj, args)
        })
      }
      const value = Reflect.get(obj, prop, receiver)
      // 方法要绑定回**原对象**：适配器的方法内部大量使用 `this.xxx`，
      // 直接返回未绑定的函数会让 `this` 变成 Proxy。绑定到原对象后，
      // 方法内部的 `this.listModels()` 之类调用也走原始实现（不经本层），
      // 这正是想要的：抑制只作用于宿主看到的那一次调用。
      //
      // ⚠️ 前提是这些类**没有** `#` 真私有字段（Proxy 上没有其品牌，访问即抛）。
      // 已核查 `vendor/channel-pack/src` 下全部适配器：`#` 前缀字段数为 0。
      if (typeof value !== 'function') return value
      return wrapOnce(prop, () => (value as (...args: unknown[]) => unknown).bind(obj))
    },
  })
}

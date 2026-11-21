// Minimal `undici` stand-in for the offline tests that import the channel pack's
// TypeScript sources directly (the shipped `pack.js` bundle inlines the real
// package). `opencode-proxy.ts` only constructs these when an account carries a
// proxy URL, so empty classes are enough to load the module graph.
export class Agent {}
export class Pool {}
export class ProxyAgent {}
export const Dispatcher = class Dispatcher {}
// `channel-fetch.ts` 在代理分支会 `new Dispatcher1Wrapper(...)`（真实 undici 的
// 具名导出）。stub 之前缺它，opencode-parity 直接炸在模块加载阶段
//（SyntaxError: does not provide an export named 'Dispatcher1Wrapper'）。
// 空类即可：离线测试不会真的走代理请求。
export const Dispatcher1Wrapper = class Dispatcher1Wrapper {}

// `direct-fetch.ts` 还会 `import { fetch as undiciFetch } from 'undici'`：
// 独立 undici 实例的兜底发送通道。stub 里把全局 fetch 透传即可 ——
// 离线测试关心的是「函数存在、可被替换/断言」，不是真发请求。
export const fetch = globalThis.fetch

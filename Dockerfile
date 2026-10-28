# syntax=docker/dockerfile:1
#
# Our Free Model 独立服务镜像（**不是** DSH 插件）。
#
# 镜像里只放 packages/standalone 独立版运行所需的最小文件集（约 5 MB）：
#   - src/                          共享运行时（独立版与插件共用）
#   - packages/standalone/*.mjs     CLI / 服务 / 管理面 / 登录终端
#   - packages/standalone/channels  business.mjs（渠道包）与 contracts/runtime
#   - packages/standalone/web       已构建的前端（仓库里已提交，镜像不再构建）
#   - vendor/channel-pack/qoder-auth-wasm.wasm   business.mjs 的固定相对路径依赖
#
# ⚠️ 运行时**没有任何 npm 依赖**（只用 node: 内置模块），因此不需要 npm install，
# 也不需要 esbuild / TypeScript。这一点已在 2026-10-28 用最小文件集实测：
# 单独运行后 /health 200、/ 200、/v1/models 返回 25 个模型。
#
# ⚠️ 服务**只绑定回环地址**（service.mjs 里 isLoopbackHost() 强校验），所以容器
# 推荐用 `--network host` 运行，否则管理页面从宿主机访问不到。详见 docs/docker.md。
FROM node:22-alpine

# ca-certificates：访问各家渠道的 HTTPS 必需。
# tzdata：让 TZ 生效（容器默认没有时区库）。
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# 数据目录：账号凭据、账号池、Token 账本、API Key 都在这里，必须挂卷。
ENV NODE_ENV=production \
    OFM_HOME=/data \
    TZ=Asia/Shanghai

COPY --chown=node:node src ./src
COPY --chown=node:node packages/standalone/package.json ./packages/standalone/package.json
COPY --chown=node:node packages/standalone/*.mjs ./packages/standalone/
COPY --chown=node:node packages/standalone/channels ./packages/standalone/channels
COPY --chown=node:node packages/standalone/web ./packages/standalone/web
COPY --chown=node:node vendor/channel-pack/qoder-auth-wasm.wasm ./vendor/channel-pack/

RUN mkdir -p /data && chown node:node /data

USER node

VOLUME ["/data"]

# 18900 = 主服务（面板 + 管理 API + /v1 推理 + /health）
# 18901 = 可选 LAN 推理中继（--lan 才开；它不转发管理面）
EXPOSE 18900 18901

# 端口冲突时服务会自动换端口，那时这里的 18900 探测会失败 —— 用
# `docker logs` 看实际端口，或用 --port 固定一个空闲端口。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18900/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/standalone/cli.mjs", "--port", "18900"]

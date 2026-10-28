#!/bin/sh
# Our Free Model 容器的入口脚本。
#
# ## 它解决的问题（实测，2026-10-28）
#
# 镜像里的 `/data` 属主是 `node:node`，用**命名卷**时 Docker 会把镜像目录的属主
# 一并复制进新卷，所以非 root 能写。但用 **bind mount**（`-v ./ofm-data:/data`）
# 时，宿主机目录若是 Docker 本次新建的，属主是 `root:root 755` —— 容器以
# uid 1000 启动时连 `/data/service.lock` 都建不了：
#
#   启动失败：EACCES: permission denied, open '/data/service.lock'
#
# 然后 restart 策略让它无限重启，面板永远起不来。
#
# ## 做法
#
# 以 root 启动时先把数据目录交给 `node`，**立刻降权**再执行应用；已经以非 root
# 启动（例如 `docker run --user 1000:1000`）则原样执行，不尝试改属主。
set -e

APP_DIR=/app
DATA_DIR="${OFM_HOME:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # 目录里可能只有部分是 root 的（换个卷/换台机器），递归交给 node。
  # 失败不致命：某些网络文件系统不允许改属主，那就让应用自己去报错。
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node:node node "$APP_DIR/packages/standalone/cli.mjs" "$@"
fi

exec node "$APP_DIR/packages/standalone/cli.mjs" "$@"

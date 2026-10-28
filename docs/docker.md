# Docker 部署（独立服务镜像）

镜像是 **`packages/standalone` 独立服务**，不是 DSH 插件。它自带网页管理面板、
OpenAI 兼容推理接口和全部账号渠道，运行时**没有任何 npm 依赖**（只用 `node:`
内置模块），所以镜像里没有 `npm install`、也没有 esbuild/TypeScript。

## 镜像从哪里来

GitHub Actions 在**打 tag** 时构建并推送到 GHCR：

```
ghcr.io/bxwl5/dsh-our-free-model:latest
ghcr.io/bxwl5/dsh-our-free-model:2.5.7     # 取自 tag v2.5.7
ghcr.io/bxwl5/dsh-our-free-model:2.5
```

- workflow：`.github/workflows/docker.yml`，`on: push: tags: ['v*']` 或手动 `workflow_dispatch`
- 平台：`linux/amd64` + `linux/arm64`（arm64 走 QEMU，本镜像只做 COPY 所以很快）
- ⚠️ **GHCR 包默认是 private**。要让别人（或另一台机器）直接 pull，需要到仓库
  → Packages → 该镜像 → Settings 里改成 public；否则要先 `docker login ghcr.io`
  并用带 `read:packages` 的 PAT。

## 运行

服务**只绑定回环地址**（`service.mjs` 里 `isLoopbackHost()` 是硬校验，不接受
0.0.0.0），所以必须用 host 网络，否则管理页面从宿主机访问不到：

```bash
docker run -d --name ofm \
  --network host \
  -v ofm-data:/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/bxwl5/dsh-our-free-model:latest
```

CLI 参数可以直传（镜像用 `ENTRYPOINT node cli.mjs` + `CMD --port 18900`）：

```bash
docker run … ghcr.io/bxwl5/dsh-our-free-model:latest --lan --lan-port 18901
```

改端口时要同时改健康检查用的环境变量，否则容器会一直不 healthy：

```bash
docker run -d --name ofm --network host -e OFM_PORT=18990 -v ofm-data:/data \
  ghcr.io/bxwl5/dsh-our-free-model:latest --port 18990
```

首次启动会用一次性登录链接打开面板，读日志拿链接：

```bash
docker logs ofm | head -5
# 管理页面（10 分钟内一次性登录）：http://127.0.0.1:18900/#login=…
```

链接只能用一次；过期后重启容器会再打印一条新的。

## 端口

| 端口 | 用途 | 说明 |
|---|---|---|
| **18900** | 面板 + 管理 API + `/v1` 推理 + `/health` | 同一个端口，不是分开的 |
| 18901 | LAN 推理中继 | 只有加 `--lan` 才开；**不转发管理面** |
| 18432 / 19654 / 19723 / 53699 | 各渠道 OAuth 登录回调 | 只在登录那几分钟存在 |

⚠️ 端口不是固定的：服务会优先复用上次保存的端口，冲突时自动挑一个空闲端口。
用 `docker logs` 或 `ss -ltnp | grep node` 确认真实端口；想固定就显式传
`--port 18900` 并保证宿主机上没被占用（同时设 `-e OFM_PORT=18900`，健康检查按它探测）。

## 从局域网其它机器访问面板

host 网络下 `127.0.0.1` 就是宿主机回环 —— **局域网里的其它设备依然打不开面板**。
两种办法：

1. SSH 隧道（推荐，不改安全边界）：
   ```bash
   ssh -L 18900:127.0.0.1:18900 用户名@NAS地址
   # 本机浏览器打开 http://127.0.0.1:18900
   ```
2. 只在需要局域网推理时开中继：`--lan --lan-port 18901`，它只转发模型清单和
   Chat/Responses/Messages，管理面一律不转发。

## 数据目录

`OFM_HOME=/data`。两种挂法都可以：

```yaml
# docker-compose.yml（仓库自带的那份就是这种）
volumes:
  - ${OFM_DATA_DIR:-./ofm-data}:/data     # bind mount，宿主机看得见
# 或命名卷（不占宿主机路径，但要在 /var/lib/docker/volumes 里找）
volumes:
  - ofm-data:/data
```

⚠️ **bind mount 的属主问题已自动处理**：宿主目录一般是 `root:root`，而应用以
uid 1000（node）运行。镜像入口脚本会在以 root 启动时把 `/data` 递归交给 `node`，
然后**立刻降权**执行应用；因此容器内进程仍然不是 root。想强制非 root 直接跑就加
`--user 1000:1000`，此时需要自己保证宿主目录可写。

里面全是**明文**内容：

| 文件 | 内容 |
|---|---|
| `channel-credentials.json` | 各渠道凭据 |
| `channel-pack/` | 账号池、积分、Token 账本、模型目录快照 |
| `settings.json` | 本机 API Key（`forwardKey`）与 LAN Key |

同一个数据目录**只能跑一个实例**（有 `service.lock`）。非正常退出后若锁还在，
确认旧进程已停止再删锁文件。

## 升级

```bash
docker pull ghcr.io/bxwl5/dsh-our-free-model:latest
docker rm -f ofm && docker run -d …            # 数据在卷里，不受影响
```

## 已知限制

- **只能用 host 网络**。要跑 bridge 网络，得先给 `cli.mjs`/`service.mjs` 加一个
  `--bind` 之类的开关，那等于把管理面暴露出去，需要额外的白名单/反代鉴权，
  属于降低安全边界的改动，当前没有做。
- 镜像基于 `node:22-alpine`（musl）。纯 JS 应用理论上没问题；若遇到奇怪的
  TLS/DNS 行为，把 `Dockerfile` 第一行换成 `node:22-bookworm-slim` 并把
  `apk add` 改成 `apt-get install -y --no-install-recommends` 即可。

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

CLI 参数可以直传（镜像用 `ENTRYPOINT node cli.mjs` + `CMD --port 18900`）。

### 给局域网用（推荐组合）

```bash
docker run -d --name ofm \
  --network host \
  -v ofm-data:/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/bxwl5/dsh-our-free-model:latest \
  --lan --lan-port 18901 --lan-panel
```

| 参数 | 作用 |
|---|---|
| `--lan` | 开 LAN 推理中继。**独立密钥**，与本机 `forwardKey` 不同，可单独轮换 |
| `--lan-port 18901` | 中继期望端口（0 = 自动挑空闲端口）。不会自己去开中继，要配合 `--lan` |
| `--lan-panel` | **额外把面板与管理 API 也经中继暴露**。默认关，见下节 |

启动日志会直接给出两个地址：

```
LAN API：http://192.168.2.6:18901/v1
LAN 面板（直接访问，无需令牌）：
  http://192.168.2.6:18901/
```

### 面板密码：两种形态

面板的登录方式由环境变量 **`OFM_PASSWORD`** 决定（2026-11-17 起取代原来的
`OFM_PANEL_TOKEN` —— 以前用「API Key / 固定令牌」登录，现在统一成密码）：

| | **不设** `OFM_PASSWORD` | **设了** `OFM_PASSWORD` |
|---|---|---|
| 面板 | **完全免认证**，打开即进 | 登录页输密码 |
| 回环 `127.0.0.1` | 同样免认证 | **同样要密码**（两端一致） |
| 点「退出」后 | 认证页只有一个「登录」按钮，**没有密码框** | 回到密码框 |
| 密码有效期 | — | **不过期**，重启容器仍是同一个 |
| 推理 `/v1/*` | 只认 LAN Key | 只认 LAN Key |

```bash
# 模式 B：加一道门
docker run … -e OFM_PASSWORD=你的密码 … --lan --lan-port 18901 --lan-panel
```

⚠️ **模式 A 意味着同网段任何设备都能打开并修改面板**（改设置、增删账号、看凭据）。
家用网络通常没问题，公共网络请用模式 B。不开 `--lan-panel` 时面板仍只在回环。

⚠️ **密码与 LAN Key 是两套凭据，互不越权**：LAN Key 能调模型但进不了面板；
密码能改配置但调不了模型。**本机 API Key（`forwardKey`）也不再能登录面板** ——
管理面与推理面彻底分离，一个泄露不会两边全开。

面板前端靠一个**免认证**的 `GET /api/management/auth` 判断要不要显示密码框
（它只回 `{required: boolean}`，不泄露任何秘密）。

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
| **18900** | 面板 + 管理 API + `/v1` 推理 + `/health` | 同一个端口，不是分开的；**只绑 127.0.0.1** |
| LAN 中继端口 | LAN 推理中继（+ 面板，若开 `--lan-panel`） | 只有加 `--lan` 才开；端口由 `--lan-port` 指定，0 则自动挑 |
| 18432 / 19654 / 19723 / 53699 / 5959 | 各渠道 OAuth 登录回调 | 只在登录那几分钟存在 |

⚠️ 端口不是固定的：服务会优先复用上次保存的端口，冲突时自动挑一个空闲端口。
用 `docker logs` 或 `ss -ltnp | grep node` 确认真实端口；想固定就显式传
`--port 18900` 并保证宿主机上没被占用（同时设 `-e OFM_PORT=18900`，健康检查按它探测）。

## 从局域网其它机器访问面板

服务的主端口**只绑回环**（`service.mjs` 里 `isLoopbackHost()` 是硬校验）——
这是刻意的：面板带写权限，不该默认暴露给整个子网。

三种办法，按场景选：

### 1. `--lan-panel`（推荐，容器部署就该用这个）

```bash
docker run … ghcr.io/bxwl5/dsh-our-free-model:latest \
  --lan --lan-port 18901 --lan-panel
```

局域网设备直接开 `http://<宿主机IP>:18901/`，无需任何隧道。鉴权模式见上文
「面板密码：两种形态」——不设 `OFM_PASSWORD` 就是打开即用。

### 2. SSH 隧道（不想暴露面板时）

```bash
ssh -L 18900:127.0.0.1:18900 用户名@NAS地址
# 本机浏览器打开 http://127.0.0.1:18900
```

零改动，安全边界不变，但每台设备都得建隧道。

### 3. 只开推理中继

`--lan --lan-port 18901` 不带 `--lan-panel`：中继只转发
`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、
`/v1/messages/count_tokens`，管理面一律 404。

## 路由链（降级 / 轮询）

面板左侧「**路由**」页可以把多个模型串成一条链，对外暴露成一个虚拟模型 ID
（`combo:<slug>`）。调用方只看到链名，链内部按顺序尝试，**前一个失败就换下一个**。

两种策略：

| 策略 | 行为 | 适合 |
|---|---|---|
| **顺序降级** | 每回合都从链头开始 | 质量阶梯（先试最好的） |
| **轮询** | 按「粘滞次数」轮流换起点 | 等价模型之间分摊额度 |

它解决的不是负载均衡，而是「这一路死了但别的路还活着」——额度墙、地区拒绝、
凭据过期、5xx 全都表现为「本轮死了」，而机器上另外几条车道可能完全空闲。

要点：

- **成员按顺序保存**，界面里可拖拽排序；顺序就是尝试顺序
- **链不能嵌套**（候选列表里不会出现别的链）
- **缺失成员不删除**：引用当前不可用模型的链会原样保留，车道恢复后自己回来
- **能力取交集**：链承诺的上下文 / 最长输出 / 视觉不超过最弱的那个成员
- 链本身的增删改需要**管理面登录**（见上文「面板密码」）

接口（都在管理面下，需登录）：

```
GET  /api/management/combos           链路 + 候选模型 + 每条链的解析结果
POST /api/management/combos           整表替换
POST /api/management/combos/preview   草稿链的能力交集预览
```

客户端只要把 `model` 填成链的 ID 即可，与调普通模型没有区别：

```bash
curl http://192.168.2.6:18901/v1/chat/completions \
  -H "Authorization: Bearer $LAN_KEY" -H "Content-Type: application/json" \
  -d '{"model":"combo:主力线路","messages":[{"role":"user","content":"你好"}]}'
```

## 在局域网设备上添加账号（OAuth 回调）

15 个渠道里 **11 个**（`buddy`/`workbuddy`/`qoder`/`qodercn`/`cline`/`minimax`/
`zcode`/`officeace`/`loomy`/`raccoon`/`autoclaw`）是设备码轮询或本地页承载扫码/短信，
**面板能开就能登**，不需要回调端口。

剩 **4 个**用本机 HTTP 回调（`codearts` 华为云、`trae`、`antigravity`、
`commandcode`），回调地址是进程内构造的 `http://127.0.0.1:<port>/…`。在局域网设备上
点「添加账号」时，那个 `127.0.0.1` 指的是**你自己的电脑**，打不到容器里。开 SSH 隧道：

```bash
ssh -L 18080:127.0.0.1:18080 用户名@NAS地址   # trae
ssh -L 5959:127.0.0.1:5959   用户名@NAS地址   # commandcode（5959 起最多试 10 个）
ssh -L 8845:127.0.0.1:8845   用户名@NAS地址   # antigravity（动态端口，见日志）
```

容器用 host 网络，所以这些隧道正好落进容器。登录完成后隧道可以关掉。

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
| `channel-credentials.json` | 各渠道凭据（`{ref: 字符串}` 的 JSON） |
| `channel-pack/state.json` | 账号池、模型黑名单、轮询策略 |
| `channel-pack/auto-checkin.json` | 自动签到状态 |
| `channel-pack/token-ledger.json` | Token 用量账本 |
| `channel-pack/model-catalogs/` | 模型目录快照 |
| `settings.json` | 本机 API Key（`forwardKey`）与 LAN Key（`standaloneLanKey`） |

取密钥：

```bash
# LAN Key（给局域网客户端调 /v1 用）—— 面板「网关设置」页也能直接看
docker exec ofm grep -o 'standaloneLanKey": *"[^"]*' /data/settings.json
```

跑在容器里，没有 `python3`/`jq`，所以用 `grep` 而不是解析 JSON。

### 从 DSH 插件迁移账号

插件端的状态在 `$DSH_HOME/channel-pack/state.json`，凭据在
`$DSH_HOME/.credentials.yaml` 的 `refs` 字段。搬到容器：

```bash
# 在宿主机上执行（假设插件数据在 /vol1/@appshare/Harness/.dsh，容器数据在 ./ofm-data）
SRC=/vol1/@appshare/Harness/.dsh
DST=./ofm-data

mkdir -p "$DST/channel-pack"
python3 -c "
import yaml, json, os
refs = yaml.safe_load(open('$SRC/.credentials.yaml'))['refs']
json.dump(refs, open('$DST/channel-credentials.json','w'), ensure_ascii=False, indent=2)
"
cp "$SRC/channel-pack/state.json"          "$DST/channel-pack/"
cp "$SRC/channel-pack/auto-checkin.json"   "$DST/channel-pack/" 2>/dev/null
cp "$SRC/channel-pack/token-ledger.json"   "$DST/channel-pack/" 2>/dev/null
chown -R 1000:1000 "$DST"
```

两边格式对得上：插件端 `{ref: 字符串}` 的 YAML `refs`，独立端 `{ref: 字符串}` 的
JSON，键名一致，直接搬即可。

⚠️ **绑定设备的凭证连同 `device_id`/`machine_id` 字段一起搬，所以能继续用**——
凭证里的字段是自带的，不依赖宿主机指纹。但**服务端侧失效**的账号搬过来依然失效
（额度用尽、权益过期等），那与迁移无关。

⚠️ 迁移前先 `docker stop ofm`，搬完再 `docker start ofm`，否则可能被运行中的实例覆盖。

同一个数据目录**只能跑一个实例**（有 `service.lock`）。非正常退出后若锁还在，
确认旧进程已停止再删锁文件。

## 升级

```bash
docker pull ghcr.io/bxwl5/dsh-our-free-model:latest
docker rm -f ofm && docker run -d …            # 数据在卷里，不受影响
```

## 已知限制

- **只能用 host 网络**。主服务只绑回环，bridge 网络下宿主机访问不到。
  要给局域网用请走 `--lan` / `--lan-panel`，那是有独立鉴权的中继，不是改绑定地址。
- **`--lan-panel` 不做来源 IP 白名单**。开了之后同网段任何设备都能访问面板；
  需要限制就配 `OFM_PASSWORD`，或在前面挡一层反代做 IP 过滤。
- 镜像基于 `node:22-alpine`（musl）。纯 JS 应用理论上没问题；若遇到奇怪的
  TLS/DNS 行为，把 `Dockerfile` 第一行换成 `node:22-bookworm-slim` 并把
  `apk add` 改成 `apt-get install -y --no-install-recommends` 即可。

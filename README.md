<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">

</div>

> 装上就能用：无需登录、注册、填 API Key。纯插件挂载，不改内核、无构建步骤、零依赖。

---

## 安装

```
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

重启应用一次即可（`--profile` 填你实际使用的 profile 名）。

**以真实目录手工安装时**，在 profile 的 `vendor/` 下放入本仓库 tarball，然后在 `package.json` 的 dependencies 中加入：

```
"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"
```

并在 `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`。文件名版本跟随仓库 `package.json`，不要改成同名 npm 注册表版本。

> npm 上的同名包不是本仓库发布的，请勿从 npm 安装。

## 使用

装上后重启，输入框的模型选择器里会多出 **Our Free Model** 分组，直接选即可。

- **思考强度**——模型菜单里的 Effort。能关思考的模型给开关，其余给 Light / Balanced / Deep 三档。
- **本地网关**——设置 → Our Free Model → 本地转发，启用后本机其它工具即可通过 base URL + Key 调用，兼容 OpenAI 与 Anthropic 接口。
- **局域网访问**——同一面板可开启，供同网段设备调用（默认关闭，需要单独的 Key）。
- **换网络后**——点一下"重新探测可用性"，可用模型会按当前出口重新分组。

设置页共七部分：免费模型、渠道接入、省 Token、路由、数据看板、运行日志、网关设置。

## 模型从哪来

两条免密车道：匿名免费车道与 Kilo 免费池，均为直连，不经任何第三方中转；另有十三个账号渠道（CodeArts、CodeBuddy、TRAE、Cline、Gemini 等），凭据只写入宿主凭据库。

你的 prompt 与图像会发往所选模型对应的上游——这与调用任何模型 API 相同。除此之外插件不上传任何内容，用量数据与设置只落在本机。

## 注意事项

- 免密额度由上游单方面提供，可能限流或变更；短时间内打满会返回 429，下一轮探测自动恢复。
- Kilo 免费池声明 prompt 可能被上游记录用于改进服务，请勿发送敏感内容。
- 转发端口只绑本机；开启局域网访问等于让同网段的人可以消耗你的额度，请只在可信网络中启用。
- 部分模型首字延迟较高，或思考阶段长时间无输出，属于上游行为。

## 卸载

移除 profile `package.json` 里的 bundle 条目即可，插件不留补丁；数据目录为纯 JSON，可直接删除。

## 开发

```
npm test   # 离线测试 + 清单一致性检查
```

需要 Node 22.19+，无安装步骤、无依赖。

## 许可证

MIT，见 [LICENSE](LICENSE)。本项目与任何模型提供方无隶属或背书关系。

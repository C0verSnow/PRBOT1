# 安装包与 Docker 交付

所有编译、打包和启动验收由 [GitHub Actions](https://github.com/C0verSnow/PRBOT1/actions/workflows/delivery.yml) 执行。本机只编辑和做静态检查。

## GitHub 方案比较

2026-10-26 先检索维护活跃、许可证明确的项目，再借鉴设计自行集成，没有复制来历不明的代码。

| 项目 | 维护与许可 | 实现、依赖和取舍 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) + [electron-builder](https://github.com/electron-userland/electron-builder) | MIT；Electron 45 于 10 月 20 日发布；builder [近期提交](https://github.com/electron-userland/electron-builder/commits)持续，[26.18.0 发布](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.18.0)回应社区问题 | 自带 Chromium/Node，utilityProcess 承载 Next 服务；builder 生成 NSIS/DMG/DEB。体积较大，但无需重写现有 SDK 后端或要求用户安装 Node。固定稳定版 Electron 45.0.0、builder 26.18.0，避开 27 alpha。 |
| [Next.js 官方 with-docker](https://github.com/vercel/next.js/tree/canary/examples/with-docker) | [MIT](https://github.com/vercel/next.js/blob/canary/license.md)，跟随主仓库维护；[#100260](https://github.com/vercel/next.js/issues/100260)在 10 月有问题响应与复现 | standalone、多阶段构建、非 root 运行。沿用已安装的 Next，不额外加入 Web 框架，使用 Debian slim 兼容 Node 与 CLI。 |

已知问题与处理：

- builder [#10253](https://github.com/electron-userland/electron-builder/issues/10253) 的 pnpm 依赖遗漏已在 26.18.0 修复。本项目用 npm，桌面壳没有生产依赖；Next 服务作为 resources 交付，避免二次依赖收集。
- Next [#100260](https://github.com/vercel/next.js/issues/100260) 报告 16.4 standalone 的体积和内存增长，尚不声称已解决；保留实际产物供 review 比较大小。
- [standalone 文档](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)说明 static 需要另行复制，Windows junction 可能无法搬移。打包补齐 static、解引用链接，并在 Windows 安装真实 exe 后验证。
- SDK 动态定位原生平台包，跟踪可能遗漏 CLI；配置跟踪规则并明确复制当前系统的 @openai/codex*，在交付资源中创建 SDK、运行 CLI --version。CLI 等资源放在 asar 外。
- 用户 .env 和聊天记录保存在可写用户目录，CI 不包含账户凭据，不调用付费模型。

## 产物与验证

| 产物 | 架构 | 验收 |
| --- | --- | --- |
| Windows NSIS exe | x64 | 静默安装后启动已安装 PRBOT.exe |
| macOS dmg | Intel x64、Apple Silicon arm64 各一份 | 挂载真实 DMG，从只读映像启动 app |
| Debian deb | amd64 | 解包 deb，从交付资源启动，Xvfb 中验证界面 |
| Docker tar.gz 镜像归档 | linux/amd64 | 创建容器，HTTP → SDK → CLI 替身 → 工作目录写文件，重建容器后验证聊天保留 |

每份 Actions artifact 附 SHA256SUMS.txt，保留 30 天；桌面截图另存 desktop-evidence。Windows/macOS 未签名、未公证，系统可能要求确认来源。本轮没有签名证书，也没有自动更新。

桌面验收覆盖 UI、工作目录、创建聊天、关闭后服务停止、重新打开后聊天和草稿恢复，并检查实际内置 CLI。原有 Web 回归覆盖模型替身执行、停止等完整行为；不等于真实账户推理验收。

## 桌面使用

下载对应 artifact 并解压，安装 exe、打开 dmg 或安装 deb。无需另装 Node。默认在用户目录新建 workspace，不把安装目录当作项目。

配置放在以下目录的 .env，变量沿用仓库 .env.example，重启后生效：

- Windows：`%APPDATA%/PRBOT/.env`
- macOS：`~/Library/Application Support/PRBOT/.env`
- Linux：`~/.config/PRBOT/.env`（遵循 XDG_CONFIG_HOME）

设置 `CODEX_WORKSPACE=/你的项目绝对路径`，可选 `CODEX_API_KEY`、`CODEX_MODEL`。环境变量优先于配置文件；配置不打入安装包。聊天默认保存在同目录的 chats，草稿存在 Electron 浏览器配置。复用当前用户 Codex 登录时无需 key。

服务只监听 `127.0.0.1:43127`，不会连接占用该端口的其他程序。可用 `PRBOT_DESKTOP_PORT` 设置 1024–65535 的端口；更改端口会改变浏览器 origin，旧草稿仍留在原 origin。只允许单实例；关窗口会停止后台服务。渲染器关闭 Node 集成、启用上下文隔离和沙箱，并拒绝外部跳转、新窗口和权限请求。

## Docker 使用

在 Actions 下载 PRBOT-docker-linux-amd64，解压 artifact 后：

```sh
docker load -i PRBOT-docker-linux-amd64.tar.gz
mkdir -p workspace
# 在 shell 或 compose 的 .env 中设置 CODEX_API_KEY（如需）
PRBOT_IMAGE=prbot1:ci docker compose up -d --no-build
```

打开 http://127.0.0.1:3000。只向本机发布端口。项目挂载到 /workspace，聊天与 Codex 配置使用 named volumes。容器以 uid 1000 运行，Linux 主机项目目录需要允许该 uid 写入，必要时配置 Compose user 并调整卷权限。

完全访问作用于容器内部和挂载目录，无法操作未挂载的主机文件。设置 `PRBOT_WORKSPACE=/主机项目路径` 可选其他项目。容器不自动继承主机登录；使用 API key 或在持久化卷中完成登录：

```sh
docker compose exec prbot sh -c 'node node_modules/@openai/codex/bin/codex.js login --device-auth'
```

仅在自己的终端登录，不上传账户文件到 CI。`docker compose down` 保留卷，`down -v` 删除聊天和登录数据。Compose 的 init 转发信号并回收子进程。

合并到 main 或推送 v* 标签后，CI 将验收通过的镜像发布到 `ghcr.io/c0versnow/prbot1:latest` / 对应版本和 `sha-完整提交号`。PR 阶段仅生成可载入归档。私有 GHCR 拉取需要相应权限。当前镜像仅支持 amd64。

## 远端证据

本轮交付运行链接和下载结果将在远端完成后补齐。旧 Web 测试结果不会当作新安装包通过的证据。

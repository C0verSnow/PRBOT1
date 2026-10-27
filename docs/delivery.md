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
- 远端安装验收发现 builder 的 [createFilter](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/src/util/filter.ts)会跳过复制来源根层的 node_modules。资源映射改从上一层复制 server/**/*，使 server/node_modules 保持嵌套；保留原有安装后 SDK/CLI 检查，防止只在暂存目录检查通过。
- 用户 .env 和聊天记录保存在可写用户目录，CI 不包含账户凭据，不调用付费模型。

## 产物与验证

| 产物 | 架构 | 验收 |
| --- | --- | --- |
| Windows NSIS exe | x64 | 静默安装后启动已安装 PRBOT.exe |
| macOS dmg | Apple Silicon arm64 | 挂载真实 DMG，检查最终应用签名及 Electron / Codex 架构，再启动 app |
| Debian deb | amd64 | 解包 deb，从交付资源启动，Xvfb 中验证界面 |
| Docker tar.gz 镜像归档 | linux/amd64 | 创建容器，HTTP → SDK → CLI 替身 → 工作目录写文件，重建容器后验证聊天保留 |

每份 Actions artifact 附 SHA256SUMS.txt，保留 30 天；桌面截图另存 desktop-evidence。Windows 未签名；macOS 使用 ad-hoc 临时签名，没有 Developer ID 签名、Apple 公证或自动更新。首次打开仍可能需要手动允许，不能把签名完整性校验通过等同于通过 Gatekeeper。

桌面验收覆盖 UI、工作目录、创建聊天、关闭后服务停止、重新打开后聊天和草稿恢复，并检查实际内置 CLI。原有 Web 回归覆盖模型替身执行、停止等完整行为；不等于真实账户推理验收。

## 桌面使用

下载对应 artifact 并解压，安装 exe、打开 dmg 或安装 deb。无需另装 Node。首次没有目录设置时弹出原生目录选择框；取消后在用户目录新建 workspace。

配置放在以下目录的 .env，变量沿用仓库 .env.example，启动前加载；项目 .env 也自动读取，具体规则见 [设置说明](settings.md)：

- Windows：`%APPDATA%/PRBOT/.env`
- macOS：`~/Library/Application Support/PRBOT/.env`
- Linux：`~/.config/PRBOT/.env`（遵循 XDG_CONFIG_HOME）

设置 `CODEX_WORKSPACE=/你的项目绝对路径`，可选 `CODEX_API_KEY`、`CODEX_MODEL`。已保存设置优先于启动环境和项目 .env，工作空间内保存后下一条任务生效；配置不打入安装包。聊天默认保存在同目录的 chats，草稿存在 Electron 浏览器配置。复用当前用户 Codex 登录时无需 key。

服务只监听 `127.0.0.1:43127`，不会连接占用该端口的其他程序。可用 `PRBOT_DESKTOP_PORT` 设置 1024–65535 的端口；更改端口会改变浏览器 origin，旧草稿仍留在原 origin。只允许单实例；关窗口会停止后台服务。渲染器关闭 Node 集成、启用上下文隔离和沙箱，拒绝外部跳转和新窗口；仅允许本应用写剪贴板以保留复制功能，拒绝剪贴板读取及其他权限。用户目录中的 server.log 保留最近一次启动日志。

### macOS 首次打开和“应用已损坏”

下载 `PRBOT-macos-arm64` artifact，解压后先在该目录执行 `shasum -a 256 -c SHA256SUMS.txt`。打开 DMG，把 PRBOT 拖到“应用程序”，退出旧版本后再打开新版本。不要仅凭“已损坏”几个字认定芯片不兼容；[issue #12 的截图和调查](issue-12.md)对应的是系统在应用启动前拦截。

本轮修复使用 builder 自身的临时签名流程，完整封存修改后的应用、Electron helpers 和资源，关闭不适合无证书分发的 hardened runtime。PR 交付任务仅针对无凭据的临时签名显式允许 `CSC_FOR_PULL_REQUEST`，否则 builder 会跳过 PR 的签名。最终 DMG 验收执行 `codesign --verify --deep --strict`，并核对主程序和实际内置 Codex 的 arm64 架构，随后启动真实产物。没有使用开发者证书，也没有伪造公证成功。

issue #12 的最终功能提交 `8fc1ae5` 已通过 [交付回归 40512390912](https://github.com/C0verSnow/PRBOT1/actions/runs/40512390912)：Windows、macOS arm64、Linux 安装启动及 Docker 全部成功。macOS 严格签名校验和实际内置 Codex 均通过，[截图和详细证据](issue-12.md#修复后的交付证据)已记录；在该运行下载新安装包，旧包不会自动修复。

如果提示无法验证开发者或 Apple 无法检查恶意软件，尝试打开后，到“系统设置 → 隐私与安全性”点击“仍要打开”，再确认。步骤依据 [Apple 官方说明](https://support.apple.com/en-us/102445)，仅对已确认来源且校验一致的产物操作。

如果系统仍用“已损坏”拦截，先对已复制的应用执行：

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/PRBOT.app"
```

校验失败就停止使用并重新下载，保留错误信息。只有从本仓库下载、SHA256 和上述签名校验均通过，而且确认接受这个未公证版本时，才可在终端移除**这一份应用**的下载隔离标记，然后再次打开：

```sh
xattr -dr com.apple.quarantine "/Applications/PRBOT.app"
open "/Applications/PRBOT.app"
```

这个命令不验证开发者身份，也不等于 Apple 公证，不关闭全局 Gatekeeper，不需要 `sudo`。受管理的 Mac 可能仍被系统策略阻止。CI 能证明安装包在当前 macOS arm64 runner 的完整性和运行情况；用户报告的那台 Mac 仍需要实际首次打开确认。

如果已经进入应用后才出现“PRBOT 启动失败”，提示会给出失败阶段、系统架构、诊断文件和后台日志位置。`~/Library/Application Support/PRBOT/startup-error.json` 只记录最近一次失败的阶段、架构、版本、时间和后台退出码，不记录原始异常或 .env / settings.json 内容。`server.log` 保留最近一次后台启动输出；如果本次在后台启动前就失败，它可能仍是上次日志。

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

以下是历史验收记录，其中的 Intel Mac 产物来自旧工作流；当前工作流不再构建 Intel Mac。

issue #4 功能提交 `a9dd068` 的 [交付验收 40327399604](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604)五个任务全部成功；[Web 完整回归 40327399614](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399614)通过 44 个单元测试、20 个桌面/手机浏览器测试、JavaScript 语法、类型检查、生产构建和全依赖审计（0 个已知漏洞）。最后仅追加文档、带时间戳的记录及原始截图。

| 交付内容 | 下载（保留 30 天，包含 SHA256SUMS.txt） |
| --- | --- |
| Windows x64 `.exe` | [下载 artifact](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604/artifacts/12651519478) |
| macOS Intel `.dmg` | [下载 artifact](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604/artifacts/12653025755) |
| macOS Apple Silicon `.dmg` | [下载 artifact](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604/artifacts/12653645269) |
| Linux amd64 `.deb` | [下载 artifact](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604/artifacts/12652371669) |
| Docker linux/amd64 镜像归档 | [下载 artifact](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399604/artifacts/12652490815) |

已查看并保存新设置在安装版中的原始截图：[Windows](screenshots/installed-settings-windows.png)、[macOS](screenshots/installed-settings-macos.png)、[Linux](screenshots/installed-settings-linux.png)。[浏览器桌面设置](screenshots/workspace-settings.png)与[手机设置](screenshots/workspace-settings-mobile.png)也已检查，保存按钮完整可见。此前版本首页截图继续保留。

四种桌面安装包均验证了用户 .env 自动加载、真实内置 Codex 的模型列表、preload/IPC 原生目录选择和取消、保存后的项目路径、退出、重启后的设置/聊天/草稿恢复，以及品牌资源加载。浏览器和 SDK 用例另外确认选择的模型确实传给新建/恢复线程。目录对话框的返回值由 CI 控制；模型目录成功不等于账户有付费推理权限。

容器验证了非 root 运行、原生 CLI、跨站拒绝、SDK 替身文件写入，以及删除重建容器后的聊天恢复。未使用真实账户或付费推理，未在本机运行构建、编译、测试或开发服务。

此前交付基线为 `bad18e2` 的 [运行 40280387485](https://github.com/C0verSnow/PRBOT1/actions/runs/40280387485)；以上链接为 issue #4 的新产物。当前交付保留 Windows/Linux x64 与 macOS arm64。

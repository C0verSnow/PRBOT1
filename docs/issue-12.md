# issue #12：设置弹窗和 macOS 安装包

## 已确认的现象

[issue 正文和评论](https://github.com/C0verSnow/PRBOT1/issues/12)中，设置分类切换会改变弹窗大小。两张 macOS 截图都写着“PRBOT is damaged and can’t be opened”，这发生在应用启动前；截图中的下载名已经是 arm64，不能仅凭用户描述的芯片型号认定是架构问题。

用户确认没有 Apple Developer ID 签名证书和公证凭据，本轮先处理安装包完整性并提供首次打开说明。不会把临时签名说成正式签名或公证，也不会声称 CI 等于在用户的 Mac 上验收。

## GitHub 方案比较

2026-10-27 通过 GitHub 搜索并读取了以下项目的许可、近期活动、源码与问题讨论。只借鉴已经使用的打包机制和设计，没有复制来源不明的实现，没有新增依赖。

| 候选 | 活跃度和许可 | 实现、依赖和已知问题 | 本项目选择 |
| --- | --- | --- | --- |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 约 14,686 stars；MIT；10 月 27 日仍有推送；[#5850](https://github.com/electron-userland/electron-builder/issues/5850)有维护者回应 | 内部使用 `@electron/osx-sign`，现有版本支持 `identity: "-"` 临时签名。`identity: null` 明确跳过签名；临时签名仍受 Gatekeeper 限制。与 hardened runtime 同用时需相应 entitlement。 | 沿用锁定的 26.18.0，使用工具自身签名流程，避免打包完成后随意修改已签名内容。 |
| [Electron Forge](https://github.com/electron/forge) | 约 7,163 stars；MIT；10 月 25 日仍有推送；[#4420](https://github.com/electron/forge/issues/4420)有修复 PR 跟进 | 使用 `@electron/packager`、`@electron/osx-sign` 和 `@electron/notarize`。同样需要开发者凭据才能正式签名、公证；需要替换目前的交付配置。#4420 涉及 npm 配置影响脚手架安装。 | 签名原理相同，迁移不能解决凭据缺失；保留现有 builder。 |

[Electron](https://github.com/electron/electron) 本身约 123,570 stars、MIT，10 月 27 日仍有推送。[官方代码签名说明](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md)直接展示了“应用已损坏”警告，并区分签名和公证。

核对锁定版本的 [MacPackager](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/src/macPackager.ts) 和 [MacTargetHelper](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.18.0/packages/app-builder-lib/src/mac/MacTargetHelper.ts)，避免仅按网上片段配置。

## 验证方法

仅在远端 CI 构建并运行。Web 回归通过 `npm run test:e2e` 的 settings 用例检查：反复切换四个分类，弹窗、标题和导航的 bounding box 不变；桌面、手机、较矮窗口均不超出视口；内容变长时只有右侧滚动。

交付回归先挂载实际 DMG，再运行 `node scripts/verify-macos.mjs`：确认 Electron 主程序和内置 Codex 都含 arm64，执行 `codesign --verify --deep --strict`，然后运行内置 Codex `--version`。通过后继续安装版的后台健康检查、模型发现、设置保存、目录选择、关闭和重启回归。检查针对最终产物，不只针对暂存目录。

这些检查能证明包完整性和当前 CI 系统上的启动行为，不能证明 Apple 已公证，也不能替代用户设备的首次打开验证。具体安装方法见 [交付说明](delivery.md)。

## 旧实现的远端失败证据

- [Web 回归 40509794932](https://github.com/C0verSnow/PRBOT1/actions/runs/40509794932)：桌面切换到 Codex 后，外框高度从 465.28125 变为 612，y 从 127.359375 变为 54；手机还触发了弹窗外层溢出断言。其余 24 个浏览器用例通过。
- [macOS 回归 40510914197](https://github.com/C0verSnow/PRBOT1/actions/runs/40510914197/job/122212567022)：对尚未修改签名配置的真实 DMG 执行 `codesign --verify --deep --strict`，报 `code has no resources but signature indicates they must be present`。确认旧产物签名无效，既有启动测试没有检查这一层。

两次更早的 macOS 检查分别暴露了检查脚本仅识别旧 Codex 路径、`lipo` 参数顺序错误；已先纠正检查脚本，再取得上述真正的签名失败证据。没有把检查脚本的错误当作产品故障，也没有放宽签名和布局断言。

## 修复后的 Web 证据

最终功能提交 `8fc1ae5` 的 [Web 回归 40512390906](https://github.com/C0verSnow/PRBOT1/actions/runs/40512390906)通过类型检查、54 项单元测试、26 项浏览器回归、生产构建与依赖审计。设置切换、手机和矮窗口、超长内容滚动断言全部通过；四项新单元用例验证 .env、损坏的设置、非法端口和后台提前退出时的诊断信息，不泄漏原始配置内容。本机没有编译、启动项目或运行项目测试。

从远端取回并实际查看了最终截图：[桌面](screenshots/issue-12-desktop.png)、[矮窗口](screenshots/issue-12-short-window.png)、[手机](screenshots/issue-12-mobile.png)。检查中曾发现桌面“刷新模型”按钮被挤成两行，已修正并重新通过这轮回归；此后的提交只补充文档和原始截图。

## 修复后的交付证据

同一功能提交 `8fc1ae5` 的 [交付回归 40512390912](https://github.com/C0verSnow/PRBOT1/actions/runs/40512390912)全部通过：Windows x64、macOS arm64、Linux x64 和 Docker。安装包和镜像归档在该运行的 artifacts 下载，均附 SHA256SUMS.txt。

macOS 最终 DMG 内的应用通过严格签名验证，日志为 `valid on disk`、`satisfies its Designated Requirement`；`macos-integrity.json` 显示 `Signature=adhoc`、arm64、资源封存 1439 个文件，以及实际内置 `codex-cli 0.164.0`。其后 UI、后台健康检查、模型发现、目录选择、设置保存、四分类几何稳定、退出和重启持久化验收全部通过。[macOS 安装版截图](screenshots/issue-12-installed-macos.png)已取回查看。

这证明修复了旧产物的无效签名，没有证明 Apple 已公证，也没有替代用户那台 Mac 的实际首次打开。首次打开仍按[安装说明](delivery.md#macos-首次打开和应用已损坏)处理。本机全程未进行编译或项目运行验证。

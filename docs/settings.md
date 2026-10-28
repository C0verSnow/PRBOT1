# 项目、模型与软件图标（issue #4）

## 使用方式

首次打开桌面程序、且没有已保存目录或 CODEX_WORKSPACE 时，系统弹出目录选择框。取消时使用用户数据目录里的 workspace；之后可随时打开“工作空间”重新选择。桌面使用系统原生选择框；浏览器 / Docker 填写服务端可见的绝对路径。选择后需要点“保存设置”；取消不改原设置。

设置保存项目绝对路径、最多 10 个最近项目、模型 ID、Codex 可执行文件路径与 CODEX_HOME。项目目录必须存在并允许读写。自定义 Codex 程序必须是可执行文件；CODEX_HOME 必须是已存在的可读写目录。留空程序路径使用 SDK 同版本的内置 CLI；留空配置目录使用该账户的默认 Codex 目录。用户数据目录、服务端口仍由启动配置管理，修改后重启。

桌面设置文件是用户数据目录的 settings.json（与 .env 同级）；Web / Docker 默认是 PRBOT_DATA_DIR/settings.json，也可用 PRBOT_SETTINGS_FILE 指定。JSON 带版本号，只写已知非敏感字段，通过同目录临时文件 + rename 替换；POSIX 下目录 0700、文件 0600，Windows 继承当前用户目录权限。不会保存 API key。坏 JSON、未知版本、无法读取的设置会报错并保留原文件，修复或移走后重启恢复默认。

每次读取运行配置时，加载当前项目 .env 的 Codex 参数和凭据；不会把它的 PORT、PRBOT_DATA_DIR 等值当作应用配置，也不会把整份文件传给页面或写入普通设置。桌面在后端启动前加载用户数据目录 .env；Web 继续使用 Next 的 .env / .env.local 加载机制。缺失 .env 正常使用默认值；无法读取文件或路径、模型格式无效时明确报错。dotenv 语法遵循 Node 原生解析器；无效声明按该解析器规则忽略，不执行 shell、不展开变量。

优先级：已保存设置 > 启动环境变量（包括桌面用户 .env / Web 的 Next 环境） > 当前项目 .env > 默认值。未保存的字段可继续从环境读取；显式保存的空模型表示“Codex 默认模型”，空程序表示“内置 Codex”，空 CODEX_HOME 表示“当前用户默认目录”。如需再由环境控制，可在应用退出后移走 settings.json。凭据只看启动环境和当前项目 .env，不进入普通设置。不要将 .env 设为公开可读。

保存后下一次任务立即生效，无需重启；任何会话在执行时，后端拒绝更改设置，保存设置期间也拒绝新任务。模型切换保留同一项目的线程并把新模型明确传给 SDK 的 startThread/resumeThread。每段新执行的对话记录项目真实路径；切换项目后旧对话只读，续聊会要求切回原目录或新建对话。升级前旧记录没有目录信息，第一次继续时绑定当前目录，请先确认项目。

## 模型发现与权限

核对当前锁定的 [Codex SDK 0.164.0 源码](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/codex.ts)：TypeScript 公共类提供 startThread / resumeThread，没有 listModels。任务继续使用该 SDK，发现模型则使用[官方 App Server](https://learn.chatgpt.com/docs/app-server#list-models-modellist)：同一 Codex 程序、当前项目 cwd、CODEX_HOME 和凭据环境，stdio initialize → initialized → model/list，跟随 nextCursor 分页并过滤隐藏项。没有维护自造模型清单，也不读取凭据文件拼接私有接口。

列表按需获取，支持刷新；最多等待 15 秒，结束后关闭子进程。失败时显示可重试提示，保留已保存模型。保存非空模型时重新查询当前目标环境，模型不在列表中则拒绝保存。改变目录或 Codex 程序/配置目录时，先保存默认模型，再刷新新环境列表并选择模型。列表可能来自 Codex 的内置或缓存目录，**并不保证账户推理权限**；容量、权限、认证等执行错误在对话中提示，敏感值会被隐藏。列表不会扫描硬盘寻找模型权重。

## 模型速度与推理强度（issue #6）

设置页在模型旁显示 Speed 和 Effort。选项来自所选模型的官方 `model/list`，默认模型使用列表标记的默认项；切换模型会重置这两项。留空时沿用 Codex 自身配置，速度中的“标准”显式请求 default，其他档位来自模型目录。保存前重新查询目标环境并校验，旧设置文件缺少字段时继续使用 Codex 默认。模型或运行环境变化时，请重新选择；任务开始或续聊时，SDK 接收推理强度，服务档位通过 SDK 的 `config.service_tier` 传给 CLI。服务端可能降级请求，账户权限、费用和实际速度以服务提供方为准。

设置对话框左侧为四个分类，右侧内容独立滚动。Codex 模型、速度、推理强度和程序/配置目录更改后自动保存；失败时显示错误并可重试。关闭时会先保存尚未提交的改动。更换 Codex 程序或配置目录会重置模型、速度和推理强度，再刷新新环境的模型列表。工作空间仍需手动保存；切换项目时会重置模型配置。远端测试覆盖模型元数据、非法选项、保存恢复、SDK 参数和桌面/手机滚动。

issue #12 将桌面弹窗统一为 820 × 700 CSS 像素，以原来完整 Codex 设置页为基准；宽度最多为视口减去 32 像素，高度最多为视口高度的 85%。四个分类反复切换时外框居中且尺寸不变，标题和导航不随右侧内容滚动。小屏幕按相同上限缩小，右侧长内容、错误提示和按钮在内部换行、滚动。实现和远端回归范围见 [issue #12 记录](issue-12.md)。

最终功能提交 `8fc1ae5` 的 [Web 回归](https://github.com/C0verSnow/PRBOT1/actions/runs/40512390906)及[四平台交付回归](https://github.com/C0verSnow/PRBOT1/actions/runs/40512390912)全部通过。新截图：[桌面](screenshots/issue-12-desktop.png)、[手机](screenshots/issue-12-mobile.png)、[矮窗口](screenshots/issue-12-short-window.png)。

本次查阅 [Codex 0.164.0 的模型协议](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/schema/json/v2/ModelListResponse.json)、[SDK 参数](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/codexOptions.ts) 与 [配置定义](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/config_toml.rs)。沿用下方已比较的活跃 Apache-2.0 项目 Codex 与 MIT 的 Electron / electron-store，无新增依赖；上游 [速度档位可能被服务端降级](https://github.com/openai/codex/issues/32191)，因此不承诺实际速度。

远端验证：功能提交 `b52d9c7` 的 [Web 工作流](https://github.com/C0verSnow/PRBOT1/actions/runs/40429116668)通过 44 项单元测试、20 项桌面/手机浏览器测试、类型检查、构建与依赖审计；[交付工作流](https://github.com/C0verSnow/PRBOT1/actions/runs/40429116723)通过 Windows、两种 macOS、Linux 安装验收和 Docker。Intel Mac 首次产物上传超时，单项重跑成功。本机没有编译或运行项目测试。

## GitHub 方案调查

2026-10-26 搜索候选并核对许可证、近期提交及问题响应，再自行实现接线；未复制来历不明代码。

| 项目 | 维护、许可 | 思路 / 依赖 / 已知问题及本项目选择 |
| --- | --- | --- |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0，2026-10-23 推送；[#57040](https://github.com/openai/codex/issues/57040)有问题跟进 | 官方 SDK + App Server；沿用精确锁定的 0.164.0，不添加第三方模型发现 SDK。模型容量/账户权限仍可能失败，保留错误反馈和刷新能力。 |
| [electron/electron](https://github.com/electron/electron) | MIT，2026-10-26 推送；[#55354](https://github.com/electron/electron/pull/55354)持续修复 | 原生 dialog、contextBridge、ipcMain；使用已有 Electron，不增加本机文件代理。只公开 chooseWorkspace 一个方法，校验主窗口主 frame 和本应用 URL，保留 sandbox/contextIsolation。 |
| [sindresorhus/electron-store](https://github.com/sindresorhus/electron-store) | MIT，2026-10-12 推送；[#299](https://github.com/sindresorhus/electron-store/issues/299)、[#298](https://github.com/sindresorhus/electron-store/issues/298)有维护回应 | 版本化 JSON 与原子替换适合小设置；依赖 conf，主进程所有权与现有 Web/Docker 不同。借鉴存储设计，复用 Node fs 自行实现统一后端。避免[#302](https://github.com/sindresorhus/electron-store/issues/302)大 JSON 阻塞问题，最近项目限 10 个。 |

## 图标

PRBOT 原创图形：深绿圆角方形、浅色终端提示符和绿色分支节点。独立于用户项目，统一网页 favicon、侧栏、Electron 窗口和各平台安装入口。源图 public/prbot.svg；PNG/ICO/ICNS 在 desktop/icons，public/prbot.png 用于网页图标。scripts/generate-icons.py 用 Python 标准库确定性生成多尺寸资源，不引入图像依赖。Windows 保留资源编辑以注入图标，用 signExecutable:false 关闭签名；macOS 使用 ICNS，Linux 使用 PNG。stage 脚本复制 preload、窗口图标和 public 到交付资源。

## 验收

本机只读代码、做静态语法与差异检查，不运行项目、不编译或运行测试。远端 CI 执行配置优先级、写入恢复、敏感字段拒绝、坏配置保护、任务互斥、跨项目续聊、真实子进程模型握手/分页/失败等回归；浏览器验证选择→保存→刷新→SDK 模型参数→项目文件写入，桌面/手机都覆盖。

交付 CI 在 Windows、两种 macOS、Linux 安装真实产物，验证用户 .env、实际内置 Codex 模型发现、preload/IPC 目录选择与取消、设置重启恢复、品牌资源加载，并继续原有聊天、草稿、退出回归。系统目录弹窗的返回值由 CI 控制，不依赖人工点选；图标系统入口呈现仍以产物和系统实际显示为准。Docker 继续完整交付验收。不使用用户凭据或付费推理。

## 远端结果与截图

功能提交 `a9dd068` 的 [Web 回归 40327399614](https://github.com/C0verSnow/PRBOT1/actions/runs/40327399614)通过 44 个单元测试、20 个桌面/手机浏览器测试、类型检查、JavaScript 语法检查、生产构建和全依赖审计（0 个已知漏洞）。生产测试同时覆盖确定性模型替身及真实内置 Codex 的 model/list；SDK 测试确认同一项目的旧线程能使用新保存的模型。

安装后曾发现 SDK 仅提供 import 导出，require.resolve(SDK) 违反 package exports 条件；已改为定位锁文件及资源目录中的同版本 CLI，保留原失败断言并通过生产回归。模型权限仍由实际推理时确认，未使用真实凭据或付费推理。

最终设置截图：[桌面](screenshots/workspace-settings.png)、[手机](screenshots/workspace-settings-mobile.png)。实际安装版：[Windows](screenshots/installed-settings-windows.png)、[macOS](screenshots/installed-settings-macos.png)、[Linux](screenshots/installed-settings-linux.png)。均来自远端执行并已查看；安装包验收与下载见 [交付记录](delivery.md#远端证据)。后续仅补充文档与截图。

## Telegram 和 Infisical

在 Infisical Cloud 的项目根目录、所选环境中准备 `PR_BOT_TOKEN`（兼容旧名 `TELEGRAM_BOT_TOKEN`）、`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`，为 Machine Identity 启用 Universal Auth。设置页分为“工作空间”“Codex 运行设置”“Telegram”“Infisical”四类；填写 Project ID、Client ID、Client Secret、环境名，以及允许的 Telegram 数字用户 ID（多个用逗号分开）后启用。只接收白名单用户的私聊消息和按钮。

Client Secret 保存在本机数据目录的 `telegram-settings.json`，不返回设置页面；文件使用仅当前用户可读写的权限。Telegram 和 Upstash 密钥从 Infisical 读取，约每分钟刷新，不写进本机设置。当前支持 Infisical Cloud 项目根目录。GitHub Issue 的读取、权限检查和 PR 创建复用运行主机现有 Codex GitHub 插件，必须在同一 Codex 配置中启用并授权该插件；不需要另外配置 GitHub API Token。Git commit/push 仍使用本机现有 Git 身份和推送凭据。

默认长轮询，执行任务不会占住收消息循环。所有指令、同 Thread 多轮回复、待处理消息、日志分页、确认、取消和恢复见 [Issue #14 使用与部署说明](issue-14.md)。`PRBOT_TELEGRAM_TRANSPORT=webhook` 时需要额外设置启动环境中的 Webhook Secret，并在 Telegram 注册专用 HTTPS 地址；仍然需要常驻 Node 进程，不能把该入口部署成无状态函数。

本机任务和会话元数据保存在 `PRBOT_DATA_DIR/telegram/<数字Bot ID>/`，Redis 保存缓存、日志流、去重键和工作空间租约。本机 JSON、项目 Git 文件和 Codex 自身的会话目录必须一起保留；Redis 不能代替这些文件。日志预算按每个 Bot 的正文与估算元数据计 50 MiB，缓存过期和淘汰规则见上述说明。新流程不会自动迁移旧版 Redis 记录的 Thread 映射。

Telegram 的 SDK 执行使用 `workspace-write`，禁用沙箱命令联网；插件的网络和访问范围沿用已连接插件的权限。Telegram 与网页共用当前配置的 `CODEX_HOME`、登录和插件，不额外建立隔离目录，也不把聊天侧已连接插件视为 SDK 主机必然可用。缺少 GitHub 插件或授权时明确报错。开始执行和提交/推送/创建 PR 分别确认，这是应用阶段确认，不是原生逐工具审批；本机网页和桌面的完全访问设置维持现有行为。无法确认旧子进程已经停止时会锁住工作空间，需要本机检查后 `/continue` 明确确认。任务执行期间不能改设置。

### GitHub 方案比较

Issue #14 再次检索了维护活跃且 MIT 许可明确的 grammY、Telegraf 和 Upstash redis-js，比较会话并发、持久化、HTTP 依赖和非幂等重试问题后，复用现有 HTTP 接入与 Codex SDK，加入顺序接收、Redis Streams、所有者租约和本机持久化。详细源码、提交、Issue 回复和采用思路见 [研究记录](issue-14-research.md)。没有复制来源不明的代码。

## 设置分类改版（issue #10）

功能提交 `f91fce7` 的 [Web 工作流](https://github.com/C0verSnow/PRBOT1/actions/runs/40495705161)通过类型检查、单元测试、构建及桌面和手机浏览器回归；[交付工作流](https://github.com/C0verSnow/PRBOT1/actions/runs/40495705182)通过 Windows、macOS、Linux 安装验收和 Docker 验证。本机没有编译或运行测试。此次改版复用已有的设置接口和组件，没有新增不熟悉的功能或依赖，因此未另行检索 GitHub 同类项目。

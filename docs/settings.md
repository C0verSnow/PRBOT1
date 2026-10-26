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

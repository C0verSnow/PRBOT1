> 当前行为已按 [Issue #17](issue-17.md) 更新：自然对话、完全访问、执行和 PR 交付免重复确认。Issue #14 的历史验证结果仅对应当时的版本。

# Telegram 远程使用 Codex（Issue #14）

Telegram 负责收消息和显示结果，PRBOT 的常驻 Node 进程负责任务状态、工作空间锁和交付，现有 Codex SDK 负责执行。收消息入口只等待接收记录和任务信息保存，不等待 Codex 跑完，因此执行期间仍能查询、补充要求或取消。

## 配置与部署

沿用 [README](../README.md) 的安装与远端构建交付方式。运行 PRBOT 的主机需要可用的 Codex 登录或 API key，以及持久化的项目目录、`PRBOT_DATA_DIR` 和 Codex 会话目录。只运行一个常驻 Node 服务进程；不适合请求结束即退出的 Serverless Functions，也不支持跨主机接管同一个本地工作空间。

1. 在设置页选择本机项目的绝对路径。Issue 流程要求该目录已经是 Git 仓库，工作区干净，`origin` 的读取和唯一推送地址都对应同一个 GitHub 仓库。Bot 不替用户选择或克隆任意链接中的仓库。
2. 在 Infisical Cloud 所选项目、环境的根目录准备 `PR_BOT_TOKEN`（兼容旧名 `TELEGRAM_BOT_TOKEN`）、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`。使用只允许读取这些密钥的 Machine Identity，并启用 Universal Auth。
3. 在 PRBOT 设置页填写 Infisical Project ID、Client ID、Client Secret、环境名；在 Telegram 页填写允许的数字用户 ID（多个用逗号分开）并启用。只接收白名单用户的私聊消息和按钮操作，群聊和未授权用户不会执行任务。`/id` 也只回复已授权用户。
4. Issue 读取、评论获取、权限检查和 PR 创建复用当前 Codex 的 GitHub 插件。运行 PRBOT 的同一系统账户、同一 Codex 配置中，必须实际启用并连接该插件，且已授权目标仓库的读取和 PR 创建权限。聊天侧能看到 GitHub 插件，不等于另一个 SDK 主机已经接入；插件缺失、未登录或仓库无权限时会明确失败，不自动绕到另一套认证。
5. Git commit 的姓名邮箱、SSH key 或 credential helper 仍要在本机事先配置。提交与推送使用本机现有 Git 身份和凭据；连接 GitHub 插件不会自动配置 Git 推送。无需为本流程另配 GitHub API Token。

Telegram 的 SDK 使用运行主机原有的 Codex 配置、登录和插件。若设置了 `CODEX_HOME`，就复用该目录；留空时使用当前用户默认目录。不额外创建隔离的 Codex Home，不复制认证文件或清空插件配置。请先在这份实际配置中确认 GitHub 插件可用。

运行时 Telegram/Redis 密钥仍从 Infisical 读取，约每分钟刷新；不需要把它们再写入项目 `.env`。本机设置中的 Infisical Client Secret 以仅当前用户可读写的文件权限保存，不回传页面。项目 `.env` 和启动环境中的密钥值会用于脱敏，不会作为任务日志原样缓存。

### 默认使用长轮询

`PRBOT_TELEGRAM_TRANSPORT` 留空或使用 `polling`。应用启动后自动收取更新，无需开放公网端口；同一个 Bot 只能由这一实例收消息。如果这个 Bot 原来配置过 Webhook，需要先在 Telegram 删除 Webhook，保留待处理消息后再切回长轮询。

### 可选 Webhook

在**服务启动环境**设置以下变量并重启常驻进程：

```dotenv
PRBOT_TELEGRAM_TRANSPORT=webhook
PRBOT_TELEGRAM_WEBHOOK_SECRET=填写至少16位的随机值
```

Secret 必须为 16–256 位字母、数字、`_` 或 `-`，不能使用上面示例中的中文。由 HTTPS 反向代理只转发 `/api/telegram/webhook` 到本机 PRBOT；其他本机 API 继续保留原访问边界。Webhook 模式只停止 `getUpdates`，后台任务与重启恢复仍由常驻进程处理。

需要自行调用 Telegram 的 [`setWebhook`](https://core.telegram.org/bots/api#setwebhook) 注册公网 HTTPS 地址。下面脚本只从环境读取临时配置，不把真实 Token 写进文档；注册用的 `TELEGRAM_BOT_TOKEN` 从自己的 Infisical 项目取得。`TELEGRAM_WEBHOOK_URL` 填实际公网地址，`PRBOT_TELEGRAM_WEBHOOK_SECRET` 与服务端完全一致。

```python
import json
import os
import urllib.request

payload = {
    "url": os.environ["TELEGRAM_WEBHOOK_URL"],
    "secret_token": os.environ["PRBOT_TELEGRAM_WEBHOOK_SECRET"],
    "allowed_updates": ["message", "callback_query"],
}
request = urllib.request.Request(
    "https://api.telegram.org/bot" + os.environ["TELEGRAM_BOT_TOKEN"] + "/setWebhook",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    print("Webhook 已注册" if result.get("ok") else "注册失败，请检查配置")
except Exception:
    raise SystemExit("注册失败，请检查 Telegram 配置和网络")
```

接口校验 `X-Telegram-Bot-Api-Secret-Token`，使用固定长度摘要的恒定时间比较，再校验用户、消息结构和重复更新。缺少密钥或错误密钥不会进入任务。有效请求在持久化接收后回复，不等待模型或 Telegram 发消息完成。切回长轮询前调用 [`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook)，设置 `drop_pending_updates=false`，再把启动环境改回 `polling`。

## 指令和对话

指令忽略大小写，兼容 `/command@botname`；`help`、`id`、`finish issue`、`cancel` 也能作为文本指令。

| 指令 | 用途 |
| --- | --- |
| `/start` | 显示已连接状态和当前工作空间；Codex 登录、模型权限在执行时核对 |
| `/help` | 查看全部指令 |
| `/id` | 显示当前已授权用户的 Telegram ID |
| `/FinishIssue` | 进入 Issue 链接收集流程，检查后直接执行 |
| `/status` | 查看当前任务编号、状态、进度、Thread、分支、问题和 PR |
| `/logs [游标]` | 查看当前任务一页日志，按回复中的下一游标继续查询 |
| `/tasks` | 查看本用户、本聊天、当前工作空间最近十个任务 |
| `/cancel` | 退出等待链接，或请求停止排队、等待回复、执行中的任务 |
| `/continue` | 检查此前任务并续接；中断和失败不会盲目重跑 |
| `/new` | 开启新会话；仍在执行或存在未确认停止的进程时会拒绝 |
| `/confirm 问题编号` | 兼容旧版本的问题编号；新流程不再生成权限确认 |

普通文字直接自然对话；操作请求直接执行，不需要点击执行确认。同一用户和项目保留 Thread，已过期按钮不能作用于新问题。

同一 Bot、用户、聊天和工作空间关联稳定的 Codex Thread。切换项目会使用该项目独立的会话。执行期间发送的补充要求先保存到当前任务队列，待本轮执行结束后交给同一 Thread，不会另开竞争任务。缺少信息时直接回复澄清问题，不把模型返回的 highRisk 字段变成权限审批。这是“保存问题 → 等回复 → 同 Thread 下一轮”的应用层交互，不是 SDK 原生的逐工具审批。

### 完成 GitHub Issue

```text
用户：/FinishIssue
Bot：请发送 GitHub Issue 链接。
用户：https://github.com/owner/repo/issues/14
Bot：校验本地仓库，通过 Codex GitHub 插件读取 Issue 和评论、检查权限，随后直接执行。
Bot：检查干净工作区，fetch 默认分支，建立独立 Feature 分支。
Codex：读取已获取的需求，修改代码和文档，遇到问题时等待回复。
Bot：显示改动摘要，单独询问是否提交、推送和创建 PR。
Bot：本机 Git 提交 → 推送 → Codex GitHub 插件创建 PR → awaiting_review。
```

空闲时也可以直接发送具体的 Issue 链接。只接受 `https://github.com/owner/repo/issues/具体编号`；仓库必须与本地 `origin` 对应，Issue 必须仍然打开，不能是 PR，当前 Codex GitHub 插件连接必须能访问该仓库并确认写入权限。运行中的 Issue 链接会按补充要求处理，不启动第二个竞争任务。

Feature 分支形如 `feature/prbot-issue-14-<任务编号前八位>`。自动交付前记录 HEAD、已跟踪文件差异、未跟踪文件内容和分支指纹；交付时文件又变动会停止并要求重新检查。敏感文件路径和指向工作空间外的链接也会被拒绝。提交、推送、创建 PR 分开记状态；失败后检查现有 Git 提交、远端分支，并通过 GitHub 插件查询已有 PR，再决定如何继续。

创建 PR 只代表交付待审，状态为 `awaiting_review`。**不会自动合并 PR，也不会自动关闭 Issue。** 等用户 Review、合并和验收后再处理 Issue。`completed` 用于普通对话任务完成，不能拿来表示 Issue 已验收。

### 任务状态

| 状态 | 大白话说明 |
| --- | --- |
| `queued` | 已接收，等待获得工作空间执行权 |
| `running` | 正在执行 Codex 或自动 Git 交付步骤 |
| `waiting_input` | 正在等缺失需求的答案；看 `/status` 的当前问题 |
| `completed` | 这一项普通对话任务已完成 |
| `awaiting_review` | PR 已创建，等用户审阅和验收 |
| `cancelled` | 已记录停止；是否能继续还要看原进程检查结果 |
| `failed` | 执行失败，检查错误和已完成操作后再决定是否续接 |
| `interrupted` | 连接、超时或重启留下未知执行，需要检查恢复 |

### 日志、取消与恢复

执行过程缓存命令摘要、输出尾部、文件变化、工具事件和最终回复；实时消息合并发送，不逐行刷屏。`/logs` 每次取五条事件，回复末尾的 `/logs <游标>` 可继续读取；没有新日志时也保留游标。单个事件最多保留 16,000 个字符，命令输出尾部最多 12,000 个字符；正文超过 Telegram 单条限制会按最多 4,000 个 UTF-16 单元分段，不拆开 emoji 的代理对。

`/cancel` 不回滚文件、不删除分支、不撤销已经发生的 push。停止请求发出后，若 Codex 或 Git 子进程是否已经退出无法确认，工作空间会被锁住，网页与 Telegram 都不能再启动写入。需要在本机检查原 Codex 子进程、Git 工作区和保留的 Thread，再发送 `/continue 已在本机确认停止`；仅凭 Redis 锁过期不能证明原执行已经停止。

补充要求从待处理队列取出后，会先保存为 `inFlight` 批次，直到这一轮完成才清除。重启或连接中断时不会丢掉已接收的回复；检查 Thread、文件和已完成操作后，`/continue` 会把不确定批次当作恢复资料，先检查结果，不能直接重复操作；默认恢复请求只排队一次。失败后普通追问只处理新消息，并带上上次错误供解释。发布期间或 PR 等待 Review 时收到的新要求直接续接原任务、Thread、分支和 PR。

服务重启后会核对已保存的任务。明确仍在原运行器执行的任务不能重复启动；未知执行标为中断，保留上下文供检查。已接收排队但尚未执行的任务在配置和授权仍匹配时可以重新调度。运行异常、网络断开或超时不直接重放原 Prompt；先检查 `/status` 和 `/logs`，再 `/continue`。Telegram 发消息失败也不能触发整项开发任务重做。

## 数据和可靠性边界

- 本机 `PRBOT_DATA_DIR/telegram/<数字Bot ID>/` 保存任务、会话和更新去重标记。Token 轮换但 Bot 数字 ID 不变时仍使用相同目录。会话键另含用户、聊天和项目绝对路径。
- Redis 缓存任务和会话信息，保存 Stream 执行日志、去重键和工作空间租约；本机 JSON 是任务恢复的持久来源。缓存丢失不会恢复已经不存在的 Git 文件或 Codex 会话。
- 每个 Bot 的日志预算为 50 MiB，按正文 UTF-8 字节和估算元数据计费，超出时删除最早事件；这不是 Redis 的实际内存上限，任务缓存、去重键、Redis 内部开销和旧版记录不在该预算内。事件流在最近写入后保留约 30 天，任务和会话缓存也有约 30 天期限，本机任务信息不会因此自动删除。日志过期、预算淘汰或缓存丢失后，旧游标可能没有可读事件。
- 更新在启动 Codex 之前通过本机独占写入和 Redis `SET NX` 去重。它选择避免重复执行有副作用的任务，不能保证每条消息恰好执行一次。进程恰好在去重成功、任务建立完成之前退出，或接收后保存失败时，原更新可能已经被去重；请先查 `/status`，确认后以一条**新消息**重发，不要循环重试旧更新。
- 首次升级到本流程不会自动迁移旧版 `prbot:telegram:records` 中的 Thread 映射；旧 Redis 记录和本机 Codex 会话不会被删除，新的 Telegram 任务从新的本机映射开始。请保留数据备份。
- 消息、日志和持久化内容在发送、缓存或写盘前做已知密钥和常见凭据格式脱敏。机器身份字段（例如任务编号和工作目录）保留有效格式。脱敏不是给整个文件系统加密；本机设置、Git 文件和 Codex 自身会话仍需按原权限管理。不要把数据目录提交到仓库。

Telegram 与本机使用相同的 `danger-full-access`、`approvalPolicy: never`，允许命令联网；项目路径仅为起始目录，不是文件系统边界。白名单用户的操作请求直接执行，提交、推送、PR 不再重复确认。GitHub 元数据检查单独使用只读线程，避免这类检查修改本机文件。

GitHub 插件沿用运行主机已连接插件的网络和授权范围，不受“沙箱命令禁网”等同约束。PRBOT 区分读取 Issue、执行代码和自动交付，保留仓库、分支、文件指纹与密钥文件检查，阶段间不再索要确认。Issue 和评论由 SDK 调用已有 GitHub 插件读取；本机 Git 提交、推送之后，再由 SDK 调用该插件查询或创建 PR。插件不可用时明确失败，不要求用户重新配置另一份 GitHub API Token。

本机网页和桌面原有的 `danger-full-access` + `approvalPolicy: never` 保持现有行为。工作空间写入采用本机互斥与 Redis 租约，多个白名单 ID 也不会获得彼此隔离的系统账户；这仍然是可信用户使用的单主机工具。

## 来源与验证

已在 GitHub 检索维护活跃、许可证明确的 [grammY](https://github.com/grammyjs/grammY)、[Telegraf](https://github.com/telegraf/telegraf) 和 [Upstash redis-js](https://github.com/upstash/redis-js)，比较实现、依赖和已知问题后借鉴会话隔离、顺序接收、持久化和租约设计。完整链接与 Codex SDK 0.164.0 能力核对见 [研究记录](issue-14-research.md)。没有复制来源不明的代码。

测试交给仓库现有的 [GitHub Actions](https://github.com/C0verSnow/PRBOT1/actions/workflows/ci.yml)：指令与权限、Webhook、去重、任务状态、问题回复、取消、重启恢复、日志分页与脱敏、GitHub 链接与交付状态。Redis Lua 集成测试使用 CI Redis 服务；模型/Telegram/GitHub 插件协议测试使用隔离替身，不连接真实用户 Bot 或付费模型。没有进行本地编译验证；真实 Telegram、真实 Codex 推理、主机插件连接及实际部署仍需要使用自己的账户验收，不能把替身结果当成实机通过。

### 可选真实服务检查

现有组织 Secrets 中的 `INFISICAL_CLIENT_ID`、`INFISICAL_CLIENT_SECRET`、`INFISICAL_PROJECT_ID` 和 `INFISICAL_ENVIRONMENT` 可供 GitHub Actions 手动启用 `live_services`。它通过 Infisical 读取现有 `PR_BOT_TOKEN` 和 Upstash 两项，调用 Telegram `getMe`，并验证 Redis PING 与带随机前缀、60 秒 TTL 的临时键，最后清理。不会轮询消费更新、发送 Telegram 消息或调用付费模型。允许操作 Bot 的 ID 已有 `PRBOT_TELEGRAM_ACTOR_ID`，启用应用时仍在设置页填写白名单。

组织 Secrets 需要允许 PRBOT1 仓库使用；此检查默认不运行，也不会在 PR 中读取组织密钥。完整 Codex 与 GitHub 插件交互使用运行主机已经连接的账号配置，不能把这个服务连通性检查当作真实模型和工具审批验收。

### 最终远端证据

最终代码提交 `b8f0190`：

- [主验证](https://github.com/C0verSnow/PRBOT1/actions/runs/40638298362)：129 个测试通过、26 个桌面/手机浏览器测试通过、类型检查、生产构建、语法检查和依赖审计（0 漏洞）。真实服务用例在主回归中默认跳过。
- [真实服务检查](https://github.com/C0verSnow/PRBOT1/actions/runs/40638293738)：组织 Infisical → 现有 `PR_BOT_TOKEN` → Telegram `getMe`，以及 Upstash PING、临时键互斥和清理通过。没有发消息或调用付费模型。
- [跨平台交付](https://github.com/C0verSnow/PRBOT1/actions/runs/40638298372)：Windows x64、macOS arm64、Linux x64 的安装与运行检查，以及 Docker 运行检查全部通过，产物可从该流程的 Artifacts 下载。

后续记录提交只更新文档，不改变已验证的应用代码。没有进行本地编译验证。

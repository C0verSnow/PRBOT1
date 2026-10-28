# Issue #14：Telegram 远程交互的来源核对

核对日期：2026-10-28。先检索 GitHub 同类项目，再阅读官方文档和源码；只借鉴设计，没有复制来源不明的代码。下面的 star 和提交时间是本次查询的快照，不是长期保证。

## GitHub 候选与取舍

| 项目 | 维护与许可证据 | 实现与依赖 | 已知问题与本项目采用方式 |
| --- | --- | --- | --- |
| [grammY](https://github.com/grammyjs/grammY) | MIT，3,784 stars；[最新提交](https://github.com/grammyjs/grammY/commit/e8b3b1bec0ecb0cd76af7f3996354027ba94c303)为 2026-10-16；[#978](https://github.com/grammyjs/grammY/issues/978) 有项目 MEMBER 回复 | TypeScript 中间件和可选 runner；[Node 依赖](https://github.com/grammyjs/grammY/blob/main/package.json)为 types、abort-controller、debug、node-fetch | [并发说明](https://grammy.dev/advanced/scaling)强调同一 session 的读改写必须顺序处理。借鉴其会话键和顺序处理方式，把耗时执行移出收消息入口。[#971](https://github.com/grammyjs/grammY/issues/971) 的 HTTP 错误检查提醒我们先验证响应，不能把失败响应当正常数据。 |
| [Telegraf](https://github.com/telegraf/telegraf) | MIT，9,202 stars；[最新提交](https://github.com/telegraf/telegraf/commit/776b0f3c8b5903e10ecf53e67ebad6be0413cfa6)为 2026-09-24；[#2094](https://github.com/telegraf/telegraf/issues/2094) 有 CONTRIBUTOR 回复并协调修复 | Context/中间件体系；[依赖](https://github.com/telegraf/telegraf/blob/v4/package.json)另含 mri、p-timeout、safe-compare | [session 文档](https://telegraf.js.org/functions/session.html)以 user + chat 为默认键，默认内存数据在退出后丢失。借鉴可替换持久层；再加 workspace 与 bot 标识隔离。开放问题 [#2096](https://github.com/telegraf/telegraf/issues/2096) 表明只包装启动时 client，可能漏掉每次 update 创建的 client；本项目集中封装发送、脱敏和错误处理。 |
| [Upstash redis-js](https://github.com/upstash/redis-js) | MIT，982 stars；[最新提交](https://github.com/upstash/redis-js/commit/4d3f58ef6f01610b81d19a19824f6b88460d57dd)为 2026-10-27；[#1450](https://github.com/upstash/redis-js/issues/1450) 有 CONTRIBUTOR 回复 | HTTP Redis 客户端；[redis 包](https://github.com/upstash/redis-js/blob/main/packages/redis/package.json)的运行依赖为 uncrypto | [#1455](https://github.com/upstash/redis-js/issues/1455) 报告网络重试可能重复应用非幂等命令，默认自动 pipeline 也可能使并发读写失序；该报告仍开放，不能称已修复。保留现有直接 REST 方式，以服务端原子操作处理去重和状态，不能靠重发 Codex prompt 恢复未知结果。 |

本项目已有 Telegram HTTP 接入和 Redis REST 封装，因此无需引入完整 Bot 框架。采用上述会话隔离、短入口、持久化状态和顺序处理设计，并复用现有 Codex SDK。三个候选都许可证明确、近期有提交且 Issue 有回应；Telegraf 的部分修复发布节奏较慢，因此这里只借鉴思路。

## Telegram 和 Redis 的协议约束

- Telegram 的 [`getUpdates`](https://core.telegram.org/bots/api#getupdates) 在下一次请求使用大于某条 `update_id` 的 offset 时，就认为该更新已确认。因此先保存接收结果，再推进 offset；后台任务不应占住收消息循环。
- 若启用 [`setWebhook`](https://core.telegram.org/bots/api#setwebhook)，必须校验 `X-Telegram-Bot-Api-Secret-Token`，并继续做用户授权和 update 去重；Webhook 与长轮询不能同时使用。采用何种传输方式不能改变任务所有权和会话规则。
- [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) 的文字上限是 4,096 字符。日志应合并为摘要、分页查询，不能逐行无限推送。[grammY 的限流说明](https://grammy.dev/advanced/flood)指出 429 需要等待 `retry_after`，所以发送失败不能让同一开发任务重新执行。
- [Redis `XRANGE`](https://redis.io/docs/latest/commands/xrange/) 支持 `COUNT` 和以 `(` 开头的排他起点，适合用最后已读事件 ID 翻页与续读。事件保留需有上限；旧游标被清理后要告知用户日志已经截断。
- [Upstash REST](https://upstash.com/docs/redis/features/restapi)接受 JSON 命令数组，也提供事务；事务执行期间单条命令失败并不自动撤销其他命令。本项目仍须验证每个返回结果，原子状态变更使用有明确前置条件的 Lua，而不是假定一组 HTTP 请求天然原子。
- [Redis 锁设计](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)使用所有者随机值、期限和校验所有者后释放。期限到期只能说明锁失效，不能证明原进程已停止。因此未知执行不能自动重放；恢复前检查本机运行器及持久化工作区。

## Codex SDK 0.164.0 的准确能力

官方 [OpenAI SDK 文档](https://developers.openai.com/codex/sdk/)确认 TypeScript SDK 可以创建、继续和按 ID 恢复 Thread，并将需要交互审批的定制客户端引向 App Server。本仓库固定 `@openai/codex-sdk` 为 `0.164.0`；以下细节以相同版本标签的官方源码为准，而不假定最新文档中的其他 SDK 能力也已包含。

| 能力 | 0.164.0 的实际接口 | 对 PRBOT 的影响 |
| --- | --- | --- |
| 连续对话 | [`Codex.startThread` / `resumeThread`](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/codex.ts)；线程存在本机 Codex sessions 中 | Redis 只保存 Thread ID 和任务元数据，不能代替本机 sessions、Git 和文件。 |
| 流式事件 | [`Thread.runStreamed`](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/thread.ts)返回异步事件生成器；`thread.started` 后设置 `Thread.id` | 收到 ID 后尽快保存。事件包括 item 开始/更新/结束，以及 turn 完成/失败；文字回复不等同于整个 turn 已成功。 |
| 取消与结构化回复 | [`TurnOptions`](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/turnOptions.ts)提供 `signal` 和 `outputSchema` | 用 AbortSignal 停止当前执行；用最终回复约定表达等待用户回答、结果或交付状态。仍要校验模型输出，不能仅凭模型声称 PR 已创建就设置成功。 |
| 执行边界 | [`ThreadOptions`](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/threadOptions.ts)有 sandboxMode、approvalPolicy、workingDirectory 等 | Telegram 远程入口应有独立明确的执行边界；不能把本机网页的无限权限直接视作 Telegram 每条消息的授权。 |
| 原生实时审批 | 上述 TurnOptions/Thread 没有用于回答工具审批的 callback；[`exec.ts`](https://github.com/openai/codex/blob/rust-v0.164.0/sdk/typescript/src/exec.ts)通过子进程执行、stdin 一次写入 prompt 后关闭 | “保存问题→等待 Telegram 回答→同 Thread 下一轮”可以实现普通澄清；不能声称这种方式恢复了原生工具审批。 |

真正逐工具审批由官方 [App Server 的 approval 请求协议](https://developers.openai.com/codex/app-server/#approvals)提供：服务端发起 JSON-RPC 请求，客户端按 thread/turn/item 回答。本次沿用既有 SDK 时，应在应用层保存明确的待确认事项、只允许匹配问题的确认继续，并说明与 App Server 原生审批的区别。

## 实现时必须保留的判断

以下是结合来源对本项目做的设计推论，不是外部库自动提供的保证：

1. 同一会话固定 Thread ID；同一时刻最多一个写入任务。执行中追加文字先保存队列，到安全的 turn 边界再交给同一个 Thread。
2. `/cancel` 首先发出停止请求，等执行流真正结束后再标记停止。无法确认旧进程退出时不启动第二个写入者。
3. 本机任务元数据、Git 分支和 Codex sessions 保留，Redis 用于跨请求状态和事件；重启把未知运行标为中断，用户检查后再继续。
4. Issue URL 只接受明确的 GitHub owner/repo/issue number，并验证本地仓库 origin 与 GitHub 可访问性。模型或消息中的链接不能替代访问检查。
5. Push、PR 创建、等待 Review、合并和关闭 Issue 分开记录。创建 PR 进入 `awaiting_review`，不等于验收完成，不自动合并或关闭 Issue。
6. 凭据在缓存、磁盘和 Telegram 输出之前脱敏。原始 prompt 和 SDK 内部线程仍属于本机受保护数据，不能以“脱敏日志”名义对其安全范围作扩大保证。

## 验证边界

按仓库约定，不运行本地构建、编译、类型编译或会触发编译的测试。功能和集成验证交给现有 GitHub CI；没有真实 Telegram/Codex/Upstash 凭据的远端用例只能说明模拟协议与隔离行为通过，不能冒充真人 Bot 的实机验收。

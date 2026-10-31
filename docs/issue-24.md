# Issue #24：从 Telegram 指令到经过验收的 PR

目标：https://github.com/C0verSnow/PRBOT1/issues/24 。测试任务：https://github.com/C0verSnow/TestRepository/issues/8 。

## 使用与结果

在 `@PRbyTroy_bot` 发送 `/FinishIssue`，再发送一个 Issue 链接。Bot 会准备本地仓库和独立 feature 分支，读取指令，执行修改，提交并推送 PR，等待远端 CI，通过后按 Issue 正文处理关闭。PR 保持 Open 等人 Review，不自动合并。

```
queued → preparing_repository → reading_instructions → executing
       → validating → publishing → waiting_ci → closing_issue → awaiting_review
```

`/status` 显示真实仓库、基准与交付 SHA、PR、CI 结果与链接、Issue 状态、文件、文档说明和指令读取记录数量。`/logs` 能查到带 Unix Timestamp 的阶段记录和每个指令文件的路径、SHA-256、读取时间。不要把模型返回的 `ready_to_publish` 当作测试通过。

## 修改代码前检查什么

- 复用原来的权限检查、origin 检查、非空目录保护、本机锁与 Redis 租约。Git 作者身份有问题会在启动代码修改前报错。
- 保存分支来源和基准 SHA。创建分支后、启动可写的 Codex 回合前，后端实际读取从文件系统根到目标目录的 `AGENTS.md`，以及 Git 列出的仓库内已跟踪和未忽略的嵌套 `AGENTS.md`。按路径向 Codex 提供指令内容，持久化只保留路径、哈希和时间；不保存指令正文。
- 指令符号链接、非普通文件、读取失败或总大小超过 256 KB 时停止。忽略目录内的新文件或新建指令仍要求 Codex 在修改对应路径前自行检查，后端审计只证明已记录的文件，不声称覆盖所有未来路径。
- 模型必须返回逐项需求核对和文档说明。没有证据或有未完成项时不能进入发布。需求语义仍由 Codex 核对；后端独立核实文件差异、仓库身份、当前提交和远端 CI，不把自然语言结论当作远端证据。没有 CI 的目标仓库要求 Codex 添加适用的 GitHub Actions 检查。

## CI 和关闭 Issue

通过已登录的 Codex GitHub 插件实际读取 PR、目标 Issue、当前提交的 Check Runs、Commit Status 和按 SHA 筛选的 Actions runs。后端直接从成功工具调用的参数和返回值取得证据，模型最终 JSON 中的 `ok` 不决定通过与否。核对 PR 仍为 Open、head/base、head 仓库和 SHA 一致；本地分支、HEAD 和干净状态也必须一致。

同一检查或工作流的较新结果覆盖旧失败，其他失败不能被覆盖。三个来源必须读取完整，超过一页 100 项或格式缺失就停止并明确提示，不能凭第一页通过结果关闭 Issue。至少一项 success，其他结果全是 success/neutral/skipped，且没有等待项才能通过；全部跳过、没有检查、仍在运行都不能当作通过。CI 失败立即保留 PR 和日志；待完成或暂无结果每 15 秒再核实，最多等待 30 分钟，超时后 `/continue` 可重新等待，不自动重跑失败工作流。

只有**实际读取的 Issue 正文**明确要求“完成后关闭 Issue”或等价英文，才允许在 CI 通过后关闭；否定表达优先，引用和代码块不授权关闭，评论或模型生成的字段不改变策略。关闭前再次读取目标正文与状态；已 Closed 就返回，不重复更新。调用关闭后必须再读取 Closed，网络中断不能凭写请求的返回虚报完成。正文没有明确关闭要求时，Issue 保持 Open，但经过验收的 PR 仍可进入 awaiting_review。

## 中断、取消与恢复

发布阶段、暂存树、提交 SHA、PR URL、CI 结果、Issue 状态分别保存检查点。提交前保存暂存树和暂存后的文件指纹，提交完成后保存 SHA。重试提交、推送或 PR 创建时先核对本地与远端状态，同 head/base 的 Open PR 优先复用，不重复创建。

等待 CI 或关闭阶段失败后，空的 `/continue` 只核实交付结果，不重新执行开发回合。需要修代码时用 `/continue 具体修复要求`，或在 Review 阶段直接发送要求，沿用原 Thread、分支和 PR。执行期间收到补充要求会在回合或交付边界处理，不按旧结果提前宣布完成。CI 等待与关闭阶段的已退出运行器可以重启恢复；正在执行 Git 或 Codex 时仍使用原有停止检查，不能假定子进程已停止。

`/cancel` 保留文件、分支、PR 和恢复记录，不做 clean/reset 或撤销远端结果。取消后续接仍先核实真实状态。关闭请求与取消同时发生时，远端可能已经关闭；取消不能撤销已经发出的操作，恢复必须读回状态。

## GitHub 检索与借鉴

查询日期：2026-10-31。只借鉴设计，按本项目实现，没有复制代码，也没有增加运行时依赖。

| 项目 | 活跃、许可与维护证据 | 实现、依赖和已知问题对比 |
| --- | --- | --- |
| [cli/cli](https://github.com/cli/cli) | MIT，46815 star，最近推送 2026-10-30；[Issue #14843](https://github.com/cli/cli/issues/14843) 有维护者调查与回复 | [pr checks](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go) 聚合检查、区分等待与失败、完整读分页；没有检查时明确报错。Go/Cobra/GraphQL 不适合直接引入现有 Node 桌面程序，本项目沿用 Codex GitHub 插件，缺少完整结果时拒绝通过。#14843 显示命令成功与 GitHub 状态可能不一致，因此读回远端状态，不能只信退出码。 |
| [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript) | MIT，945 star，最近推送 2026-10-31；[Issue #1733](https://github.com/temporalio/sdk-typescript/issues/1733) 有维护者解释并记录修复决策 | [workflow activities](https://github.com/temporalio/sdk-typescript/blob/main/packages/workflow/src/workflow.ts) 把外部步骤与可恢复流程分开，超时和重试有明确边界。完整 Temporal 需要服务端和更多部署依赖，本项目保留原有文件持久化、Redis Streams 与租约，只增加交付检查点。#1733 提醒重试配置的特殊值会出现文档与实现差异，本项目使用明确的时间边界，不引入无限重试。 |

API 依据：[GitHub Check Runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)、[Actions workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)、[Codex SDK](https://developers.openai.com/codex/sdk/)。

## 验证记录

遵守上层 AGENTS.md，没有本地构建、编译、TypeScript/Vitest、开发服务或冒烟验证。代码阅读与 `git diff --check` 可以在本地进行。编译与测试使用仓库已有 GitHub Actions。

新增回归覆盖指令读取顺序和哈希、符号链接拒绝、需求证据缺失、CI 等待/失败/缺失/过期 SHA/分页不完整、工作流失败、重跑结果、明确与否定关闭策略、关闭后读回、网络中断恢复、取消和重启。原有 Telegram→真实 Redis→SDK 子进程→Git 克隆/提交/推送的整条 CI 回归扩展到远端检查证据与 Issue 关闭；其中 Telegram、GitHub、模型仍为隔离夹具，不能冒充真实 Bot 验收。

真实 Telegram Web 已发 `/FinishIssue` 并收到 Issue 链接提示，随后发送 TestRepository #8。后续真实运行与远端 CI 结果在 tasklist.md 和 PR 中补充。

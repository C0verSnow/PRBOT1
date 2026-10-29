# Issue #19：先准备仓库，再完成 Issue

对应 https://github.com/C0verSnow/PRBOT1/issues/19 。原故障是在普通目录执行 `git remote get-url origin`，得到 `fatal: not a git repository`；旧版 `/continue` 还跳过了最初的 Issue 校验。

## 现在怎么用

1. `/FinishIssue` 后发送 Issue 链接。支持裸链接、Markdown、嵌套 Markdown，以及空格隔开的中文说明；相同 Issue 的跟踪参数和锚点会去掉。
2. 配置目录本身有 `.git` 时，只复用 origin 与 Issue 一致的仓库。如果是普通目录，在 `<配置目录>/<owner>/<repo>` 中复用或克隆对应仓库。比如配置 `/Users/troy/Desktop/2`，目标是 `/Users/troy/Desktop/2/C0verSnow/TestRepository`。配置目录里的其他项目不动。
3. 新仓库使用无密钥的 HTTPS 地址和主机已有 Git 凭据克隆。GitHub 插件继续负责读取 Issue、核实权限和创建 PR。Git 凭据和插件授权是两件事；私有仓库克隆失败时先在主机修复 Git 登录，再 `/continue`。
4. 在仓库内重新校验 Issue 和权限，检查工作区干净，fetch 默认分支，再从拉取结果建立 `feature/prbot-issue-<编号>-<任务前8位>`。不会 pull/reset 本地默认分支。
5. Codex、Git 和 PR 发布都在实际仓库目录执行。授权与会话仍使用配置目录，`/status` 会显示仓库目录；不会修改应用的项目设置。
6. 自动交付 PR 后继续等待 Review，不自动合并或关闭自动任务指向的 Issue。本次开发任务 #19 按正文要求，在远端验证通过并提交 PR 后关闭。

## 文件保护与失败恢复

- 目标目录非空且不是仓库、origin 或推送地址不匹配、`.git` 损坏、目录被文件或符号链接占用时，报错并保留文件。不会对已有文件执行 `git init`，也不做 clean/reset 或自动删锁。
- 根目录是普通目录时，克隆只进入目标子目录；Git 自身也会拒绝覆盖突然出现的文件。克隆失败只尝试移除空目标目录，有残留内容就保留，需在本机检查。
- 支持 Git worktree 的 `.git` 文件。通过 `rev-parse --show-toplevel` 核实目标是独立工作区，不误用上层仓库。
- 任务持久化 `repositoryPath` 和 `failedStage`；`/continue` 必经 `preparing_repository`，没有分支时还会重新读取 Issue。旧版只记录 `failed` 的任务也能走这个流程。
- 创建分支成功但持久化中断时，只在当前分支就是同一任务分支时复用，保留未提交文件；已有分支但当前分支不同就停止并提示检查。已有 Thread 或分支的任务缺失仓库时，不会重新克隆并重做任务。
- 配置目录和实际仓库都加本机锁和 Redis 租约，避免从另一项目设置进入同一仓库并发写入。取消或重启无法确认子进程停止时，两处目录都恢复停止检查；确认停止后一起解锁。
- 恢复已开始执行的任务时仍保留 Thread、分支、未核对请求和恢复资料；交给模型先核对结果。PR 创建仍先查相同 head/base 的已有 PR，不盲目重复创建。
- 链接中存在多个不同 Issue、跳转地址、其他 URL、非法路径或编号后粘连文字时明确拒绝。说明文字和链接之间请留空格；不会把 `8，Bot` 或 `8%EF%BC%8CBot` 截断为合法的 #8。
- 实际仓库的 `.env` 继续由 runtimeConfig 读取，新增密钥也加入日志/持久化脱敏集合，不向用户回显值。

## GitHub 检索与借鉴

查询时点：2026-10-29。只借鉴生命周期和校验顺序，按本项目重新实现，没有复制开源项目代码，也没有新增依赖。

| 项目 | 活跃与许可证 | 实现思路、依赖和取舍 |
| --- | --- | --- |
| [cli/cli](https://github.com/cli/cli) | MIT，约 46793 star；最近推送 2026-10-28；[Issue #14861](https://github.com/cli/cli/issues/14861) 有自动维护回复并关闭（仅作响应记录，不作为技术结论） | [repo clone](https://github.com/cli/cli/blob/trunk/pkg/cmd/repo/clone/clone.go) 先确定仓库身份、规范化仓库地址，再交给 Git 克隆。Go/Cobra、Git 客户端和 GitHub API 依赖无需引入 Node 项目；复用现有 execFile 和 GitHub 插件。其宽松 simplifyURL 适合 clone，本项目 Issue 输入仍严格核对完整路径。 |
| [actions/checkout](https://github.com/actions/checkout) | MIT，约 8984 star；最近推送 2026-10-17；[Issue #2596](https://github.com/actions/checkout/issues/2596) 有故障原因回复并关闭 | [git-source-provider](https://github.com/actions/checkout/blob/main/src/git-source-provider.ts) 区分仓库准备与 fetch/checkout；[git-directory-helper](https://github.com/actions/checkout/blob/main/src/git-directory-helper.ts) 检查已有仓库身份。使用 @actions/core、exec、io 等 CI 依赖，本项目只借鉴阶段划分。它在一次性 Runner 里可删除不匹配内容、分支和锁，本机持久工作区不能采用这些行为。#2596 说明运行环境也可能终止 Git/容器流程，不能把中断直接当成未执行。 |

## 回归检查

本地遵守 AGENTS.md：只读代码和 Git 差异检查，不安装依赖、不运行 TypeScript/Vitest/Next 或本地构建。diagnosing-bugs 技能中的本地红绿循环让位于仓库的明确约定，编译与运行验证交给已有 GitHub Actions。

新增用例使用临时目录和真实 Git、本地 bare 仓库；HTTPS 克隆在测试中通过 Git URL 重写导向隔离传输，不写入真实 GitHub 仓库。覆盖：嵌套 Markdown、非法与歧义链接、普通/空目录克隆、已有正确仓库、错误推送地址、非空目录、损坏 `.git`、符号链接、克隆失败重试、取消、同分支重复恢复保留改动，以及旧失败任务在准备仓库后重新校验、正确目录贯穿 SDK 和发布。

另有完整 Telegram→真实 Redis→SDK 子进程→Git 克隆/提交/推送→PR 插件夹具回归：先验证非空目录失败且文件保留，移除占位文件后 `/continue` 恢复同一任务并交付 PR。真实 GitHub 与 Telegram 网络由隔离夹具替代。

验证结果在 PR 与 tasklist.md 中记录；以对应提交的远端 CI 结果为准。

## 打包回归

首次远端交付发现 Next 文件追踪把应用自身的 `.git` 对象带入 standalone，macOS codesign 在只读 pack idx 文件上报 Permission denied。按 [Next.js 官方 output 文档](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/output.mdx) 的 outputFileTracingExcludes 排除构建仓库 `.git`，打包阶段再过滤并检查 Git 元数据，防止桌面产物混入仓库历史。目标运行仓库的 `.git` 检查保持正常。这个修正同样由远端构建和安装产物验证，不做本地构建。

## 最终验收结果

代码提交 `d688410` 已通过 [远端核心 CI](https://github.com/C0verSnow/PRBOT1/actions/runs/40854815941)：类型检查、150 项测试、构建和 26 项浏览器检查；1 项真实服务测试未启用。完整 Issue 恢复回归已通过，真实网络由隔离夹具替代。

[远端交付 CI](https://github.com/C0verSnow/PRBOT1/actions/runs/40854815965) 全部通过：Windows x64、macOS arm64、Linux x64 安装包及安装启动检查，Docker 镜像与真实容器回归。macOS 的 `.git` 签名问题已修复并重新验证。

[PR #20](https://github.com/C0verSnow/PRBOT1/pull/20) 保持开放等待用户 Review，未合并；按正文要求已关闭本次开发任务 #19。最后的验收记录提交只修改 Markdown，使用 `[skip ci]`，不重复构建相同代码。本地没有进行编译验证。

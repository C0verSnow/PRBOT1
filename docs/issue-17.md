# Issue #17：Telegram 能正常聊天，按要求直接操作

对应 [Issue #17 及最新评论](https://github.com/C0verSnow/PRBOT1/issues/17)。最新评论明确要求像 GPT 一样正常对话，并和本机 Codex 一样使用完全访问、免重复确认。

## 现在如何使用

- 直接发送“你好”“啥意思”等文字，Codex 在同一个 Thread 用自然语言回答；普通聊天不再要求 JSON 任务状态、执行确认或发布确认。
- 发送操作请求直接执行。`/FinishIssue` 再发 Issue 链接，或空闲时直接发 Issue 链接：检查仓库和插件权限，建立 Feature 分支，完成后自动提交、推送和创建/更新 PR，等用户 Review。
- Telegram 与桌面使用 `danger-full-access`、`approvalPolicy: never`、`skipGitRepoCheck: true`。工作空间只是起始目录，命令允许联网。GitHub 元数据检查使用只读线程，PR 创建使用完全访问线程。
- 缺少需求信息才提问，直接回复即可。旧 `/confirm` 只保留兼容入口，新任务不再产生权限确认。
- 执行期间的消息排队进入同一任务；发布期间与 Review 阶段的补充要求保留原 Thread、Feature 分支和 PR。
- `/cancel` 停止执行并更新状态、进度，清理旧问题和旧错误；文件操作不自动撤销。
- 明确退出的启动错误不会误锁工作空间。可直接询问原因、`/new` 新建，或 `/continue` 先检查上次结果再续接。
- 只有取消、超时、重启等导致无法确定遗留子进程是否停止时，工作空间才暂时锁住。此时提示不会推荐无法使用的 `/new`；在本机确认停止后发送 `/continue 已在本机确认停止`。这是避免两个写入者同时运行所需的进程检查，不是常规权限审批。
- `/continue` 的默认请求只加入一次。不确定是否已执行的旧请求作为恢复资料交给模型，要求先检查 Thread、文件和 Git 状态，不能假定未执行或直接重放。失败后普通追问只处理新消息。
- 单独的 `/id` 查询 ID；`1 /id` 仍是普通文本，避免把用户句子里出现的指令当作命令执行。

旧版本因 `Not inside a trusted directory` 误留的 `requiresStopCheck`，会在确认没有活动运行器时自动清理；其他来源的真实中断锁仍保留。

本次交付流程要求提交 PR 等用户 Review，并按本 Issue 正文要求在验证完成后关闭 #17；应用自身的自动 Issue 流程继续停在 `awaiting_review`，不自动合并或关闭用户的 Issue。

本机配置核对还确认：上级项目 `.env` 的 `INFISICAL_SECRET_PATH` 被旧逻辑按变量名里的 `SECRET` 当成密钥，实际属于纯符号路径值，导致分隔符被全文替换。核对时只输出变量名和分类，没有输出密钥值。

## 根因和修复

| 原问题 | 修复 |
| --- | --- |
| Telegram 设置 `skipGitRepoCheck: false`，普通目录启动就退出 | 与桌面统一跳过 Git 检查；通过真实 SDK 子进程参数回归 |
| 所有消息进入执行确认，闲聊也被当成结构化任务 | 普通对话自然语言输出；Issue 才使用结构化状态；执行和交付直接排队 |
| SDK 已报告退出却仍按活动进程锁住目录 | 识别 SDK 已等待 exit 后抛出的退出错误；失败事件先排空事件流；真正无法确认停止时才锁定 |
| 失败后永远返回固定恢复模板 | 新消息带入上次错误解释，继续 Thread，不自动重放旧任务 |
| 重复 continue 累积默认请求和旧 inFlight | 默认请求去重，未核对输入转成恢复资料；重启不自动重放 |
| 取消保留旧 stage/error/question | 同步清理并显示 cancelled/stopping 等实际进度 |
| `/`、`\` 等短配置污染路径和命令 | 忽略纯符号全文匹配；短字母数字密钥按边界替换；仍处理授权头、密钥赋值和已知 token 格式 |
| 问题/排队/执行通知相互抢先 | 接收回复先入队，再启动 Worker；所有发送者共用按 Bot/聊天分组的 FIFO，长消息分段也整体保序 |

## GitHub 检索与方案比较

2026-10-28 检索 Telegram TypeScript 开源方案，读取仓库元数据、维护记录及官方实现，不直接复制未知来源代码：

| 项目 | 维护与许可证 | 可借鉴之处、依赖与已知限制 |
| --- | --- | --- |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0，约 13.1 万 star，检查时当天有提交和已响应的 PR | 直接使用项目已固定的官方 `@openai/codex-sdk` 0.164.0，不增加依赖。新建/恢复 Thread、流式事件和权限参数沿用 SDK；退出状态依据官方 [exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts) 的 exit 等待逻辑。SDK 的 AbortSignal 不保证任意孙进程均已退出，未知中断仍保留锁。主分支源码只作参考，锁定版本最终通过远端实际 SDK 回归核对。 |
| [grammyjs/grammY](https://github.com/grammyjs/grammY) | MIT，约 3785 star，2026-10-16 有提交；[Issue #978](https://github.com/grammyjs/grammY/issues/978) 有回复且由维护者关闭 | 借鉴按聊天串行处理的设计。已有 Bot API HTTP 适配和持久化任务存储可复用，无需引入完整框架及其 Telegram 类型、fetch 兼容等依赖。仅串行接收不足以保证 Worker/问题通知等多来源消息顺序，因此额外统一发送队列；网络发送失败仍不能保证消息恰好送达一次。 |

官方 [Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)介绍创建和恢复 Thread；参数和退出细节同时核对官方开源实现与本项目锁定版本的远端子进程用例。

## 验证记录

遵守仓库约定，没有运行本地构建、编译、测试或冒烟脚本。

先只提交两条新增回归，在 [远端失败运行 40680306082](https://github.com/C0verSnow/PRBOT1/actions/runs/40680306082) 复现：

```text
问候：Expected completed，Received waiting_input
路径：Expected /Users/troy/Desktop/2 /confirm /status
      Received [已隐藏密钥]Users[已隐藏密钥]...
129 个原有测试通过，2 个新增测试失败。
```

修复后由已有 CI 运行类型检查、单元回归、Redis 全链路、真实 SDK 子进程测试替身、生产构建和浏览器回归。交付工作流在远端构建 Windows、macOS、Linux 安装包和 Docker 并验收安装后的应用。最终代码 `9aefedb` 已通过 [远端主验证 40681345171](https://github.com/C0verSnow/PRBOT1/actions/runs/40681345171)：138 个测试通过、26 个桌面/手机浏览器测试通过、类型检查、生产构建、JavaScript 语法检查、依赖审计 0 漏洞。真实服务连通性用例默认跳过，不能算作实际 Telegram 对话验收。[远端交付 40681345200](https://github.com/C0verSnow/PRBOT1/actions/runs/40681345200)也已全部通过：macOS arm64、Windows x64、Linux x64 安装后检查与 Docker 运行检查；产物可在该运行的 Artifacts 下载。

确定性测试替身能核对参数、消息顺序、写文件和状态恢复，不能冒充真实模型或用户主机上的 GitHub 插件验收。本机已安装 PRBOT/WebTG 的联调记录会独立说明，避免把旧安装包行为当作新代码结果。


## 本机真实服务核对

- 使用本次远端 macOS 安装包，核对 Artifact 内的 SHA-256 与应用签名后更新 `/Applications/PRBOT.app`；旧应用备份在 Downloads，用户设置、密钥连接和聊天数据保留。未进行本地编译。
- 旧版 WebTG 实际发送“你好”，复现执行确认、路径误脱敏和通知倒序；随后 `/cancel` 结束该测试，没有确认执行旧任务。
- 新版后台健康检查正常；旧任务因 trusted-directory 启动报错误留的停止检查锁已自动清理，进度恢复为 failed。
- 通过已安装新版的本机服务 API 使用真实登录和模型发送“你好”，真实回复为“你好，有什么需要我帮你处理的？”。没有启动目录报错，没有执行确认。
- 同一真实 Thread 再要求把开场问候写入起始工作空间之外的 `/tmp/prbot-issue17-proof-1793188389.txt`；实际文件最终内容为“你好”，任务 completed。核对了上下文延续和完全访问写入，不涉及编译或运行测试脚本。
- 新版 WebTG 最终全链路复测未完成：更新期间界面控制工具超时，此后访问 Chrome 和 Telegram 均报 `cgWindowNotFound`，无法继续发消息。上面的本机服务 API 结果不能当成新版 Telegram 全链路通过；Telegram 接收、持久化、Worker、真实 SDK 子进程、Redis 和回复顺序由远端确定性回归覆盖。
- 没有在用户的真实仓库触发自动开发、提交或 PR 发布任务；真实主机 GitHub 插件的开发任务验收仍应由用户 Review 时体验。本 PR 的发布和 Issue 关闭通过已连接 GitHub 工具完成，不自动合并。

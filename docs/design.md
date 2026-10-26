# Codex 本机对话工作台

对应 [issue #1](https://github.com/C0verSnow/PRBOT1/issues/1)。目标是本机单人、能连续对话和直接修改项目的程序。用户后续明确要求关闭 sandbox 隔离，因此执行参数固定为 `danger-full-access` 和 `approvalPolicy: never`。

## 先检索，再扩展

2026-10-26 在 GitHub 检索 Codex SDK 聊天和 Next.js 聊天 UI 项目；随后读取官方源码、许可证、近期提交以及问题讨论。没有复制来源不明的代码。

| 候选项目 | 活跃与许可证据 | 实现、依赖、已知问题 | 本项目的选择 |
| --- | --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | Apache-2.0；最近 push 2026-10-23；[会话恢复问题 #57002](https://github.com/openai/codex/issues/57002) 有维护者在 2026-10-26 回复 | TypeScript SDK 包装官方 CLI，以 JSONL 返回线程、文本、工具、文件和 usage 事件；`runStreamed` 接受 AbortSignal，`resumeThread` 恢复上下文。CLI 会话列表受工作目录影响，不能用标题或列表位置当线程 ID。 | 直接依赖官方 SDK 0.164.0，沿用其流式和恢复设计；服务端保存真实 thread ID，浏览器只提交本程序生成的 chat ID。 |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT；最近 push 2026-10-26；[会话头选择修复 #10116](https://github.com/assistant-ui/assistant-ui/pull/10116) 已有维护者审阅与持续 CI 反馈 | React 聊天 primitives、runtime adapter、Markdown、工具显示和可选云端状态；完整 runtime 引入额外状态体系。近期问题涉及历史分支选择与保留，迁移时不能把可见消息直接当 SDK 上下文。 | 借鉴其经过验证的 Thread / Composer / ThreadList / ScrollAnchor 交互设计；保留简洁项目范围，SDK 线程和 JSON 历史由一个服务端链路管理，不引入第二套云端 runtime。 |
| [Vercel chatbot](https://github.com/vercel/chatbot) | 检索时最近 push 2026-07-08；GitHub 许可证标识 NOASSERTION | 成品聊天模板，与自身后端和 provider 设计绑定；当前许可证没有直接满足筛选要求。 | 不作为代码来源或实现基础。 |

实际阅读并参考的 UI/UX 源码：

- [assistant-ui Thread](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/pages/docs/assistant/thread.tsx)：独立消息滚动区、空状态引导、固定 composer、用户和助手消息分开渲染。
- [assistant-ui Composer](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/demo/elements/composer.tsx)：输入与工具栏分层、执行中切换为停止操作；本项目不展示未实现的语音和附件按钮。
- [assistant-ui ThreadList](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/demo/elements/thread-list.tsx)：历史选中态、独立删除动作和新会话入口。
- [assistant-ui ScrollAnchor](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/demo/elements/scroll-anchor.tsx)：只在用户位于底部时跟随新输出，上翻阅读时暂停跟随，提供回到底部入口。

这些是设计借鉴，页面和本机 SDK 适配代码按本项目需求自行实现。Markdown 使用成熟的 `react-markdown` / `remark-gfm`，图标使用 `lucide-react`，不自行写 Markdown 解析器、CLI 传输或模型调用协议。UI 配色和排版在聊天应用的通用结构上重新设计，不冒用 ChatGPT 品牌。对应 [官方 Codex SDK 文档](https://developers.openai.com/codex/sdk/) 和 [官方 TypeScript SDK 实现](https://github.com/openai/codex/tree/main/sdk/typescript)。

## 工作链

```text
浏览器发送任务
  → 本机 Route Handler 检查 Host / Origin 和消息大小
  → 对话互斥：保存用户消息与 running 状态
  → 官方 SDK startThread / resumeThread
  → runStreamed(prompt, { signal })
  → CLI JSONL：文本、命令、文件变更、工具、完成或失败
  → NDJSON 流回浏览器，按 item ID 更新同一项
  → 原子保存终态与真实 thread ID
```

新对话不会继承旧线程；继续对话复用服务端保存的 thread ID，不重复拼接历史提示词。刷新后从 JSON 读取可见历史，下一轮使用 SDK 恢复真正的模型上下文。断流、失败、取消会保留已有输出，不能把缺失完成事件当成功。请求断开、点击停止或 30 分钟超时都会触发 SDK AbortSignal；停止不回滚文件操作。每段对话只运行一个任务，删除也使用同一把锁。

本机单进程服务以 globalThis 保存执行锁，避免开发热更新丢失。聊天记录临时文件 + rename 原子落盘，目录权限 0700、文件 0600。应用自身历史和 Codex 原始会话分开管理。重启时仍处于 running 的历史显示为中断，可以继续。

## 安全版本与边界

2026-10-26 查询 npm `latest` 稳定标签并精确锁定：Next.js 16.4.3、React / React DOM 19.3.1、Tailwind 4.3.3、TypeScript 7.0.2、Codex SDK 0.164.0。Node 使用 24.22.1 LTS 安全版；构建工具和测试工具也锁定在完整 package-lock.json。当天对完整 lockfile 的静态 npm audit 返回 **0 个已知漏洞**，最终还要以远端 CI 为准。

核对的上游安全公告：

- [Next.js 2026-10-14 安全更新](https://nextjs.org/blog/nextjs-security-update-october-14-2026)：涉及 use cache RCE、SVG 图片优化相关 CVE-2026-96889 和 Server Actions DoS。公告要求升级到修复版本，本项目采用更高的 16.4.3；锁文件中 sharp 也需保持修复版本。
- [React RSC 后续安全修复](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components)：早期补丁存在不完整情况，不采用旧补丁版本；React 和框架内置的 RSC 实现需要分别关注。
- [Node.js 2026-10-21 安全版本](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)：使用已发布的 24.22.1，覆盖该轮 LTS 安全更新。

供应链措施：只从 npm 官方 registry 按精确 lockfile 和完整性哈希安装，`.npmrc` 禁止依赖生命周期脚本；CI 使用 `npm ci --ignore-scripts`。不执行来历不明的 `npx` 脚本，Playwright 调用已锁定的本地依赖。没有引入 axios 或来源不明的 SDK 包。Dependabot 和 CI 审计继续监测新公告，审计不能替代未知漏洞或包恶意行为检测。

执行本身按用户要求不隔离；本机入口保护仍存在：只绑定 127.0.0.1；API 拒绝外部 Host、跨站 Origin 和跨站 fetch，防止其他网站借用本机 agent。密钥只在服务端读取，不进入 publicConfig 或前端 bundle；错误信息隐藏已配置 API key。Markdown 不渲染原始 HTML，新窗口链接使用 noreferrer/noopener。此应用没有多人认证体系，不支持公网部署或多个 Node 实例。配置的工作目录不是访问范围限制。

## 远端验证

本地仅进行源码阅读、lockfile 生成、依赖审计和差异静态检查，没有安装运行项目依赖、执行测试、启动 Next 或构建。原仓库没有 CI，本次新增 GitHub Actions，远端运行类型检查、单元回归、生产构建和桌面/手机浏览器链路验证。

浏览器测试通过真实 Codex SDK 调用可控的 CLI 测试替身，校验全访问参数、线程恢复、输出协议，并在 CI 临时目录真正写入文件。它验证本程序的接线和界面，不验证真实模型服务。不会借用上级 .env 的 Infisical 密钥，也不把凭据提交到仓库。

验收证据：功能提交 `9dde9ba` 的 [远端运行 40274299202](https://github.com/C0verSnow/PRBOT1/actions/runs/40274299202) 全部通过：32 个单元测试、4 个浏览器测试、类型检查、生产构建、全依赖审计（0 个已知漏洞）。已查看远端生成的桌面首页和手机聊天截图，文件保留在 [screenshots](screenshots/)；运行时主机路径的打包追踪提示和测试配置模块提示已消除。后续提交仅补充文档与这些原始截图。

## 追加的精致交互优化

用户随后要求继续检索 GitHub 并高级化优化交互，选定克制精致的 ChatGPT / Linear 方向。候选比较、许可、维护者响应和已知问题见 [交互研究](interaction-research.md)。直接使用 Motion 14.6.0；欢迎卡片和消息只在首次出现时做短时反馈，流式文本保持稳定 ID；采用原生 dialog 管理快捷搜索与确认操作。新增侧栏收起记忆、按对话保存浏览器草稿、生成时预写下一条、输入自动增高、明确执行状态和阅读优先的浮动回到底部。运行时订阅 matchMedia，系统减少动态效果改变时立即调整 Motion。

远端回归发现并修复两类边界：React 初次聚焦早于 showModal，改为打开后明确聚焦并在卸载时恢复触发点；侧栏收窄加 inert 之外，加入收起后的 visibility:hidden。随后又确认 search 输入框会先处理 Esc，故由弹窗显式关闭，输入法选字期间不拦截。保留原失败断言，没有放宽验证。

功能提交 `980e1ef` 的 [远端运行 40275963030](https://github.com/C0verSnow/PRBOT1/actions/runs/40275963030) 全部成功：34 个单元测试、14 个桌面/手机浏览器测试、类型检查、生产构建、依赖审计（0 个已知漏洞）。已查看最终桌面首页与手机快捷面板，并更新原始截图。没有执行本地编译、开发服务或项目测试；仍未调用真实付费模型。后续提交仅补充文档与原始截图。

# 本文档为4象限的任务清单，全文书写大白话

## 想做：
- [1792991568] 完成 issue #1：用最新稳定版 TypeScript、React、Tailwind、Next.js 和官方 Codex JS SDK 做简洁聊天程序，跑通远端测试、更新文档、提 PR 并关闭 issue。

## 做完：
- [1792992206] 已完成 Next.js / React / Tailwind 聊天界面、官方 SDK 全访问流式链路、会话恢复、本地历史、停止和错误反馈；新增远端 CI 和回归用例。静态 npm audit 检查整个锁文件为 0 个已知漏洞。
- [1792992206] 用户要求重点注意 JavaScript CVE 和参考成熟 UI；已读 Next.js / React / Node 官方安全公告及 assistant-ui 的 Thread、Composer、ThreadList、ScrollAnchor 源码，比较结果与来源写入 docs/design.md。
- [1792991712] 用户确认本机使用、可修改项目文件，并明确要求关闭执行隔离；采用 danger-full-access，服务只监听本机。已查官方 SDK 文档与当前 npm 稳定版，筛选 Codex 和 assistant-ui 并比较许可、近期提交与问题响应。
- [1792991568] 已读取 issue 正文和评论，确认目标仓库只有初始 README；已同步 PRBOT1 并切换到 feature/issue-1-codex-chat 分支。

## 没做：
- [1792991568] 按仓库约定，不进行本地构建、编译或会触发编译的测试；验证交给远端 CI。

## 在做：
- [1792991568] 核对官方 SDK 文档和最新依赖版本，比较活跃开源实现；已向用户确认本机使用与文件修改范围。

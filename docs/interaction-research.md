# 简洁聊天工作台的高级交互研究

研究日期：2026-10-26。用户选择“克制精致，类似 ChatGPT / Linear”：保留阅读与输入的稳定布局，用短促反馈、清楚状态和快捷操作提高质感，不追求大面积玻璃、漂浮粒子或反复打字动画。

本文件把已核实的上游事实和针对 PRBOT 的设计建议分开记录。只查看第一方 GitHub 源码、仓库元数据、问题讨论和官方文档；没有执行本地构建、编译、项目测试或开发服务，没有复制来源不明代码。

## 候选筛选与比较

| 项目 | 维护、许可和响应证据 | 实现与依赖构成 | 已知问题与采用范围 |
| --- | --- | --- | --- |
| [Motion](https://github.com/motiondivision/motion) | [仓库元数据](https://api.github.com/repos/motiondivision/motion) 显示 MIT，最近 push 为 2026-10-26；[PR #3998](https://github.com/motiondivision/motion/pull/3998) 有协作者 mattgperry 在 2026-10-23 回复并调查失败，符合近期维护和问题响应要求。 | [官方 motion 包](https://github.com/motiondivision/motion/blob/main/packages/motion/package.json) 版本 14.6.0，提供 `motion/react` 导出，运行依赖 `framer-motion` 14.6.0、`tslib`；[framer-motion 包](https://github.com/motiondivision/motion/blob/main/packages/framer-motion/package.json) 再依赖 `motion-dom` / `motion-utils` 14.6.0，React peer 支持 18 / 19。 | 直接使用精确版本的 `motion/react`，只做轻量出现、按压和选择反馈。#3998 描述 `style.backgroundColor` + `whileHover.backgroundColor` 在 hover 结束重渲染时可能卡在中间值；检索时 PR 未合并，不能假定稳定版已经包含修复，颜色继续交给 CSS。 |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | [仓库元数据](https://api.github.com/repos/shadcn-ui/ui) 显示 MIT，最近 push 为 2026-10-25；[issue #12147 的人工答复](https://github.com/shadcn-ui/ui/issues/12147#issuecomment-6010436099) 来自协作者 shadcn，时间为 **2026-10-06 06:06:28 UTC**：确认修复 #12148，并说明构建会阻止同类空文件再次进入发布包；[2026-10-05 18:43:38 UTC 的前一答复](https://github.com/shadcn-ui/ui/issues/12147#issuecomment-6000842384) 先给出 beta 请报告者复验。近期提交和人工问题响应均已核实。 | [Command 官方源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/command.tsx) 组合输入框、结果列表、分组、空结果、快捷键提示，底层使用 `cmdk` 和 Dialog；[官方文档](https://ui.shadcn.com/docs/components/command) 说明相同组成。 | 借鉴搜索与动作分组的交互结构，不为现有的小型聊天程序移植整个 registry/runtime。历史 [issue #5924](https://github.com/shadcn-ui/ui/issues/5924) 记录 DialogTitle 可访问名称问题，[issue #6297](https://github.com/shadcn-ui/ui/issues/6297) 记录移动侧栏和下拉层级问题；本项目保留有名称的原生 modal，避免额外叠加两套 portal。 |
| [motion-primitives](https://github.com/ibelick/motion-primitives) | [仓库元数据](https://api.github.com/repos/ibelick/motion-primitives) 显示 MIT，最近 push 为 2026-09-28；但最近安装问题 [#187](https://github.com/ibelick/motion-primitives/issues/187) 只看到社区附议，未核实新的维护者解决；较早 lint 问题 [#184](https://github.com/ibelick/motion-primitives/issues/184) 有贡献者链接修复 PR。 | [AnimatedGroup](https://github.com/ibelick/motion-primitives/blob/main/components/core/animated-group.tsx) 用 `motion/react` 的 container/item variants 和 stagger；[AnimatedBackground](https://github.com/ibelick/motion-primitives/blob/main/components/core/animated-background.tsx) 用 `layoutId` 表示共享选中背景。其[站点 package.json](https://github.com/ibelick/motion-primitives/blob/main/package.json) 还带 MDX、Next 15.5.25、React 18、Motion 11 等整站依赖。 | 未通过本次严格的近期维护者问题响应筛选，不作为运行依赖或代码来源。仅记录其公开视觉方案作为对照；不复制整站、旧依赖或组件代码。 |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | 本仓库先前已完成 MIT 与 2026-10 活跃性核查，详见 [design.md](design.md)。 | 重新读取其 [ScrollAnchor 示例](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/demo/elements/scroll-anchor.tsx)，示例明确区分底部跟随、上翻暂停和跳回最新消息。 | 继续借鉴成熟聊天滚动规则，不增加第二套聊天状态 runtime。 |

`motion` 的 npm 最新稳定标签已在研究当日核对为 **14.6.0**，与 GitHub 官方包版本相同；[npm registry 元数据](https://registry.npmjs.org/motion/latest) 及上述官方 package.json 可复查。`cmdk` 最新标签为 1.1.1，依赖数个 Radix 包；主实现没有必要仅为一个快捷搜索弹窗引入这条额外依赖链。[cmdk registry](https://registry.npmjs.org/cmdk/latest)

## 推荐落地的五项成熟设计

以下时长和尺寸是根据本项目阅读密度提出的设计参数，不是上游强制标准。

1. **消息首次出现与按钮按压。** 使用 Motion 的 opacity + 轻微位移，建议消息 160–220ms、位移不超过 8px；按钮按下缩到约 0.98，悬停仅轻微抬升或边框变化。每条消息使用其固定 ID，新增时动一次，流式文本更新不重新挂载、不重复出现。上游 `AnimatePresence` 依靠直接子项的唯一 key 跟踪离场；key 改变会重建组件，因此不能用整段消息文字当 key。[官方 AnimatePresence 文档](https://motion.dev/docs/react-animate-presence)
2. **欢迎区卡片与状态反馈。** 只对少量引导项做顺序出现；执行中显示清楚的状态标签，完成/失败改变标签和图标，不让整页持续闪烁。用 `AnimatePresence initial={false}` 处理已经存在的历史或提示，避免刷新后重新播放全部历史。[官方 AnimatePresence 类型](https://github.com/motiondivision/motion/blob/main/packages/framer-motion/src/components/AnimatePresence/types.ts)
3. **快捷操作面板。** 借鉴 shadcn 的输入、分组、空结果和快捷键提示，Cmd/Ctrl+K 打开搜索与“新对话”等真实操作。用浏览器原生 `dialog.showModal()` 维持焦点边界和背景 inert，明确标题和关闭按钮，支持 Esc，关闭后恢复触发点。该平台能力已有浏览器提供，无需自行模拟 ARIA modal 或引入第二个浮层系统。[shadcn Command 源码](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/command.tsx)、[原生 dialog 文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog)
4. **稳定的执行时间线。** 命令、文件变更和失败状态以可展开的紧凑记录显示，自动更新同一个 item ID。用户手动折叠后，不要因下一段流事件又强制展开。可对一条新记录做淡入，避免对包含长终端输出的整段高度反复做弹簧动画。这是结合本项目 SDK 事件模型的适配建议；可视模式沿用 assistant-ui 的独立工具区和消息区。[已核实的聊天设计来源](design.md)
5. **阅读优先的自动滚动。** 仅在用户本来位于底部时跟随新内容，上翻后保留位置，出现“回到最新消息”按钮。按钮可淡入，但尽量不改变输入区和阅读区高度。不要给每次增长的 Markdown 段落加 `layout`：Motion 使用 transform（含 scale）模拟尺寸变化，可能导致文字暂时拉伸；滚动容器中的布局动画还需要 `layoutScroll` 才能正确计入偏移。[assistant-ui ScrollAnchor](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/demo/elements/scroll-anchor.tsx)、[Motion layout 官方文档](https://motion.dev/docs/react-layout-animations)

## 减少动态效果与测试注意点

- `MotionConfig reducedMotion="user"` 是全局基础，官方说明它会关闭 transform / layout 动画并保留 opacity、颜色等状态过渡。项目仍需让 CSS 动画、光标闪烁和平滑滚动遵守 `prefers-reduced-motion`。[Motion 可访问性文档](https://motion.dev/docs/react-accessibility)
- `useReducedMotion()` 可用于选择是否启用位移。当前读取到的[官方源码](https://github.com/motiondivision/motion/blob/main/packages/framer-motion/src/utils/reduced-motion/use-reduced-motion.ts) 使用初始缓存值和 `useState`，没有在这个 hook 内订阅之后的偏好变更，并保留相应 TODO；因此不能只按文档描述假定运行中改变系统偏好一定实时生效。需要即时响应时，应用可自行订阅 `matchMedia` 的 change 事件。这一条是根据源码作出的实现判断。
- [MotionConfig 类型](https://github.com/motiondivision/motion/blob/main/packages/framer-motion/src/context/MotionConfigContext.tsx) 提供 `skipAnimations`，可用于需要确定帧的视觉测试；功能测试也应覆盖 reduced-motion 模式。不要靠延长任意 sleep 证明动画完成，应等待交互状态或实际布局条件。
- 远端回归应覆盖快捷键/焦点返回、复制反馈、流式更新不丢草稿、上翻后新消息不抢滚动、手机侧栏关闭以及 reduced-motion。保留桌面与手机的最终截图。此研究过程没有运行这些测试。

## 研究过程记录

以下为整理研究文件时补记的过程，时间戳表示记录写入时间。

- [1792992967] 开始核对现有聊天结构、已完成的设计说明和直接依赖；明确只写研究文件，不修改应用代码。
- [1792992967] 查询 Motion、shadcn/ui、motion-primitives 的 GitHub 元数据、许可、近期条目，实际阅读 Motion 官方动效和可访问性文档。
- [1792992967] 阅读候选组件源码、npm 元数据和维护者讨论；发现 Motion hover 颜色问题，向主代理回传接口与规避建议。
- [1792992967] 进一步核实人工答复与 stale 机器人更新的区别，读取原生 dialog 和滚动布局规则；整理适合本项目的五项落地建议。

- [1792993217] 补查 shadcn/ui 最新 closed issues / PR，区分签名、部署和 stale 机器人；找到 2026-10-05 / 06 协作者 shadcn 在 #12147 的人工复验与修复确认，已用直接评论链接替换旧的 2025 年证据。只补研究文件，没有执行本地编译或测试。

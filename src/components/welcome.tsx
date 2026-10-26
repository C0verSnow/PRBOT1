"use client";
import { m } from "motion/react";
import { ArrowUpRight, Code2, FolderOpen, Terminal } from "lucide-react";
const suggestions = [
  { icon: Code2, title: "了解这个项目", description: "梳理结构，快速找到方向", prompt: "看看当前项目，介绍目录结构、主要功能和启动方式。不要进行本地编译。" },
  { icon: Terminal, title: "一起解决问题", description: "从现象走到解决方案", prompt: "先阅读项目，帮我找出最值得改进的一个问题，并给出修改方案。不要进行本地编译。" },
  { icon: FolderOpen, title: "开始一个新功能", description: "把一个想法，变成代码", prompt: "我想给当前项目加一个新功能。请先了解项目，再和我确认需求。不要进行本地编译。" },
];
export function Welcome({ blocked, workspace, choose }: { blocked: boolean; workspace?: string; choose: (prompt: string) => void }) {
  return <m.div className="welcome" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
    <div className="welcome-kicker"><span />YOUR LOCAL CODING COMPANION</div>
    <h1>想法，从这里开始<span>。</span></h1>
    <p>聊聊你的项目，让 Codex 和你一起把它做好。</p>
    <div className="suggestions">{suggestions.map((s, index) => <m.button key={s.title} disabled={blocked}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.035, duration: 0.2 }}
      whileHover={blocked ? undefined : { y: -3 }} whileTap={blocked ? undefined : { scale: 0.985 }} onClick={() => choose(s.prompt)}>
      <span className="suggestion-icon"><s.icon size={18} /></span><span className="suggestion-title">{s.title}</span><ArrowUpRight size={15} /><small>{s.description}</small>
    </m.button>)}</div>
    <div className="welcome-workspace"><FolderOpen size={13} /><span>{workspace?.split(/[\\/]/).filter(Boolean).pop() || "正在连接工作空间"}</span><span className="subtle-dot">·</span><span>本地工作空间</span></div>
  </m.div>;
}

"use client";
import { useState } from "react";
import { ArrowUpRight, FolderOpen, MessageSquare, Plus, Search } from "lucide-react";
import type { ChatSummary } from "@/lib/types";
import { DialogFrame } from "./dialog-frame";
export function QuickSwitcher({ chats, blocked, close, openChat, newChat, settings }: {
  chats: ChatSummary[]; blocked: boolean; close: () => void;
  openChat: (id: string) => void; newChat: () => void; settings: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = chats.filter(c => c.title.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
  function choose(action: () => void) { close(); action(); }
  return <DialogFrame title="快速切换" close={close} className="quick-switcher">
    <label className="switcher-search"><Search size={18} /><input autoFocus type="search" aria-label="搜索历史或操作" placeholder="搜索对话，或开始新任务…" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="switcher-results">
      {!query && <div className="switcher-group"><span>快捷操作</span>
        <button disabled={blocked} onClick={() => choose(newChat)}><Plus size={16} /><span>新对话</span><kbd>⌘ ⇧ O</kbd></button>
        <button onClick={() => choose(settings)}><FolderOpen size={16} /><span>工作空间设置</span><ArrowUpRight size={14} /></button>
      </div>}
      <div className="switcher-group"><span>最近对话</span>{filtered.map(c => <button key={c.id} disabled={blocked} onClick={() => choose(() => openChat(c.id))}><MessageSquare size={16} /><span>{c.title}</span><ArrowUpRight size={14} /></button>)}</div>
      {filtered.length === 0 && <p className="switcher-empty">{query ? "没有找到相关对话，换个关键词试试。" : "还没有历史记录，开始一段新对话吧。"}</p>}
    </div>
    <div className="switcher-footer"><span><kbd>Tab</kbd> 切换操作 <kbd>Enter</kbd> 选择</span><span><kbd>Esc</kbd> 关闭</span></div>
  </DialogFrame>;
}

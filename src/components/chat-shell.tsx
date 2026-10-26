"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Code2, FolderOpen, LoaderCircle, Menu, MessageSquare, Plus, Search, Settings2, ShieldOff, Square, Terminal, Trash2, X } from "lucide-react";
import { consumeStream } from "@/lib/stream";
import type { Chat, ChatSummary, PublicConfig } from "@/lib/types";
import { MessageView } from "./message-view";
import { WorkspaceSettings } from "./workspace-settings";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || "请求失败，请稍后重试。");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
const suggestions = [
  { icon: Code2, title: "了解这个项目", prompt: "看看当前项目，介绍目录结构、主要功能和启动方式。不要进行本地编译。" },
  { icon: Terminal, title: "一起解决问题", prompt: "先阅读项目，帮我找出最值得改进的一个问题，并给出修改方案。不要进行本地编译。" },
  { icon: FolderOpen, title: "开始一个新功能", prompt: "我想给当前项目加一个新功能。请先了解项目，再和我确认需求。不要进行本地编译。" },
];

export function ChatShell() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const transport = useRef<AbortController | null>(null);
  const running = chat?.messages.some(m => m.status === "running") ?? false;
  const busy = sending || running;
  const blocked = busy || loading;
  const refresh = useCallback(async () => {
    const list = await api<ChatSummary[]>("/api/chats");
    if (mounted.current) setChats(list);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    Promise.all([api<PublicConfig>("/api/config", { signal: controller.signal }), api<ChatSummary[]>("/api/chats", { signal: controller.signal })])
      .then(([cfg, list]) => { if (mounted.current) { setConfig(cfg); setChats(list); } })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); transport.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!running || sending || !chat) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      api<Chat>(`/api/chats/${chat.id}`, { signal: controller.signal }).then(setChat)
        .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    }, 1200);
    return () => { clearInterval(timer); controller.abort(); };
  }, [chat?.id, running, sending]);

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight });
  }, [chat]);

  async function load(id: string) {
    if (blocked) return;
    setLoading(true); setError("");
    try { const value = await api<Chat>(`/api/chats/${id}`); follow.current = true; setAwayFromBottom(false); setChat(value); setDraft(""); setSidebar(false); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  function newChat() {
    if (blocked) return;
    setChat(null); setAwayFromBottom(false); setDraft(""); setError(""); setSidebar(false); follow.current = true; input.current?.focus();
  }
  async function remove(id: string) {
    if (blocked || !window.confirm("删除这段聊天记录？已修改的项目文件会保留。")) return;
    setLoading(true);
    try { await api(`/api/chats/${id}`, { method: "DELETE" }); if (chat?.id === id) setChat(null); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  async function send() {
    const prompt = draft.trim();
    if (!prompt || blocked || submitting.current) return;
    submitting.current = true; setSending(true); setError(""); follow.current = true;
    let current = chat; let accepted = false;
    const controller = new AbortController(); transport.current = controller;
    try {
      if (!current) { current = await api<Chat>("/api/chats", { method: "POST", signal: controller.signal }); setChat(current); }
      const response = await fetch(`/api/chats/${current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }), signal: controller.signal });
      await consumeStream(response, event => {
        if (event.type === "error") throw new Error(event.message);
        accepted = true; setDraft(""); setChat(event.chat); current = event.chat;
      });
      if (current.messages.some(m => m.status === "running")) throw new Error("连接中断，请稍后重新打开这段对话查看执行结果。");
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) {
        setError((e as Error).message);
        if (!accepted) setDraft(prompt);
        if (current) await api<Chat>(`/api/chats/${current.id}`).then(setChat).catch(() => {});
      }
    } finally {
      submitting.current = false; transport.current = null;
      if (mounted.current) { setSending(false); setStopping(false); await refresh().catch(e => setError((e as Error).message)); }
    }
  }
  async function stop() {
    if (!chat || stopping) return;
    setStopping(true);
    try { await api(`/api/chats/${chat.id}/stop`, { method: "POST" }); }
    catch (e) { setError((e as Error).message); }
    finally { setStopping(false); }
  }
  const visible = chats.filter(c => c.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`}>
      <div className="sidebar-brand"><span className="brand-mark">✳</span><span>PRBOT<span className="brand-dot">.</span></span><button className="icon-button mobile-only" aria-label="关闭侧栏" onClick={() => setSidebar(false)}><X size={18} /></button></div>
      <button className="new-chat" disabled={blocked} onClick={newChat}><Plus size={18} />新对话</button>
      <label className="search"><Search size={15} /><input aria-label="搜索对话" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索对话" /></label>
      <div className="history-heading">你的对话 <span>{chats.length}</span></div>
      <nav className="history" aria-label="对话历史">
        {visible.map(c => <div key={c.id} className={`history-row ${chat?.id === c.id ? "selected" : ""}`}>
          <button disabled={blocked} onClick={() => load(c.id)}><MessageSquare size={15} /><span>{c.title}</span></button>
          <button className="delete-chat" disabled={blocked} aria-label={`删除 ${c.title}`} onClick={() => remove(c.id)}><Trash2 size={13} /></button>
        </div>)}
        {!loading && visible.length === 0 && <p className="empty-history">{search ? "没有找到相关对话" : "从一个想法开始，\n每次对话都会保存在这里。"}</p>}
      </nav>
      <div className="sidebar-bottom"><div className="local-card"><span className="connection-dot" /><div>在你的电脑上运行<small>本地记录 · 直接操作项目</small></div></div><button className="profile" onClick={() => setSettings(true)}><span className="profile-avatar">你</span><div>个人工作空间<small>Codex SDK</small></div><Settings2 size={16} /></button></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="topbar-title"><button className="icon-button mobile-only" onClick={() => setSidebar(true)} aria-label="打开侧栏"><Menu size={20} /></button><span>Codex</span><span className="sdk-badge">SDK</span></div><button className="access-badge" onClick={() => setSettings(true)}><ShieldOff size={13} /><span>完全访问</span><span className="connection-dot" /></button></header>
      <div className="chat-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; setAwayFromBottom(!follow.current); } }}>
        {chat?.messages.length ? <div className="conversation">{chat.messages.map(m => <MessageView key={m.id} message={m} />)}</div> : <div className="welcome">
          <div className="welcome-kicker"><span />YOUR LOCAL CODING COMPANION</div>
          <h1>想法，从这里开始<span>。</span></h1><p>聊聊你的项目，让 Codex 和你一起把它做好。</p>
          <div className="suggestions">{suggestions.map(s => <button key={s.title} disabled={blocked} onClick={() => { setDraft(s.prompt); input.current?.focus(); }}><s.icon size={20} /><span>{s.title}</span><ArrowUpRight size={15} /></button>)}</div>
          <div className="welcome-workspace"><FolderOpen size={14} /><span>{config?.workspace.split(/[\\/]/).filter(Boolean).pop() || "正在连接工作空间"}</span><span className="subtle-dot">·</span><span>本地工作空间</span></div>
        </div>}
      </div>
      <div className="composer-area">
        {awayFromBottom && chat && <button className="jump-to-bottom" onClick={() => { follow.current = true; setAwayFromBottom(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={13} />回到最新消息</button>}
        {error && <div className="app-error" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><X size={15} /></button></div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          <textarea ref={input} aria-label="发送给 Codex 的消息" placeholder="描述任务，或问 Codex 任何问题…" value={draft} maxLength={16000} disabled={blocked} rows={2} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="composer-toolbar"><button type="button" className="workspace-button" onClick={() => setSettings(true)}><FolderOpen size={15} /><span>工作空间</span></button><span className="model-name">{config?.model || "Codex"}</span>{busy ? <button type="button" className="send-button stop-button" aria-label="停止生成" disabled={stopping || !chat} onClick={stop}>{stopping ? <LoaderCircle size={16} className="spin" /> : <Square size={14} fill="currentColor" />}</button> : <button type="submit" className="send-button" aria-label="发送消息" disabled={loading || !draft.trim()}><ArrowUp size={19} /></button>}</div>
        </form>
        <p className="composer-note">Codex 可直接执行命令和修改本机文件。请检查执行结果。<span>Enter 发送 · Shift + Enter 换行</span></p>
      </div>
    </main>
    {settings && <WorkspaceSettings config={config} close={() => setSettings(false)} />}
  </div>;
}

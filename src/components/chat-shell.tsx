"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowDown, ArrowUp, Check, FolderOpen, LoaderCircle, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, ShieldOff, Square, Trash2, X } from "lucide-react";
import { consumeStream } from "@/lib/stream";
import { readDraft, writeDraft } from "@/lib/drafts";
import type { Chat, ChatSummary, PublicConfig } from "@/lib/types";
import { MessageView } from "./message-view";
import { WorkspaceSettings } from "./workspace-settings";
import { QuickSwitcher } from "./quick-switcher";
import { Welcome } from "./welcome";
import { DialogFrame } from "./dialog-frame";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || "请求失败，请稍后重试。");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export function ChatShell() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [draftStored, setDraftStored] = useState(true);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [deleting, setDeleting] = useState<ChatSummary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stopping, setStopping] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const transport = useRef<AbortController | null>(null);
  const running = chat?.messages.some(message => message.status === "running") ?? false;
  const busy = sending || running;
  const blocked = busy || loading;
  const chatId = chat?.id ?? null;
  const refresh = useCallback(async () => {
    const list = await api<ChatSummary[]>("/api/chats");
    if (mounted.current) setChats(list);
  }, []);
  function updateDraft(value: string) { setDraft(value); setDraftStored(writeDraft(chatId, value)); }
  function focusInput() { requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); }
  const newChat = useCallback(() => {
    if (blocked) return;
    setChat(null); setDraft(readDraft(null)); setAwayFromBottom(false);
    setError(""); setSidebar(false); follow.current = true;
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  }, [blocked]);

  useEffect(() => {
    mounted.current = true;
    setDraft(readDraft(null));
    try { setCollapsed(localStorage.getItem("prbot:sidebar:v1") === "closed"); } catch { /* optional preference */ }
    const controller = new AbortController();
    Promise.all([api<PublicConfig>("/api/config", { signal: controller.signal }), api<ChatSummary[]>("/api/chats", { signal: controller.signal })])
      .then(([cfg, list]) => { if (mounted.current) { setConfig(cfg); setChats(list); } })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); transport.current?.abort(); };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const change = () => setMobile(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        if (document.querySelector("dialog[open]") && !switcher) return;
        event.preventDefault(); setSwitcher(value => !value);
      }
      if (event.shiftKey && event.key.toLowerCase() === "o" && !document.querySelector("dialog[open]")) {
        event.preventDefault(); newChat();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [newChat, switcher]);

  useEffect(() => {
    if (!running || sending || !chatId) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      api<Chat>(`/api/chats/${chatId}`, { signal: controller.signal }).then(setChat)
        .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    }, 1200);
    return () => { clearInterval(timer); controller.abort(); };
  }, [chatId, running, sending]);

  useEffect(() => {
    const textarea = input.current;
    if (textarea) { textarea.style.height = "0px"; textarea.style.height = `${Math.min(180, Math.max(46, textarea.scrollHeight))}px`; }
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [draft, chat]);

  useEffect(() => {
    // Mature chat pattern: only follow resizes while already pinned to the bottom.
    const viewport = scroll.current;
    const messages = content.current;
    if (!viewport || !messages) return;
    const observer = new ResizeObserver(() => { if (follow.current) viewport.scrollTop = viewport.scrollHeight; });
    observer.observe(viewport); observer.observe(messages);
    return () => observer.disconnect();
  }, [chatId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  function toggleSidebar() {
    setCollapsed(value => {
      try { localStorage.setItem("prbot:sidebar:v1", value ? "open" : "closed"); } catch { /* optional preference */ }
      return !value;
    });
  }
  async function load(id: string) {
    if (blocked) return;
    setLoading(true); setError("");
    try {
      const value = await api<Chat>(`/api/chats/${id}`);
      follow.current = true; setAwayFromBottom(false); setChat(value); setDraft(readDraft(id)); setSidebar(false);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  async function remove() {
    if (blocked || !deleting) return;
    const target = deleting;
    setLoading(true);
    try {
      await api(`/api/chats/${target.id}`, { method: "DELETE" });
      writeDraft(target.id, "");
      if (chatId === target.id) { setChat(null); setDraft(readDraft(null)); }
      await refresh(); setDeleting(null); setNotice("对话记录已删除");
    } catch (e) { setError((e as Error).message); setDeleting(null); }
    finally { setLoading(false); }
  }
  async function send() {
    const prompt = draft.trim();
    if (!prompt || blocked || submitting.current) return;
    submitting.current = true; setSending(true); setStarting(true); setError(""); follow.current = true;
    let current = chat; let accepted = false;
    const controller = new AbortController(); transport.current = controller;
    try {
      if (!current) { current = await api<Chat>("/api/chats", { method: "POST", signal: controller.signal }); setChat(current); }
      const response = await fetch(`/api/chats/${current.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }), signal: controller.signal });
      await consumeStream(response, event => {
        if (event.type === "error") throw new Error(event.message);
        if (!accepted) {
          accepted = true; setDraft(""); writeDraft(chatId, ""); writeDraft(event.chat.id, ""); setStarting(false);
        }
        setChat(event.chat); current = event.chat;
      });
      if (current.messages.some(message => message.status === "running")) throw new Error("连接中断，请稍后重新打开这段对话查看执行结果。");
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) {
        setError((e as Error).message);
        if (!accepted) { setDraft(prompt); writeDraft(current?.id ?? chatId, prompt); }
        if (current) await api<Chat>(`/api/chats/${current.id}`).then(setChat).catch(() => {});
      }
    } finally {
      submitting.current = false; transport.current = null;
      if (mounted.current) {
        setSending(false); setStarting(false); setStopping(false);
        await refresh().catch(e => setError((e as Error).message));
      }
    }
  }
  async function stop() {
    if (!chat || stopping) return;
    setStopping(true);
    try { await api(`/api/chats/${chat.id}/stop`, { method: "POST" }); }
    catch (e) { setError((e as Error).message); setStopping(false); }
  }
  const visible = chats.filter(c => c.title.toLowerCase().includes(search.toLowerCase()));
  const folderName = config?.workspace.split(/[\\/]/).filter(Boolean).pop();
  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} inert={mobile ? !sidebar : collapsed}>
      <div className="sidebar-brand"><span className="brand-mark"><img src="/prbot.svg" alt="" width={27} height={27} /></span><span>PRBOT<span className="brand-dot">.</span></span>
        <button className="icon-button desktop-only" aria-label="收起侧栏" onClick={toggleSidebar}><PanelLeftClose size={16} /></button>
        <button className="icon-button mobile-only" aria-label="关闭侧栏" onClick={() => setSidebar(false)}><X size={18} /></button>
      </div>
      <m.button className="new-chat" disabled={blocked} whileTap={{ scale: 0.98 }} onClick={newChat}><Plus size={17} />新对话<kbd>⌘ ⇧ O</kbd></m.button>
      <button className="quick-trigger" onClick={() => setSwitcher(true)}><Search size={15} /><span>快速切换</span><kbd>⌘ K</kbd></button>
      <label className="search"><Search size={14} /><input aria-label="搜索对话" value={search} onChange={e => setSearch(e.target.value)} placeholder="筛选对话" />{search && <button aria-label="清除搜索" onClick={() => setSearch("")}><X size={12} /></button>}</label>
      <div className="history-heading">你的对话<span>{chats.length}</span></div>
      <nav className="history" aria-label="对话历史">
        {visible.map(c => <div key={c.id} className={`history-row ${chatId === c.id ? "selected" : ""}`}>
          <button disabled={blocked} aria-current={chatId === c.id ? "page" : undefined} onClick={() => load(c.id)}><MessageSquare size={14} /><span>{c.title}</span></button>
          <button className="delete-chat" disabled={blocked} aria-label={`删除 ${c.title}`} onClick={() => setDeleting(c)}><Trash2 size={13} /></button>
        </div>)}
        {!loading && visible.length === 0 && <p className="empty-history">{search ? "没有找到相关对话" : "从一个想法开始，\n每次对话都会保存在这里。"}</p>}
      </nav>
      <div className="sidebar-bottom"><div className="local-card"><span className="connection-dot" /><div>在你的电脑上运行<small>本地记录 · 直接操作项目</small></div></div><button className="profile" onClick={() => setSettings(true)}><span className="profile-avatar">你</span><div>个人工作空间<small>Codex SDK</small></div><Settings2 size={15} /></button></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="topbar-title">
        <button className="icon-button mobile-only" onClick={() => setSidebar(true)} aria-label="打开侧栏"><Menu size={20} /></button>
        {collapsed && <button className="icon-button desktop-only" onClick={toggleSidebar} aria-label="展开侧栏"><PanelLeftOpen size={18} /></button>}
        <span>Codex</span><span className="sdk-badge">SDK</span><span className="header-divider" /><span className="header-context">{chat?.messages.length ? chat.title : folderName || "工作空间"}</span>
      </div><div className="header-actions"><button className="icon-button header-search" aria-label="快速切换" title="快速切换 · ⌘ / Ctrl K" onClick={() => setSwitcher(true)}><Search size={16} /></button><button className="access-badge" onClick={() => setSettings(true)}><ShieldOff size={12} /><span>完全访问</span><span className="connection-dot" /></button></div></header>
      <div className="chat-scroll" ref={scroll} onScroll={() => {
        const element = scroll.current;
        if (element) { follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; setAwayFromBottom(!follow.current); }
      }}>
        <div className="chat-content" ref={content}>
          {chat?.messages.length ? <div className="conversation">{chat.messages.map(message => <MessageView key={message.id} message={message} />)}</div>
            : <Welcome blocked={blocked} workspace={config?.workspace} choose={prompt => { updateDraft(prompt); focusInput(); }} />}
        </div>
      </div>
      <div className="composer-area">
        <div className="composer-floating"><AnimatePresence initial={false}>
          {awayFromBottom && chat && <m.button key="jump" className="jump-to-bottom" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} onClick={() => { follow.current = true; setAwayFromBottom(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={13} />回到最新消息</m.button>}
        </AnimatePresence></div>
        <AnimatePresence initial={false}>{error && <m.div key="error" className="app-error" role="alert" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><X size={15} /></button></m.div>}</AnimatePresence>
        <form className={`composer ${busy ? "is-running" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}>
          <textarea ref={input} aria-label="发送给 Codex 的消息" placeholder={busy ? "可以先写下一条，当前任务结束后发送…" : "描述任务，或问 Codex 任何问题…"} value={draft} maxLength={16000} disabled={loading || starting} rows={1} onChange={event => updateDraft(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
          <div className="composer-toolbar"><button type="button" className="workspace-button" onClick={() => setSettings(true)} title={config?.workspace}><FolderOpen size={14} /><span>{folderName || "工作空间"}</span></button>
            <span className="composer-state" role="status">{starting ? "正在连接" : busy ? <><span className="working-dot" />{stopping ? "正在停止…" : "正在执行"}</> : draft ? (draftStored ? "草稿已保存在浏览器" : "草稿暂存在输入框") : "准备就绪"}</span>
            <span className="model-name">{draft.length > 15000 ? `${draft.length} / 16000` : config?.model || "Codex"}</span>
            {busy ? <m.button type="button" key="stop" className="send-button stop-button" aria-label="停止生成" disabled={stopping || !chat} whileTap={{ scale: 0.9 }} onClick={stop}>{stopping ? <LoaderCircle size={15} className="spin" /> : <Square size={13} fill="currentColor" />}</m.button>
              : <m.button type="submit" key="send" className="send-button" aria-label="发送消息" disabled={loading || !draft.trim()} whileTap={{ scale: 0.9 }}><ArrowUp size={18} /></m.button>}
          </div>
        </form>
        <p className="composer-note">Codex 可直接执行命令和修改本机文件。请检查执行结果。<span><kbd>↵</kbd> 发送 <kbd>⇧ ↵</kbd> 换行</span></p>
      </div>
    </main>
    <AnimatePresence>{notice && <m.div className="toast" key={notice} role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}><Check size={15} />{notice}</m.div>}</AnimatePresence>
    {settings && <WorkspaceSettings config={config} blocked={blocked} close={() => setSettings(false)} saved={value => { setConfig(value); setNotice("设置已保存，下次启动自动恢复"); if (value.workspace !== config?.workspace) newChat(); }} />}
    {switcher && <QuickSwitcher chats={chats} blocked={blocked} close={() => setSwitcher(false)} openChat={id => void load(id)} newChat={newChat} settings={() => setSettings(true)} />}
    {deleting && <DialogFrame title="删除这段对话？" close={() => { if (!loading) setDeleting(null); }} className="delete-dialog"><p className="delete-description">“{deleting.title}”的聊天记录将被删除。已经修改的项目文件会保留。</p><div className="dialog-actions"><button disabled={loading} onClick={() => setDeleting(null)}>保留对话</button><button className="destructive-button" disabled={loading} onClick={() => void remove()}>{loading ? "正在删除…" : "删除记录"}</button></div></DialogFrame>}
  </div>;
}

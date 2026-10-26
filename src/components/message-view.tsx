"use client";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Terminal, ChevronDown, FileCode2 } from "lucide-react";
import type { Message } from "@/lib/types";

export function MessageView({ message }: { message: Message }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(message.text); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setCopyError(true); }
  }
  if (message.role === "user") return <article className="user-row"><div className="user-bubble">{message.text}</div></article>;
  return <article className="assistant-row" aria-label="Codex 回复">
    <div className="agent-avatar" aria-hidden="true">✳</div>
    <div className="assistant-content">
      <div className="message-author">Codex <span>工作伙伴</span></div>
      {message.activities.length > 0 && <details className="activity-list" open={message.status === "running"}>
        <summary><Terminal size={14} />执行过程 · {message.activities.length} 项<ChevronDown size={14} /></summary>
        {message.activities.map(a => <details key={a.id} className="activity">
          <summary>{a.kind === "file_change" ? <FileCode2 size={14} /> : <Terminal size={14} />}<span>{a.title}</span><small>{a.status === "failed" ? "失败" : a.status === "in_progress" ? "执行中" : "已记录"}</small></summary>
          {a.detail && <pre>{a.detail}</pre>}
        </details>)}
      </details>}
      {message.text ? <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{message.text}</Markdown></div>
        : message.status === "running" && <div className="thinking" role="status"><span />正在处理你的请求…</div>}
      {message.error && <p className={message.status === "failed" ? "message-error" : "message-note"} role="status">{message.error}</p>}
      {message.status !== "running" && message.text && <div className="message-actions">
        <button className="icon-button" onClick={copy} aria-label="复制回复">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        {copied && <span role="status">已复制</span>}{copyError && <span role="status">复制失败，请手动选择文字。</span>}
        {message.usage && <span>{message.usage.input_tokens.toLocaleString()} 输入 / {message.usage.output_tokens.toLocaleString()} 输出 tokens</span>}
      </div>}
    </div>
  </article>;
}

"use client";
import { useEffect, useRef } from "react";
import { ShieldOff, X } from "lucide-react";
import type { PublicConfig } from "@/lib/types";
export function WorkspaceSettings({ config, close }: { config: PublicConfig | null; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="settings-modal" aria-labelledby="settings-title" onCancel={close} onClick={e => { if (e.target === ref.current) close(); }}>
    <div className="settings-header"><h2 id="settings-title">工作空间</h2><button autoFocus className="icon-button" aria-label="关闭设置" onClick={close}><X size={19} /></button></div>
    <div className="settings-item"><span>项目目录</span><code>{config?.workspace || "未连接，请检查 CODEX_WORKSPACE 配置"}</code></div>
    <div className="settings-item"><span>当前模型</span><p>{config?.model || "Codex 默认模型"}</p></div>
    <div className="settings-access"><ShieldOff size={18} /><div><strong>完全访问 · 无执行隔离</strong><p>Codex 可以直接读写本机文件、执行命令和访问网络。停止任务不会撤销已经完成的操作。</p></div></div>
    <p className="settings-help">修改项目目录或模型：编辑服务端 .env.local 中的 CODEX_WORKSPACE / CODEX_MODEL，然后重启程序。登录方式和密钥只在本机配置。</p>
    <a href="https://developers.openai.com/codex/sdk/" target="_blank" rel="noreferrer">Codex SDK 官方文档 ↗</a>
  </dialog>;
}

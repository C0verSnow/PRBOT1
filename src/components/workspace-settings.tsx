"use client";
import { useEffect, useState } from "react";
import { ShieldOff, FolderOpen, RefreshCw } from "lucide-react";
import type { PublicConfig, CodexModel } from "@/lib/types";
import { DialogFrame } from "./dialog-frame";
export function WorkspaceSettings({ config, close, saved, blocked }: { config: PublicConfig | null; close: () => void; saved: (config: PublicConfig) => void; blocked: boolean }) {
  const [workspace, setWorkspace] = useState(config?.workspace || "");
  const [model, setModel] = useState(config?.modelId || "");
  const [codexPath, setCodexPath] = useState(config?.codexPath || "");
  const [codexHome, setCodexHome] = useState(config?.codexHome || "");
  const [models, setModels] = useState<CodexModel[]>([]);
  const [modelError, setModelError] = useState("");
  const [error, setError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [desktop, setDesktop] = useState(false);
  async function refresh(signal?: AbortSignal) {
    setLoadingModels(true); setModelError("");
    try {
      const response = await fetch("/api/models", { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取模型失败");
      setModels(data.models);
    } catch (e) { if (!signal?.aborted) setModelError((e as Error).message); }
    finally { if (!signal?.aborted) setLoadingModels(false); }
  }
  useEffect(() => {
    setDesktop(!!window.prbotDesktop);
    const controller = new AbortController(); void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  async function choose() {
    setChoosing(true); setError("");
    try { const value = await window.prbotDesktop?.chooseWorkspace(); if (value) setWorkspace(value); }
    catch { setError("目录选择失败，请重试或填写绝对路径"); }
    finally { setChoosing(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace, model, codexPath, codexHome }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "设置保存失败");
      saved(data); close();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  const disabled = blocked || saving || choosing;
  const changedRuntime = workspace !== config?.workspace || codexPath !== config?.codexPath || codexHome !== config?.codexHome;
  return <DialogFrame title="工作空间" close={() => { if (!saving) close(); }} className="workspace-dialog">
    <form onSubmit={save} className="settings-form">
      <label className="settings-item"><span>项目目录</span><div className="settings-path"><input aria-label="项目目录" value={workspace} disabled={disabled} onChange={e => setWorkspace(e.target.value)} placeholder="项目的绝对路径" />{desktop && <button type="button" disabled={disabled} onClick={() => void choose()}><FolderOpen size={14} />选择目录</button>}</div></label>
      {!!config?.recentWorkspaces.length && <label className="settings-item"><span>最近项目</span><select aria-label="最近项目" disabled={disabled} value="" onChange={e => setWorkspace(e.target.value)}><option value="">选择用过的项目…</option>{config.recentWorkspaces.map(p => <option key={p} value={p}>{p}</option>)}</select></label>}
      <label className="settings-item"><span>当前模型</span><div className="settings-path"><select aria-label="当前模型" value={model} disabled={disabled || loadingModels || !!modelError || changedRuntime} onChange={e => setModel(e.target.value)}><option value="">Codex 默认模型</option>{model && !models.some(m => m.id === model) && <option value={model}>{model}（请刷新确认）</option>}{models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? " · 推荐" : ""}</option>)}</select><button type="button" disabled={loadingModels || saving || changedRuntime} onClick={() => void refresh()}><RefreshCw size={14} />{loadingModels ? "读取中" : "刷新模型"}</button></div></label>
      {modelError && <p role="alert" className="settings-error">{modelError}</p>}
      <details><summary>Codex 运行设置</summary><label className="settings-item"><span>Codex 程序（留空使用内置版本）</span><input aria-label="Codex 程序" value={codexPath} disabled={disabled} onChange={e => setCodexPath(e.target.value)} placeholder="可执行文件绝对路径" /></label><label className="settings-item"><span>Codex 配置目录（留空使用当前用户默认值）</span><input aria-label="Codex 配置目录" value={codexHome} disabled={disabled} onChange={e => setCodexHome(e.target.value)} placeholder="已存在的 CODEX_HOME 绝对路径" /></label></details>
      {changedRuntime && <p className="settings-help">目录或 Codex 设置已改变。先选择“Codex 默认模型”并保存，再刷新新环境的模型列表。</p>}
      {changedRuntime && model && <button type="button" onClick={() => setModel("")} disabled={disabled}>使用 Codex 默认模型</button>}
      <div className="settings-access"><ShieldOff size={18} /><div><strong>完全访问 · 无执行隔离</strong><p>Codex 可以直接读写本机文件、执行命令和访问网络。停止任务不会撤销已经完成的操作。</p></div></div>
      <p className="settings-help">设置保存在本机，下次启动自动恢复。运行中的任务结束后才能修改；项目切换后请新建对话，模型切换从下一条消息生效。密钥只从环境或项目 .env 读取。模型目录不代表账户一定有调用权限，权限错误会在对话中提示。</p>
      {blocked && <p role="status">请先停止或等待当前任务完成，再保存设置。</p>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={saving} onClick={close}>取消</button><button type="submit" disabled={disabled}>{saving ? "正在保存…" : "保存设置"}</button></div>
    </form>
  </DialogFrame>;
}

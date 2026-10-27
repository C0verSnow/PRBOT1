"use client";
import { useEffect, useState } from "react";
import { ShieldOff, FolderOpen, RefreshCw } from "lucide-react";
import type { PublicConfig, CodexModel } from "@/lib/types";
import { DialogFrame } from "./dialog-frame";
export function WorkspaceSettings({ config, close, saved, blocked }: { config: PublicConfig | null; close: () => void; saved: (config: PublicConfig) => void; blocked: boolean }) {
  const [category, setCategory] = useState<"workspace" | "codex" | "telegram" | "infisical">("workspace");
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeStatus, setRuntimeStatus] = useState("");
  const [workspace, setWorkspace] = useState(config?.workspace || "");
  const [model, setModel] = useState(config?.modelId || "");
  const [effort, setEffort] = useState(config?.effort || "");
  const [speed, setSpeed] = useState(config?.speed || "");
  const [codexPath, setCodexPath] = useState(config?.codexPath || "");
  const [codexHome, setCodexHome] = useState(config?.codexHome || "");
  const [tg, setTg] = useState({ projectId: "", clientId: "", clientSecret: "", environment: "prod", allowedUsers: "", enabled: false, hasClientSecret: false });
  const [tgError, setTgError] = useState("");
  const [tgStatus, setTgStatus] = useState("");
  const [tgSaving, setTgSaving] = useState(false);
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
    fetch("/api/telegram/settings").then(async response => {
      if (!response.ok) throw new Error("读取 Telegram 设置失败");
      const value = await response.json(); setTg({ ...value, clientSecret: "" });
    }).catch(() => setTgError("读取 Telegram 设置失败"));
    const controller = new AbortController(); void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  async function choose() {
    setChoosing(true); setError("");
    try { const value = await window.prbotDesktop?.chooseWorkspace(); if (value) setWorkspace(value); }
    catch { setError("目录选择失败，请重试或填写绝对路径"); }
    finally { setChoosing(false); }
  }
  const runtimeDirty = !!config && (model !== config.modelId || effort !== config.effort || speed !== config.speed || codexPath !== config.codexPath || codexHome !== config.codexHome);
  async function saveRuntime() {
    if (!runtimeDirty || blocked || saving) return false;
    setSaving(true); setRuntimeError(""); setRuntimeStatus("正在保存…");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, effort, speed, codexPath, codexHome }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "设置保存失败");
      const environmentChanged = codexPath !== config?.codexPath || codexHome !== config?.codexHome;
      setCodexPath(data.codexPath); setCodexHome(data.codexHome); saved(data); setRuntimeStatus("Codex 设置已自动保存");
      if (environmentChanged) void refresh();
      return true;
    } catch (e) { setRuntimeError((e as Error).message); setRuntimeStatus(""); return false; }
    finally { setSaving(false); }
  }
  useEffect(() => {
    if (!runtimeDirty || blocked || saving || runtimeError) return;
    const timer = window.setTimeout(() => void saveRuntime(), 700);
    return () => window.clearTimeout(timer);
  // The pending snapshot is rescheduled whenever an editable value changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, effort, speed, codexPath, codexHome, config, blocked, saving, runtimeError]);
  async function requestClose() {
    if (saving) return;
    if (runtimeDirty && !runtimeError && !blocked && !(await saveRuntime())) return;
    close();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace, ...(workspace !== config?.workspace ? { model: "", effort: "", speed: "" } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "设置保存失败");
      saved(data); close();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  async function saveTelegram() {
    setTgSaving(true); setTgError(""); setTgStatus("");
    try {
      const { hasClientSecret: _hasClientSecret, ...input } = tg;
      const response = await fetch("/api/telegram/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Telegram 设置保存失败");
      setTg({ ...data, clientSecret: "" }); setTgStatus("Telegram 设置已保存");
    } catch (e) { setTgError((e as Error).message); }
    finally { setTgSaving(false); }
  }
  const selectedModel = model ? models.find(m => m.id === model) : models.find(m => m.isDefault);
  const disabled = blocked || saving || choosing;
  const changedRuntime = codexPath !== config?.codexPath || codexHome !== config?.codexHome;
  return <DialogFrame title="设置" close={() => void requestClose()} className="workspace-dialog">
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">
      {([ ["workspace", "工作空间"], ["codex", "Codex 运行设置"], ["telegram", "Telegram"], ["infisical", "Infisical"] ] as const).map(([id, label]) => <button key={id} type="button" className={category === id ? "selected" : ""} aria-current={category === id ? "page" : undefined} onClick={() => setCategory(id)}>{label}</button>)}
    </nav><div className="settings-content"><form onSubmit={event => { if (category === "workspace" && !runtimeDirty) void save(event); else event.preventDefault(); }} className="settings-form">
      <h3>{({ workspace: "工作空间", codex: "Codex 运行设置", telegram: "Telegram", infisical: "Infisical" })[category]}</h3>
      {category === "workspace" && <>
      <label className="settings-item"><span>项目目录</span><div className="settings-path"><input aria-label="项目目录" value={workspace} disabled={disabled} onChange={e => setWorkspace(e.target.value)} placeholder="项目的绝对路径" />{desktop && <button type="button" disabled={disabled} onClick={() => void choose()}><FolderOpen size={14} />选择目录</button>}</div></label>
      {!!config?.recentWorkspaces.length && <label className="settings-item"><span>最近项目</span><select aria-label="最近项目" disabled={disabled} value="" onChange={e => setWorkspace(e.target.value)}><option value="">选择用过的项目…</option>{config.recentWorkspaces.map(p => <option key={p} value={p}>{p}</option>)}</select></label>}
      <div className="settings-access"><ShieldOff size={18} /><div><strong>完全访问 · 无执行隔离</strong><p>Codex 可以直接读写本机文件、执行命令和访问网络。停止任务不会撤销已经完成的操作。</p></div></div>
      <p className="settings-help">项目切换后请新建对话。设置保存在本机，下次启动自动恢复。</p>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={saving} onClick={() => void requestClose()}>取消</button><button type="submit" disabled={disabled || runtimeDirty}>{saving ? "正在保存…" : "保存设置"}</button></div>
      </>}
      {category === "codex" && <>
      <label className="settings-item"><span>当前模型</span><div className="settings-path"><select aria-label="当前模型" value={model} disabled={disabled || loadingModels || !!modelError || changedRuntime} onChange={e => { setRuntimeError(""); setRuntimeStatus(""); setModel(e.target.value); setEffort(""); setSpeed(""); }}><option value="">Codex 默认模型</option>{model && !models.some(m => m.id === model) && <option value={model}>{model}（请刷新确认）</option>}{models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? " · 推荐" : ""}</option>)}</select><button type="button" disabled={loadingModels || saving || changedRuntime} onClick={() => void refresh()}><RefreshCw size={14} />{loadingModels ? "读取中" : "刷新模型"}</button></div></label>
      <label className="settings-item"><span>Speed（速度档位）</span><select aria-label="Speed" value={speed} disabled={disabled || loadingModels || !!modelError || changedRuntime || !selectedModel} onChange={e => { setRuntimeError(""); setRuntimeStatus(""); setSpeed(e.target.value); }}><option value="">Codex 默认{selectedModel?.defaultSpeed ? `（${selectedModel.defaultSpeed}）` : ""}</option>{speed && speed !== "default" && !selectedModel?.speeds.some(t => t.id === speed) && <option value={speed}>{speed}（请刷新确认）</option>}<option value="default">标准</option>{selectedModel?.speeds.filter(t => t.id !== "default").map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="settings-item"><span>Effort（推理强度）</span><select aria-label="Effort" value={effort} disabled={disabled || loadingModels || !!modelError || changedRuntime || !selectedModel} onChange={e => { setRuntimeError(""); setRuntimeStatus(""); setEffort(e.target.value); }}><option value="">Codex 默认{selectedModel?.defaultEffort ? `（${selectedModel.defaultEffort}）` : ""}</option>{effort && !selectedModel?.efforts.includes(effort) && <option value={effort}>{effort}（请刷新确认）</option>}{selectedModel?.efforts.map(e => <option key={e} value={e}>{e}</option>)}</select></label>
      <p className="settings-help">速度档位可能影响费用，实际速度取决于账户和服务端。设置从下一条消息生效。</p>
      {modelError && <p role="alert" className="settings-error">{modelError}</p>}
      <label className="settings-item"><span>Codex 程序（留空使用内置版本）</span><input aria-label="Codex 程序" value={codexPath} disabled={disabled} onChange={e => { setRuntimeError(""); setRuntimeStatus(""); setCodexPath(e.target.value); setModel(""); setEffort(""); setSpeed(""); }} placeholder="可执行文件绝对路径" /></label><label className="settings-item"><span>Codex 配置目录（留空使用当前用户默认值）</span><input aria-label="Codex 配置目录" value={codexHome} disabled={disabled} onChange={e => { setRuntimeError(""); setRuntimeStatus(""); setCodexHome(e.target.value); setModel(""); setEffort(""); setSpeed(""); }} placeholder="已存在的 CODEX_HOME 绝对路径" /></label>
      <p className="settings-help">设置保存在本机；更改后自动保存，从下一条消息生效。Codex 密钥从环境或项目 .env 读取。</p>
      {runtimeStatus && <p role="status">{runtimeStatus}</p>}
      {runtimeError && <><p role="alert" className="settings-error">{runtimeError}</p><button type="button" disabled={disabled} onClick={() => { setRuntimeError(""); }}>重试自动保存</button></>}
      </>}
      {(category === "telegram" || category === "infisical") && <>

        <p className="settings-help">只接受下面列出的 Telegram 用户。Bot 使用当前项目和 Codex 的完全访问权限。Infisical Client Secret 仅保存在本机；留空保留原值。</p>
        {category === "infisical" && <>
        <label className="settings-item"><span>Infisical Project ID</span><input value={tg.projectId} disabled={disabled || tgSaving} onChange={e => setTg({ ...tg, projectId: e.target.value })} /></label>
        <label className="settings-item"><span>Infisical Client ID</span><input value={tg.clientId} disabled={disabled || tgSaving} onChange={e => setTg({ ...tg, clientId: e.target.value })} /></label>
        <label className="settings-item"><span>Infisical Client Secret</span><input type="password" autoComplete="new-password" value={tg.clientSecret} disabled={disabled || tgSaving} placeholder={tg.hasClientSecret ? "已保存，留空保持不变" : "填写 Client Secret"} onChange={e => setTg({ ...tg, clientSecret: e.target.value })} /></label>
        <label className="settings-item"><span>Infisical 环境</span><input value={tg.environment} disabled={disabled || tgSaving} onChange={e => setTg({ ...tg, environment: e.target.value })} /></label>
        </>}
        {category === "telegram" && <>
        <label className="settings-item"><span>允许的 Telegram 用户 ID（逗号分隔）</span><input value={tg.allowedUsers} disabled={disabled || tgSaving} onChange={e => setTg({ ...tg, allowedUsers: e.target.value })} /></label>
        <label><input type="checkbox" checked={tg.enabled} disabled={disabled || tgSaving} onChange={e => setTg({ ...tg, enabled: e.target.checked })} /> 启用 Telegram Bot</label>
        </>}
        <button type="button" disabled={disabled || tgSaving} onClick={() => void saveTelegram()}>{tgSaving ? "正在保存…" : "保存 Telegram 与 Infisical 设置"}</button>
        {tgError && <p role="alert" className="settings-error">{tgError}</p>}{tgStatus && <p role="status">{tgStatus}</p>}
      </>}
      {blocked && <p role="status">请先停止或等待当前任务完成，再保存设置。</p>}
    </form></div></div>
  </DialogFrame>;
}

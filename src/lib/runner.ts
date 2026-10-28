import { workspace, runtimeConfig } from "./config";
import { runs, assertCanRun } from "./runtime-state";
import { randomUUID } from "node:crypto";
import { activity, openThread, readableError } from "./codex";
import { HttpError } from "./http";
import { getChat, saveChat } from "./store";
import type { Chat, Message, StreamEvent } from "./types";

// Shared across Next development reloads. Run a single Node server for this local app.
const state = globalThis as typeof globalThis & { prbotRuns?: Map<string, AbortController>; prbotSnapshots?: Map<string, Chat>; prbotWorkspaceQuarantine?: Set<string> };
const snapshots = state.prbotSnapshots ??= new Map();
const quarantine = state.prbotWorkspaceQuarantine ??= new Set<string>();
export function quarantineWorkspace(workspacePath: string) { quarantine.add(workspacePath); }
export function clearWorkspaceQuarantine(workspacePath: string) { quarantine.delete(workspacePath); }
export function liveChat(id: string) { return snapshots.get(id); }
export function isRunning(id: string) { return runs.has(id); }
export function stop(id: string) { runs.get(id)?.abort(); }
export function reserve(id: string, workspacePath?: string) {
  assertCanRun();
  if (workspacePath && quarantine.has(workspacePath)) throw new HttpError(409, "上次远程任务的 Codex 子进程尚未确认停止，请先在 Telegram 用 /continue 检查并确认");
  if (runs.has(id)) throw new HttpError(409, "这段对话还在执行，请先停止或等待完成");
  const workspaceKey = workspacePath ? `workspace:${workspacePath}` : undefined;
  if (workspaceKey && runs.has(workspaceKey)) throw new HttpError(409, "当前工作空间有任务正在执行，请先停止或等待完成");
  const controller = new AbortController(); runs.set(id, controller);
  if (workspaceKey) runs.set(workspaceKey, controller);
  return { controller, release: () => { if (runs.get(id) === controller) { runs.delete(id); snapshots.delete(id); if (workspaceKey && runs.get(workspaceKey) === controller) runs.delete(workspaceKey); } } };
}
export function recover(chat: Chat) {
  if (!isRunning(chat.id)) {
    for (const m of chat.messages) if (m.status === "running") {
      m.status = "stopped"; m.error = "上次执行被中断，可以继续发送消息。";
    }
  }
  return chat;
}
export async function prepareTurn(id: string, prompt: string) {
  const currentWorkspace = await workspace();
  const lock = reserve(id, currentWorkspace);
  try {
    const chat = await getChat(id);
    if (chat.workspace && chat.workspace !== currentWorkspace) throw new HttpError(409, "这段对话属于另一个项目，请切回原目录或新建对话");
    chat.workspace = currentWorkspace;
    // A previous process may have exited without a terminal event.
    for (const m of chat.messages) if (m.status === "running") {
      m.status = "stopped"; m.error = "上次执行被中断。";
    }
    const answer: Message = { id: randomUUID(), role: "assistant", text: "", activities: [], status: "running" };
    chat.messages.push({ id: randomUUID(), role: "user", text: prompt, activities: [], status: "completed" }, answer);
    if (chat.messages.length === 2) chat.title = prompt.replace(/\s+/g, " ").slice(0, 40);
    await saveChat(chat);
    snapshots.set(id, chat);
    return { chat, answer, ...lock };
  } catch (e) { lock.release(); throw e; }
}

export function streamTurn(turn: Awaited<ReturnType<typeof prepareTurn>>, prompt: string, requestSignal: AbortSignal) {
  const { chat, answer, controller, release } = turn;
  const signal = AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(30 * 60_000)]);
  let connected = true;
  return new ReadableStream<Uint8Array>({
    async start(stream) {
      const emit = (event: StreamEvent) => {
        if (connected) try { stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); }
        catch { connected = false; controller.abort(); }
      };
      const snapshot = () => emit({ type: "snapshot", chat });
      let completed = false;
      const texts = new Map<string, string>();
      try {
        snapshot();
        signal.throwIfAborted();
        const thread = await openThread(chat.threadId);
        const { events } = await thread.runStreamed(prompt, { signal });
        for await (const event of events) {
          signal.throwIfAborted();
          if (event.type === "thread.started") {
            chat.threadId = event.thread_id;
            await saveChat(chat); // Persist before the first model item, including on cancellation.
          }
          if ("item" in event) {
            if (event.item.type === "agent_message") {
              texts.set(event.item.id, event.item.text);
              answer.text = [...texts.values()].join("\n\n");
            } else {
              const update = activity(event);
              if (update) {
                const index = answer.activities.findIndex(a => a.id === update.id);
                if (index >= 0) answer.activities[index] = update;
                else { answer.activities.push(update); if (answer.activities.length > 200) answer.activities.shift(); }
              }
            }
          }
          if (event.type === "turn.failed") throw new Error(event.error.message);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "turn.completed") { completed = true; answer.usage = event.usage; }
          snapshot();
        }
        if (!completed) throw new Error("Codex 连接提前结束，没有收到完成状态");
        answer.status = "completed";
      } catch (e) {
        answer.status = signal.aborted ? "stopped" : "failed";
        const config = await runtimeConfig().catch(() => undefined);
        answer.error = signal.aborted ? "执行已停止。已完成的文件操作不会自动撤销。" : readableError(e, [config?.env.CODEX_API_KEY || "", config?.env.OPENAI_API_KEY || ""]);
      } finally {
        try {
          await saveChat(chat);
          snapshot();
        } catch {
          emit({ type: "error", message: "聊天记录保存失败，请检查磁盘空间和目录权限。" });
        } finally {
          release();
          if (connected) { connected = false; stream.close(); }
        }
      }
    },
    cancel() { connected = false; controller.abort(); },
  });
}

import { HttpError } from "./http";
// One service process, including Next hot reloads and separate route bundles.
const state = globalThis as typeof globalThis & {
  prbotRuns?: Map<string, AbortController>;
  prbotSettingsBusy?: boolean;
};
export const runs = state.prbotRuns ??= new Map<string, AbortController>();
export function assertCanRun() {
  if (state.prbotSettingsBusy) throw new HttpError(409, "正在保存设置，请稍后发送任务");
}
export async function changeSettings<T>(change: () => Promise<T>): Promise<T> {
  if (state.prbotSettingsBusy || runs.size) throw new HttpError(409, "有任务正在执行，请先停止或等待完成再改设置");
  state.prbotSettingsBusy = true;
  try { return await change(); } finally { state.prbotSettingsBusy = false; }
}

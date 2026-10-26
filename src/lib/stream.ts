import type { StreamEvent } from "./types";
// HTTP chunks can split both a UTF-8 character and an NDJSON line.
export async function consumeStream(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  if (!response.body) throw new Error("浏览器没有收到响应流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
  } finally { reader.releaseLock(); }
}

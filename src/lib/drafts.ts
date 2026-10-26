// A draft stays in this browser; it is never included in public server configuration.
function key(id: string | null) { return `prbot:draft:v1:${id || "new"}`; }
export function readDraft(id: string | null) {
  try { return localStorage.getItem(key(id))?.slice(0, 16_000) || ""; } catch { return ""; }
}
export function writeDraft(id: string | null, value: string) {
  try {
    if (value) localStorage.setItem(key(id), value);
    else localStorage.removeItem(key(id));
    return true;
  } catch { return false; /* Private browsing or a full storage quota must not block sending. */ }
}

// The browser side of the storage contract.
//
// /api/state is the source of truth. localStorage is a recovery backup — never a
// silent substitute. A read that fell back to the backup says so, because the way
// a log gets erased is: the app loads a stale backup, believes it, saves it back.
//
// Nothing here throws. A failed write must be *reportable*, not invisible; the
// old code funnelled every failure into console.error, so a dropped POST looked
// exactly like a saved one.

export function createStorage(deps = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    storage = globalThis.localStorage,
    log = console,
  } = deps;

  const backupGet = (k) => { try { return storage.getItem(k); } catch { return null; } };
  const backupSet = (k, v) => { try { storage.setItem(k, v); } catch { /* quota, private mode */ } };

  return {
    // -> { value, source: "server" | "backup" } | null
    async get(key) {
      try {
        const res = await fetchImpl("/api/state");
        if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
        const text = await res.text();
        backupSet(key, text);
        return { value: text, source: "server" };
      } catch (e) {
        log.error("Server read failed; offering the local backup read-only", e);
        const cached = backupGet(key);
        return cached != null ? { value: cached, source: "backup" } : null;
      }
    },

    // Retained previous revisions, newest first. A backup you cannot reach is not
    // a backup, so the app can list and restore them.
    // -> { ok: true, snapshots: [{ rev, updatedAt, count }] } | { ok: false, error }
    async history() {
      try {
        const res = await fetchImpl("/api/state?history=1");
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const body = await res.json();
        return { ok: true, snapshots: body.snapshots ?? [], keep: body.keep };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // -> { ok: true, state } | { ok: false, error }
    async snapshot(rev) {
      try {
        const res = await fetchImpl(`/api/state?rev=${encodeURIComponent(rev)}`);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true, state: await res.json() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // -> { ok: true, rev } | { ok: false, conflict: true, rev } | { ok: false, error }
    async set(key, value) {
      // Keep a local copy first so a failed network write can't lose the edit.
      backupSet(key, value);
      try {
        const res = await fetchImpl("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: value, // already JSON.stringify({ rev, problems })
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, conflict: true, rev: body.rev };
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const body = await res.json().catch(() => ({}));
        return { ok: true, rev: body.rev };
      } catch (e) {
        log.error("Server write failed; the edit is only in this browser", e);
        return { ok: false, error: e.message };
      }
    },
  };
}

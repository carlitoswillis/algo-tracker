// Stores the tracker URL and password, requests host permission for that one
// origin, and verifies the credentials with a read before saving them. A GET is
// safe to use as a probe — it never writes.

const $ = (id) => document.getElementById(id);
const status = (msg, cls = "") => { $("status").className = cls; $("status").textContent = msg; };

chrome.storage.local.get(["baseUrl", "password", "problemHost"]).then(({ baseUrl, password, problemHost }) => {
  if (baseUrl) $("baseUrl").value = baseUrl;
  if (password) $("password").value = password;
  if (problemHost) $("problemHost").value = problemHost;
});

function normalise(raw) {
  const text = raw.trim().replace(/\/+$/, "");
  if (!text) throw new Error("Enter your tracker's URL.");
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error("That doesn't look like a URL."); }
  return u.origin;
}

$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try {
    const baseUrl = normalise($("baseUrl").value);
    const password = $("password").value;
    // Optional: the one host whose page titles name a problem. Stored as a
    // bare hostname so the popup can compare it to the active tab's.
    const problemHost = $("problemHost").value.trim()
      .replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

    status("Asking Chrome for permission…");
    const granted = await chrome.permissions.request({ origins: [`${baseUrl}/*`] });
    if (!granted) throw new Error("Permission denied — the extension can't reach your tracker.");

    status("Checking the connection…");
    const res = await fetch(`${baseUrl}/api/state`, {
      // Only sent when a password was entered — most trackers run
      // unauthenticated on a private network.
      headers: password ? { Authorization: "Basic " + btoa(":" + password) } : {},
    });
    if (res.status === 401) throw new Error("Wrong password.");
    if (!res.ok) throw new Error(`Tracker returned HTTP ${res.status}.`);

    const state = await res.json();
    const count = state?.problems?.length ?? 0;

    await chrome.storage.local.set({ baseUrl, password, problemHost });
    status(`Connected to ${baseUrl} — ${count} problem${count === 1 ? "" : "s"} tracked.`, "ok");
  } catch (e) {
    status(e.message, "err");
  } finally {
    $("save").disabled = false;
  }
});

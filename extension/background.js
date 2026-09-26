// GroupTrip extension — background worker. The only place that talks to the
// GroupTrip backend, with the pairing token from chrome.storage.
const DEFAULT_SERVER = "http://localhost:3000";

async function settings() {
  const s = await chrome.storage.local.get(["server", "token", "tripId"]);
  return { server: (s.server || DEFAULT_SERVER).replace(/\/$/, ""), token: s.token || "", tripId: s.tripId || "" };
}

async function call(path, method = "GET", body) {
  const { server, token } = await settings();
  if (!token) return { ok: false, error: "Pair the extension first: GroupTrip → Profile → Connect browser extension." };
  try {
    const res = await fetch(server + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `GroupTrip returned ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Can't reach GroupTrip at ${server} — is the app running?` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "settings") return reply(await settings());
    if (msg.type === "api") return reply(await call(msg.path, msg.method, msg.body));
    reply({ ok: false, error: "Unknown message" });
  })();
  return true; // async reply
});

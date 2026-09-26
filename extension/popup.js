// GroupTrip extension — toolbar popup: pairing, then the same advisor flow for the current tab.
const $ = (id) => document.getElementById(id);

async function scanTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["scan.js"] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__groupTripScan() });
    return res.result;
  } catch (e) {
    return null;
  }
}

async function load() {
  const s = await chrome.storage.local.get(["server", "token"]);
  if (s.server) $("server").value = s.server;
  if (!s.token) return;
  $("pair").hidden = true;
  $("app").hidden = false;
  const style = document.createElement("style");
  style.textContent = window.GroupTripAdvisor.CSS + ".gt-card{width:100%;box-shadow:none;max-height:none}";
  document.head.appendChild(style);
  const scan = (await scanTab()) || { host: "", title: "", url: "", pageText: "", amountPaise: null, offerTexts: [] };
  window.GroupTripAdvisor.mount($("advisor"), scan);
}

$("save").onclick = async () => {
  const token = $("token").value.trim();
  if (!/^gtx_/.test(token)) {
    $("msg").innerHTML = '<span style="color:#ba1a1a">Tokens start with gtx_ — copy it from GroupTrip → Profile.</span>';
    return;
  }
  await chrome.storage.local.set({ server: $("server").value.trim(), token });
  load();
};
$("unpair").onclick = async () => {
  await chrome.storage.local.remove(["token", "tripId"]);
  location.reload();
};

load();

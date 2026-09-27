// GroupTrip extension — the advisor flow, shared by the on-page pop-up and the toolbar popup.
//   1. Trip  — auto-detected from the page (destination + dates), ongoing/upcoming only; changeable.
//   2. Who's included in this payment — tick the people.
//   3. Who has to pay for max saving — from the site's own bank offers + our curated list, among those people.
//   4. Who paid + booking ID → added to THAT trip, shared only by the ticked people.
(function () {
  const fmt = (p) => "₹" + Math.round(p / 100).toLocaleString("en-IN");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
  const api = (path, method, body) => send({ type: "api", path, method, body });
  const first = (n) => String(n).split(" ")[0];

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  function datesOnPage(text) {
    const out = [];
    const year = new Date().getFullYear();
    const re = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s*(\d{4})?|\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?/gi;
    let m;
    while ((m = re.exec(text)) && out.length < 30) {
      const day = Number(m[1] || m[5]);
      const mon = MONTHS[(m[2] || m[4]).toLowerCase().slice(0, 3)];
      const y = Number(m[3] || m[6]) || year;
      if (day >= 1 && day <= 31 && mon !== undefined) out.push(`${y}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
    const iso = /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g;
    while ((m = iso.exec(text)) && out.length < 40) out.push(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
    const dmy = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d\d)\b/g; // Indian sites write day/month/year
    while ((m = dmy.exec(text)) && out.length < 40) {
      if (Number(m[1]) <= 31 && Number(m[2]) <= 12) out.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
    }
    return out;
  }

  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const short = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const pageDates = (scan) => [...new Set(datesOnPage(`${scan.title || ""} ${decodeURIComponent(scan.url || "")} ${scan.pageText || ""}`))].sort();

  /** Are the booking's dates in (or within two days of) the trip? Also finds a trip that does match. */
  function dateCheck(trip, trips, scan) {
    const dates = pageDates(scan);
    if (!dates.length) return { state: "unknown" };
    const fits = (t) => dates.filter((d) => d >= addDays(t.startDate, -2) && d <= addDays(t.endDate, 2));
    const hit = fits(trip);
    if (hit.length) return { state: "ok", date: hit[0] };
    const other = trips.find((t) => t.id !== trip.id && fits(t).length);
    return { state: "mismatch", date: dates[0], other };
  }

  const STOP = new Set(["india", "north", "south", "east", "west", "new", "the", "city", "island", "islands", "beach", "old", "trip"]);
  /** Which trip is this page about? Destination words and travel dates on the page. */
  function detectTrip(trips, scan) {
    const hay = `${scan.title} ${decodeURIComponent(scan.url || "")} ${scan.pageText || ""}`.toLowerCase();
    const dates = pageDates(scan);
    let best = null;
    for (const t of trips) {
      let score = 0;
      const words = t.destination.toLowerCase().split(/[,\s]+/).filter((w) => w.length >= 3 && !STOP.has(w));
      if (words.some((w) => hay.includes(w))) score += 3;
      if (hay.includes(t.name.toLowerCase())) score += 2;
      if (dates.some((d) => d >= t.startDate && d <= t.endDate)) score += 2;
      if (!best || score > best.score) best = { trip: t, score };
    }
    return best && best.score > 0 ? best.trip : null;
  }

  async function mount(root, scan, opts = {}) {
    const s = await send({ type: "settings" });
    if (!s || !s.token) {
      root.innerHTML = `<div class="gt-card"><div class="gt-t">GroupTrip</div><div class="gt-m">Click the GroupTrip icon in the toolbar to pair the extension with your account.</div></div>`;
      return;
    }
    root.innerHTML = `<div class="gt-card"><div class="gt-m">Loading your trips…</div></div>`;
    const tr = await api("/api/ext/trips", "GET");
    if (!tr || !tr.ok) {
      root.innerHTML = `<div class="gt-card"><div class="gt-t">GroupTrip</div><div class="gt-m gt-err">${esc(tr ? tr.error : "GroupTrip didn't answer")}</div></div>`;
      return;
    }
    const trips = tr.data.trips;
    if (!trips.length) {
      root.innerHTML = `<div class="gt-card"><div class="gt-t">No ongoing or upcoming trips</div><div class="gt-m">Create a trip in GroupTrip first.</div></div>`;
      return;
    }
    const detected = detectTrip(trips, scan);
    const state = { trip: detected || trips.find((t) => t.id === s.tripId) || trips[0], detected: !!detected, amount: scan.amountPaise || 0, pax: scan.travellers || null, paxFromPage: !!scan.travellers, included: null, result: null };
    /** Start with everyone when the booking covers the whole group; otherwise just me, and the user ticks the rest. */
    const defaultIncluded = () => {
      const all = state.trip.members.map((m) => m.id);
      if (!state.pax || state.pax >= all.length) return new Set(all);
      const me = state.trip.members.find((m) => m.isMe);
      return new Set(me ? [me.id] : all.slice(0, state.pax));
    };
    state.included = defaultIncluded();
    const countOk = () => !state.pax || state.included.size === state.pax;
    const countMsg = () => `This booking is for ${state.pax} ${state.pax === 1 ? "person" : "people"} — tick exactly ${state.pax} (${state.included.size} ticked).`;

    function render() {
      const t = state.trip;
      root.innerHTML = `<div class="gt-card">
        ${opts.closable ? '<button class="gt-x" data-a="close">×</button>' : ""}
        <div class="gt-step">1 · Trip ${state.detected ? '<span class="gt-tag">detected from this page</span>' : '<span class="gt-tag gt-warn">please confirm</span>'}</div>
        <select data-a="trip">${trips.map((x) => `<option value="${esc(x.id)}" ${x.id === t.id ? "selected" : ""}>${esc(x.name)} · ${esc(x.destination.split(",")[0])} (${x.phase})</option>`).join("")}</select>
        ${(() => {
          const dc = dateCheck(t, trips, scan);
          if (dc.state === "ok") return `<div class="gt-ok">✓ Booking date ${short(dc.date)} is within this trip (${short(t.startDate)} – ${short(t.endDate)})</div>`;
          if (dc.state === "mismatch")
            return `<div class="gt-warnbox">⚠ This page shows ${short(dc.date)}, outside ${esc(t.name)} (${short(t.startDate)} – ${short(t.endDate)}).${dc.other ? ` <button class="gt-link" data-a="switch" value="${esc(dc.other.id)}">Switch to ${esc(dc.other.name)}</button>` : " Check the dates before booking."}</div>`;
          return `<div class="gt-m">Couldn't read booking dates on this page — check they're within ${short(t.startDate)} – ${short(t.endDate)}.</div>`;
        })()}
        <div class="gt-step">Amount on this page</div>
        <input data-a="amount" inputmode="decimal" value="${state.amount ? state.amount / 100 : ""}" placeholder="Total in ₹" />
        <div class="gt-m">${esc(scan.host || "")} · ${scan.offerTexts.length} bank offer(s) read on this page</div>
        <div class="gt-step">Travellers on this booking</div>
        <div class="gt-pax"><input data-a="pax" type="number" min="1" max="30" value="${state.pax || ""}" placeholder="?" /> <span class="gt-m">${state.paxFromPage ? "read from the page" : "couldn't read it — set how many people"}</span></div>
        <div class="gt-step">2 · Choose who all are included ${state.pax ? `<span class="gt-tag ${countOk() ? "" : "gt-warn"}" data-a="count">${state.included.size} of ${state.pax}</span>` : ""}</div>
        <div class="gt-people">${t.members
          .map(
            (m) => `<label class="gt-person"><input type="checkbox" data-a="who" value="${esc(m.id)}" ${state.included.has(m.id) ? "checked" : ""}/> ${m.isMe ? "You" : esc(first(m.name))}${m.cards.length ? "" : ' <span class="gt-m">(no card)</span>'}</label>`,
          )
          .join("")}</div>
        <button class="gt-b" data-a="find">3 · Who should pay for max saving?</button>
        <div data-a="result"></div>
      </div>`;
      bind();
      if (state.result) renderResult();
    }

    function renderResult() {
      const d = state.result;
      const box = root.querySelector('[data-a="result"]');
      const b = d.best;
      const payerDefault = b ? b.memberId : state.trip.members.find((m) => m.isMe)?.id;
      box.innerHTML = `
        <div class="gt-best">
          ${
            b
              ? `<div class="gt-m">This person has to pay to make max saving</div>
                 <div class="gt-t">${b.isMe ? "You" : esc(first(b.memberName))} · ${esc(b.card)}</div>
                 <div class="gt-save">Saves ${fmt(b.savingPaise)} <span class="gt-tag">${b.source === "page" ? "offer on this page" : "curated offer"}</span></div>
                 <div class="gt-m">${esc((b.offer || "").slice(0, 170))}${b.code ? " · code <b>" + esc(b.code) + "</b>" : ""}</div>`
              : `<div class="gt-t">No card among these people matches an offer here</div>`
          }
          <div class="gt-list">${d.options
            .slice(0, 5)
            .map((o) => `<div class="gt-row"><span>${o.isMe ? "You" : esc(first(o.memberName))} · ${esc(o.card)}</span><b>${o.savingPaise ? fmt(o.savingPaise) : "—"}</b></div>`)
            .join("")}</div>
        </div>
        <div class="gt-step">4 · Who paid?</div>
        <select data-a="payer">${state.trip.members
          .filter((m) => state.included.has(m.id))
          .map((m) => `<option value="${esc(m.id)}" ${m.id === payerDefault ? "selected" : ""}>${m.isMe ? "You" : esc(m.name)}</option>`)
          .join("")}</select>
        <input data-a="ref" placeholder="Booking ID (optional)" />
        <button class="gt-b" data-a="add">Booked — add ${fmt(state.amount)} to ${esc(state.trip.name)}</button>
        <div class="gt-m" data-a="msg">Split between the ${state.included.size} people ticked. Savings are estimates from offer text.</div>`;
      const addBtn = box.querySelector('[data-a="add"]');
      addBtn.onclick = async () => {
        if (addBtn.disabled) return;
        if (!countOk()) {
          box.querySelector('[data-a="msg"]').innerHTML = `<span class="gt-err">${esc(countMsg())}</span>`;
          return;
        }
        addBtn.disabled = true; // one click = one expense, even if the network is slow
        const payerId = box.querySelector('[data-a="payer"]').value;
        const cardLabel = b && b.memberId === payerId ? b.card : undefined;
        const cap = await api("/api/ext/capture", "POST", {
          tripId: state.trip.id,
          host: scan.host,
          title: scan.title,
          amountPaise: state.amount,
          reference: box.querySelector('[data-a="ref"]').value,
          participantIds: [...state.included],
          pax: state.pax || undefined,
          payerId,
          cardLabel,
        });
        box.querySelector('[data-a="msg"]').innerHTML = cap && cap.ok
          ? `✓ Added to <b>${esc(cap.data.tripName)}</b> — paid by ${esc(first(cap.data.paidBy))}, split ${cap.data.sharedBy} ways.`
          : `<span class="gt-err">${esc(cap ? cap.error : "Couldn't add it")}</span>`;
        if (cap && cap.ok) addBtn.textContent = `✓ Added to ${state.trip.name}`;
        else addBtn.disabled = false;
      };
    }

    function bind() {
      const q = (a) => root.querySelector(`[data-a="${a}"]`);
      if (q("close")) q("close").onclick = () => opts.onClose && opts.onClose();
      q("trip").onchange = (e) => {
        state.trip = trips.find((x) => x.id === e.target.value);
        state.detected = false;
        state.included = defaultIncluded();
        state.result = null;
        chrome.storage.local.set({ tripId: state.trip.id });
        render();
      };
      if (q("switch")) {
        q("switch").onclick = () => {
          q("trip").value = q("switch").value;
          q("trip").onchange({ target: q("trip") });
        };
      }
      q("pax").oninput = (e) => {
        const n = Math.round(Number(e.target.value));
        state.pax = n >= 1 && n <= 30 ? n : null;
        state.paxFromPage = false;
        state.result = null;
        render();
      };
      q("amount").oninput = (e) => {
        state.amount = Math.round(Number(String(e.target.value).replace(/[^\d.]/g, "")) * 100) || 0;
      };
      root.querySelectorAll('[data-a="who"]').forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) state.included.add(cb.value);
          else state.included.delete(cb.value);
          state.result = null;
          const r = root.querySelector('[data-a="result"]');
          if (r) r.innerHTML = "";
          const c = root.querySelector('[data-a="count"]');
          if (c) {
            c.textContent = `${state.included.size} of ${state.pax}`;
            c.classList.toggle("gt-warn", !countOk());
          }
        };
      });
      q("find").onclick = async () => {
        const r = root.querySelector('[data-a="result"]');
        if (!state.amount) return (r.innerHTML = '<div class="gt-m gt-err">Type the total shown on the page.</div>');
        if (!state.included.size) return (r.innerHTML = '<div class="gt-m gt-err">Tick at least one person.</div>');
        if (!countOk()) return (r.innerHTML = `<div class="gt-m gt-err">${esc(countMsg())}</div>`);
        r.innerHTML = '<div class="gt-m">Checking cards…</div>';
        const res = await api("/api/ext/suggest", "POST", { tripId: state.trip.id, host: scan.host, title: scan.title, amountPaise: state.amount, offerTexts: scan.offerTexts, participantIds: [...state.included] });
        if (!res || !res.ok) return (r.innerHTML = `<div class="gt-m gt-err">${esc(res ? res.error : "GroupTrip didn't answer")}</div>`);
        state.result = res.data;
        renderResult();
      };
    }
    render();
  }

  const CSS = `
    .gt-card{width:330px;max-height:78vh;overflow:auto;font:13px/1.45 system-ui,sans-serif;color:#0e1e1b;background:#fff;border-radius:16px;box-shadow:0 12px 36px rgba(16,32,28,.25);padding:14px 16px;box-sizing:border-box}
    .gt-t{font-weight:700;font-size:15px;margin:2px 0 4px}
    .gt-m{color:#3f4946;font-size:12px}
    .gt-err{color:#ba1a1a}
    .gt-ok{margin-top:6px;padding:6px 8px;border-radius:8px;background:#dff2eb;color:#005047;font-size:12px}
    .gt-warnbox{margin-top:6px;padding:6px 8px;border-radius:8px;background:#ffddb0;color:#614000;font-size:12px}
    .gt-link{background:none;border:0;padding:0;color:#00564c;font-weight:700;text-decoration:underline;cursor:pointer;font-size:12px}
    .gt-pax{display:flex;align-items:center;gap:8px}
    .gt-pax input{width:70px !important}
    .gt-step{font-weight:700;font-size:12px;color:#00564c;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.03em}
    .gt-save{color:#00564c;font-weight:700;font-size:18px}
    .gt-row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid #e5f8f1}
    .gt-list{margin-top:6px}
    .gt-best{background:#ebfef6;border-radius:12px;padding:10px 12px;margin-top:10px}
    .gt-b{font:600 13px system-ui;background:#1e6f64;color:#fff;border:0;border-radius:10px;padding:10px 12px;cursor:pointer;width:100%;margin-top:10px}
    .gt-card input:not([type=checkbox]),.gt-card select{font:13px system-ui;border:1px solid #bec9c5;border-radius:8px;padding:7px 9px;width:100%;box-sizing:border-box;margin-top:2px;background:#fff}
    .gt-people{display:flex;flex-wrap:wrap;gap:6px}
    .gt-person{display:flex;align-items:center;gap:4px;background:#dff2eb;border-radius:999px;padding:4px 10px;cursor:pointer}
    .gt-x{float:right;background:none;border:0;font-size:18px;cursor:pointer;color:#6f7976}
    .gt-tag{display:inline-block;background:#dff2eb;color:#005047;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:600;text-transform:none;letter-spacing:0;margin-left:4px}
    .gt-warn{background:#ffddb0;color:#614000}`;

  window.GroupTripAdvisor = { mount, CSS, detectTrip, dateCheck, datesOnPage };
})();

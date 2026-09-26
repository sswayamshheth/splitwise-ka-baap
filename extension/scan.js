// GroupTrip extension — reads the checkout page: the payable total and the
// bank/card offers the site itself lists. Best-effort and generic (no
// per-site code); the user can correct the amount in the panel.
(function () {
  const AMOUNT_RE = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/gi;
  const TOTAL_WORDS = /(grand total|total amount|amount to (?:be )?pa(?:y|id)|you pay|total payable|payable|pay now|final amount|total fare|total price|total)/i;
  const BANK_WORDS = /(hdfc|icici|axis|sbi|kotak|idfc|amex|american express|yes bank|indusind|rbl|onecard|federal|bank of baroda|au bank|credit card|debit card|visa|mastercard|rupay)/i;
  const OFFER_WORDS = /(\d+\s?%|off|discount|cashback|save)/i;

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && !/line-through/.test(cs.textDecorationLine || "");
  }

  function findTotal() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || text.length > 200) continue;
      AMOUNT_RE.lastIndex = 0;
      let m;
      while ((m = AMOUNT_RE.exec(text))) {
        const rupees = Number(m[1].replace(/,/g, ""));
        if (!rupees || rupees < 50 || rupees > 1000000) continue;
        const el = node.parentElement;
        if (!visible(el)) continue;
        let score = 0;
        let ctx = el;
        for (let i = 0; i < 4 && ctx; i++, ctx = ctx.parentElement) {
          const t = (ctx.innerText || "").slice(0, 160);
          if (TOTAL_WORDS.test(t)) { score += 10 - i * 2; break; }
        }
        const size = parseFloat(getComputedStyle(el).fontSize) || 12;
        score += Math.min(4, size / 6);
        found.push({ rupees, score });
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => b.score - a.score || b.rupees - a.rupees);
    return Math.round(found[0].rupees * 100);
  }

  function findOffers() {
    const out = new Set();
    for (const el of document.querySelectorAll("div, li, p, span, label")) {
      if (out.size >= 40) break;
      if (el.children.length > 6) continue;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 15 || t.length > 260) continue;
      if (BANK_WORDS.test(t) && OFFER_WORDS.test(t) && visible(el)) out.add(t);
    }
    // Keep the most specific texts (drop ones that merely contain another).
    const list = [...out];
    return list.filter((t) => !list.some((o) => o !== t && t.includes(o) && o.length > 25)).slice(0, 25);
  }

  window.__groupTripScan = function () {
    return { host: location.hostname, title: document.title, amountPaise: findTotal(), offerTexts: findOffers(), url: location.href, pageText: ((document.body && document.body.innerText) || "").slice(0, 6000) };
  };
})();

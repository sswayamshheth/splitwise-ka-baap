// GroupTrip extension — on booking sites, a pop-up opens by itself at checkout
// (once per page) and walks through: trip → who's included → who should pay → add to trip.
(function () {
  const TRAVEL = /(makemytrip|goibibo|cleartrip|easemytrip|yatra|goindigo|airindia|akasaair|spicejet|booking\.com|agoda|airbnb|irctc|redbus|ixigo|oyorooms|skyscanner|trivago|expedia|thrillophilia|klook)/i;
  if (!TRAVEL.test(location.hostname) || window.__groupTripMounted) return; // elsewhere: toolbar popup only
  window.__groupTripMounted = true;

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>:host{all:initial}${window.GroupTripAdvisor.CSS}
    .pill{font:600 13px/1 system-ui,sans-serif;background:#1e6f64;color:#fff;border:0;border-radius:999px;padding:11px 16px;box-shadow:0 8px 20px rgba(30,111,100,.35);cursor:pointer}</style>
    <div id="panel" style="display:none"></div><button class="pill" id="pill">🧭 GroupTrip · who should pay?</button>`;
  document.documentElement.appendChild(host);
  const panel = shadow.getElementById("panel");
  let open = false;

  function show() {
    open = true;
    panel.style.display = "block";
    window.GroupTripAdvisor.mount(panel, window.__groupTripScan(), { closable: true, onClose: hide });
  }
  function hide() {
    open = false;
    panel.style.display = "none";
  }
  shadow.getElementById("pill").onclick = () => (open ? hide() : show());

  // Pop up on its own once the page looks like a checkout with a total (SPAs change pages without reloading).
  let shownFor = "";
  const CHECKOUT = /(payment|pay now|proceed to pay|review (your )?booking|checkout|complete (your )?booking|payment options|fare summary|price details)/i;
  function maybeAutoOpen() {
    if (open || shownFor === location.href) return;
    const text = (document.body && document.body.innerText) || "";
    if (!CHECKOUT.test(text.slice(0, 20000))) return;
    const scan = window.__groupTripScan();
    if (!scan.amountPaise) return;
    shownFor = location.href;
    show();
  }
  setTimeout(maybeAutoOpen, 2500);
  setInterval(maybeAutoOpen, 4000);
})();

// GroupTrip extension — one-click pairing. Runs only on the GroupTrip app itself:
// the Profile page hands its freshly issued token to the extension, so nobody copies it by hand.
(function () {
  document.documentElement.dataset.grouptripExtension = "1";
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== "GROUPTRIP_PAIR" || typeof d.token !== "string" || !/^gtx_[A-Za-z0-9_-]{20,}$/.test(d.token)) return;
    chrome.storage.local.set({ server: location.origin, token: d.token }, () => {
      window.postMessage({ type: "GROUPTRIP_PAIRED" }, location.origin);
    });
  });
})();

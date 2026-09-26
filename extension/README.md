# GroupTrip — Group Card Advisor (browser extension, desktop proof of concept)

On a booking site's checkout page it reads the **total** and the **bank offers the site itself lists**,
asks your GroupTrip trip whose card saves the most, and adds the booking to the trip ledger.

## Load it (Chrome / Edge / Brave)
1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. In GroupTrip (http://localhost:3000 or the deployed app): **Profile → Connect browser extension (one click)** — the page hands
   the token to the extension and shows "Extension connected". (After editing these files, press **Reload** on the extension card.)
4. Fallback: click the extension icon → set the GroupTrip address → paste the token shown on Profile → **Pair extension**.
5. On MakeMyTrip / Goibibo / IndiGo / Booking.com etc. the pop-up **opens by itself on the checkout page** (once per page;
   the pill bottom-right reopens it). On any other site use the toolbar popup. The flow:
   1. **Trip** — only ongoing/upcoming trips; auto-detected from the destination and dates on the page (changeable).
   2. **Choose who all are included** — tick the people this booking is for.
   3. **This person has to pay to make max saving** — best card among the ticked people (site offers + curated list).
   4. **Who paid?** + booking ID → added to *that* trip, split only between the ticked people.

Notes: desktop browsers only (mobile would use share-to-GroupTrip). The total and offers are read from the page
best-effort — you can correct the amount. Only the SHA-256 of the pairing token is stored on the server.

import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The extension reads how many people a booking is for and whether its dates
 * fall in the trip. scan.js and advisor.js run here as they do in the browser.
 */

function scan(text: string, href = "https://www.makemytrip.com/review") {
  const window: Record<string, unknown> = {};
  const ctx = {
    window,
    location: { hostname: new URL(href).hostname, href },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ visibility: "visible", display: "block", textDecorationLine: "none", fontSize: "14px" }),
    document: { title: "Review your booking", body: { innerText: text }, createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] },
  };
  runInNewContext(readFileSync(path.resolve(__dirname, "../../extension/scan.js"), "utf8"), ctx);
  return (window.__groupTripScan as () => { travellers: number | null; pageText: string; url: string; title: string })();
}

function advisor() {
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(path.resolve(__dirname, "../../extension/advisor.js"), "utf8"), { window, chrome: {} });
  return window.GroupTripAdvisor as {
    dateCheck: (trip: Trip, trips: Trip[], scan: { title: string; url: string; pageText: string }) => { state: string; date?: string; other?: Trip };
  };
}
type Trip = { id: string; name: string; destination: string; startDate: string; endDate: string };

describe("extension: how many people is this booking for?", () => {
  it("reads adults + children and ignores infants", () => {
    expect(scan("Mumbai → Goa · 2 Adults, 1 Child, 1 Infant · Economy").travellers).toBe(3);
  });
  it("reads travellers / guests / passengers", () => {
    expect(scan("Fare summary for 4 Travellers").travellers).toBe(4);
    expect(scan("Villa Azul · 2 rooms · 5 guests").travellers).toBe(5);
    expect(scan("Base fare x 3 passengers").travellers).toBe(3);
  });
  it("prefers what the site put in the URL", () => {
    expect(scan("Review", "https://www.makemytrip.com/flight/review?paxType=A-2_C-1_I-0").travellers).toBe(3);
    expect(scan("Hotel", "https://www.booking.com/hotel/in/x.html?group_adults=4&group_children=0").travellers).toBe(4);
  });
  it("says it doesn't know rather than guessing", () => {
    expect(scan("Choose your seat · ₹4,200").travellers).toBeNull();
    expect(scan("Only 999 guests stayed here this year").travellers).toBeNull(); // not a plausible booking size
  });
});

describe("extension: are the booking dates in the trip?", () => {
  const goa: Trip = { id: "goa", name: "Goa with the gang", destination: "Candolim, Goa, India", startDate: "2026-10-11", endDate: "2026-10-15" };
  const sg: Trip = { id: "sg", name: "Singapore squad", destination: "Singapore", startDate: "2026-11-06", endDate: "2026-11-11" };
  const a = advisor();

  it("accepts dates inside the trip, or up to two days either side", () => {
    expect(a.dateCheck(goa, [goa, sg], { title: "", url: "", pageText: "Depart Sun, 11 Oct 2026" })).toMatchObject({ state: "ok", date: "2026-10-11" });
    expect(a.dateCheck(goa, [goa, sg], { title: "", url: "", pageText: "Check-in 9 Oct 2026" })).toMatchObject({ state: "ok" });
  });
  it("reads numeric dates from the URL (day/month/year)", () => {
    expect(a.dateCheck(goa, [goa, sg], { title: "", url: "https://x/flight?itinerary=BOM-GOI-12/10/2026", pageText: "" })).toMatchObject({ state: "ok", date: "2026-10-12" });
  });
  it("warns when the page is for other dates, and points to the trip that matches", () => {
    const r = a.dateCheck(goa, [goa, sg], { title: "", url: "", pageText: "Depart Sat, 7 Nov 2026" });
    expect(r.state).toBe("mismatch");
    expect(r.other?.id).toBe("sg");
    expect(a.dateCheck(goa, [goa], { title: "", url: "", pageText: "Depart 3 Dec 2026" })).toMatchObject({ state: "mismatch", other: undefined });
  });
  it("says so when there are no dates on the page", () => {
    expect(a.dateCheck(goa, [goa, sg], { title: "", url: "", pageText: "Add-ons and seats" }).state).toBe("unknown");
  });
});

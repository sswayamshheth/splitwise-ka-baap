import { GOA } from "./demo-goa";
import { depositToPool, payVendorFromPool, setPoolTarget } from "./pool";
import { reduceEvents } from "./reduce";
import type { LedgerEvent, TripState } from "./types";

/**
 * Pool activity on top of the Goa demo so the Money tab has something real to
 * show: a target, five deposits (Meera hasn't paid in yet — the funding gap),
 * and two vendors paid straight from the pool. Built with the same commands the
 * app uses, so every figure is derived and the ledger still balances.
 */
export function withDemoPool(events: LedgerEvent[], now = Date.now()): LedgerEvent[] {
  const out = [...events];
  const HOUR = 3_600_000;
  let t = now - 30 * HOUR;
  const ctx = () => ({ actor: GOA.aarav, now: (t += 37 * 60_000) });
  const push = (make: (s: TripState) => LedgerEvent) => out.push(make(reduceEvents(out) as TripState));
  const today = new Date(now).toISOString().slice(0, 10);

  push((s) => setPoolTarget(s, 60_000_00, ctx()));
  const deposits: [string, number, "upi" | "razorpay"][] = [
    [GOA.aarav, 12_000_00, "upi"],
    [GOA.rohan, 10_000_00, "razorpay"],
    [GOA.siya, 10_000_00, "upi"],
    [GOA.kavya, 8_000_00, "upi"],
    [GOA.dev, 10_000_00, "razorpay"],
  ];
  for (const [participantId, amountPaise, method] of deposits) {
    push((s) => depositToPool(s, { participantId, amountPaise, method, reference: method === "razorpay" ? "Demo checkout" : "UPI to organiser" }, ctx()));
  }
  const everyone = Object.values(GOA).map((participantId) => ({ participantId, weight: 1 }));
  push((s) =>
    payVendorFromPool(
      s,
      { title: "Scooter rentals · 3 days", vendor: "Candolim Bike Rentals", amountPaise: 9_000_00, date: today, category: "Local travel", participants: everyone, splitMode: "equal" },
      ctx(),
    ),
  );
  push((s) =>
    payVendorFromPool(
      s,
      { title: "Sunset cruise tickets", vendor: "Mandovi Cruises", amountPaise: 12_600_00, date: today, category: "Activity", participants: everyone, splitMode: "equal" },
      ctx(),
    ),
  );
  return out;
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { addParticipant, addPaymentMethod, createTrip } from "@/lib/ledger/commands";
import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { captureBooking, suggestForCheckout } from "@/lib/server/ext";
import { FileRepo } from "@/lib/server/file-repo";
import { setRepoForTests } from "@/lib/server/repo";

/** Browser extension: only the ticked people are considered, and only they share the booking. */

const TRIP = "trip_sg_ext";
const users = { A: "user_A", B: "user_B", C: "user_C" };
const ids: Record<string, string> = {};
let dir: string;
let r: FileRepo;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gtl-ext-"));
  r = new FileRepo(path.join(dir, "db.json"));
  setRepoForTests(r);
  const ctx = () => ({ actor: "system" as const, now: Date.now() });
  const events: LedgerEvent[] = [...createTrip({ name: "SG Squad", destination: "Singapore", startDate: "2026-11-02", endDate: "2026-11-07" }, ctx()).events];
  for (const n of ["A", "B", "C"]) {
    const e = addParticipant(reduceEvents(events)!, { name: `Member ${n}` }, ctx());
    events.push(e);
    if (e.type === "PARTICIPANT_ADDED") ids[n] = e.participant.id;
  }
  events.push(addPaymentMethod(reduceEvents(events)!, ids.A, { label: "SBI SimplyClick", bank: "SBI", kind: "credit-card", network: "Visa" }, ctx()));
  events.push(addPaymentMethod(reduceEvents(events)!, ids.C, { label: "HDFC Regalia", bank: "HDFC Bank", kind: "credit-card", network: "Visa" }, ctx()));
  events[0] = { ...events[0], trip: { ...(events[0] as Extract<LedgerEvent, { type: "TRIP_CREATED" }>).trip, id: TRIP } } as LedgerEvent;
  const now = Date.now();
  await r.createTrip(
    { id: TRIP, ownerId: users.A, name: "SG Squad", destination: "Singapore", startDate: "2026-11-02", endDate: "2026-11-07", status: "active", joinCode: "SGP123", createdAt: now, updatedAt: now },
    { tripId: TRIP, userId: users.A, participantId: ids.A, role: "owner", joinedAt: now },
    events,
  );
  await r.addMember({ tripId: TRIP, userId: users.B, participantId: ids.B, role: "member", joinedAt: now });
  await r.addMember({ tripId: TRIP, userId: users.C, participantId: ids.C, role: "member", joinedAt: now });
});
afterEach(() => {
  setRepoForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const page = { tripId: TRIP, host: "www.makemytrip.com", title: "Mumbai to Singapore flights", amountPaise: 40_000_00, offerTexts: ["Get 12% Instant Discount up to ₹5,000 on HDFC Bank Credit Cards. Min. booking value ₹10,000. Use code MMTHDFC"] };

describe("extension checkout advisor", () => {
  it("names the member whose card saves the most, from the page's own offer", async () => {
    const res = await suggestForCheckout(users.A, page);
    expect(res.best).toMatchObject({ memberId: ids.C, card: "HDFC Regalia", savingPaise: 4_800_00, source: "page", code: "MMTHDFC" });
  });

  it("only considers the people ticked for this payment", async () => {
    const res = await suggestForCheckout(users.A, { ...page, participantIds: [ids.A, ids.B] });
    expect(res.options.every((o) => o.memberId !== ids.C)).toBe(true);
    expect(res.best?.memberId).not.toBe(ids.C);
  });

  it("splits a booking only among as many people as it's for", async () => {
    await expect(captureBooking(users.A, { ...page, participantIds: [ids.A, ids.B, ids.C], pax: 2, payerId: ids.A })).rejects.toMatchObject({ status: 400 });
    const ok = await captureBooking(users.A, { ...page, participantIds: [ids.A, ids.C], pax: 2, payerId: ids.A });
    expect(ok).toMatchObject({ ok: true, sharedBy: 2 });
  });

  it("records the booking paid by the chosen payer and shared only by the ticked people", async () => {
    const cap = await captureBooking(users.A, { ...page, reference: "PNR123", participantIds: [ids.A, ids.C], payerId: ids.C, cardLabel: "HDFC Regalia" });
    expect(cap).toMatchObject({ ok: true, tripName: "SG Squad", sharedBy: 2, paidBy: "Member C" });
    const state = reduceEvents(await r.getEvents(TRIP))!;
    const exp = state.expenses.find((e) => e.id === cap.expenseId)!;
    expect(exp.payers).toEqual([{ participantId: ids.C, amountPaise: 40_000_00 }]);
    expect(exp.participants.map((p) => p.participantId).sort()).toEqual([ids.A, ids.C].sort());
    const bal = computeLedger(state).balances;
    const of = (id: string) => bal[id]?.netPaise ?? 0;
    expect(of(ids.B)).toBe(0); // B wasn't on this booking
    expect(of(ids.A)).toBe(-20_000_00);
    expect(of(ids.C)).toBe(20_000_00);
  });

  it("refuses trips the user isn't a member of", async () => {
    await expect(suggestForCheckout("user_stranger", page)).rejects.toMatchObject({ status: 403 });
  });
});

describe("demo trips for the extension", () => {
  it("the Singapore demo is an upcoming trip of four people who all have cards", async () => {
    const { buildSingaporeEvents } = await import("@/lib/ledger/demo-sg");
    const s = reduceEvents(buildSingaporeEvents(Date.now()))!;
    expect(s.trip.name).toBe("Singapore squad");
    expect(s.participants).toHaveLength(4);
    expect(s.participants.every((p) => (p.paymentMethods ?? []).length > 0)).toBe(true);
    expect(s.trip.startDate > new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

describe("demo pool", () => {
  it("gives the Goa demo a funded pool with vendor payments, and the ledger still balances", async () => {
    const { buildGoaEvents } = await import("@/lib/ledger/demo-goa");
    const { withDemoPool } = await import("@/lib/ledger/demo-pool");
    const { poolSummary, poolFunding } = await import("@/lib/ledger/pool");
    const s = reduceEvents(withDemoPool(buildGoaEvents(Date.now())))!;
    const pool = poolSummary(s);
    expect(pool.depositedPaise).toBe(50_000_00);
    expect(pool.spentPaise).toBe(21_600_00);
    expect(pool.availablePaise).toBe(28_400_00);
    expect(pool.vendorPayments).toHaveLength(2);
    expect(poolFunding(s)).toBeTruthy();
    expect(computeLedger(s).reconciliationPaise).toBe(0);
  });
});

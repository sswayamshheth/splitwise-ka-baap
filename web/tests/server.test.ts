import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { addExpense, addParticipant, createTrip } from "@/lib/ledger/commands";
import { buildGoaEvents, GOA } from "@/lib/ledger/demo-goa";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { FileRepo } from "@/lib/server/file-repo";
import { HttpError, phaseOf, summarise, validateAppend } from "@/lib/server/trips";

const dirs: string[] = [];
function freshRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "gtl-"));
  dirs.push(dir);
  return new FileRepo(path.join(dir, "db.json"));
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const member = { tripId: "trip_x", userId: "user_1", participantId: GOA.aarav, role: "owner" as const, joinedAt: 0 };

describe("file store", () => {
  it("rejects an append built on a stale log (optimistic concurrency)", async () => {
    const repo = freshRepo();
    const events = buildGoaEvents(Date.now());
    const now = Date.now();
    await repo.createTrip({ id: "trip_x", ownerId: "user_1", name: "Goa", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-14", status: "active", joinCode: "ABC123", createdAt: now, updatedAt: now }, member, events);
    const state = reduceEvents(events)!;
    const e1 = addParticipant(state, { name: "Zara" }, { actor: GOA.aarav });
    const first = await repo.appendEvents("trip_x", events.length, [e1]);
    expect(first).toEqual({ ok: true, seq: events.length + 1 });
    const e2 = addParticipant(state, { name: "Yusuf" }, { actor: GOA.aarav });
    const second = await repo.appendEvents("trip_x", events.length, [e2]);
    expect(second.ok).toBe(false);
    expect((await repo.getEvents("trip_x")).length).toBe(events.length + 1);
  });

  it("persists to disk and finds trips by join code, case-insensitively", async () => {
    const repo = freshRepo();
    const now = Date.now();
    await repo.createTrip({ id: "trip_y", ownerId: "user_1", name: "T", destination: "D", startDate: "2026-10-10", endDate: "2026-10-12", status: "active", joinCode: "QWE789", createdAt: now, updatedAt: now }, { ...member, tripId: "trip_y" }, []);
    expect((await repo.findTripByCode("qwe789"))?.id).toBe("trip_y");
    expect((await repo.listTripsForUser("user_1")).map((t) => t.trip.id)).toEqual(["trip_y"]);
    expect(await repo.listTripsForUser("user_2")).toEqual([]);
  });
});

describe("server-side validation of appended events", () => {
  const events = buildGoaEvents(new Date(2026, 8, 26, 12).getTime());
  const state = reduceEvents(events)!;

  it("stamps the authenticated member as the actor (the audit trail can't be spoofed)", () => {
    const e = addParticipant(state, { name: "Zara" }, { actor: GOA.rohan });
    const { events: out } = validateAppend(events, [e], member);
    expect(out[0].actor).toBe(GOA.aarav);
  });

  it("refuses events that would unbalance the ledger", () => {
    const good = addExpense(
      state,
      { title: "Chai", amountPaise: 300_00, date: "2026-10-10", category: "Food", payers: [{ participantId: GOA.aarav, amountPaise: 300_00 }], participants: [{ participantId: GOA.aarav, weight: 1 }], splitMode: "equal" },
      { actor: GOA.aarav },
    );
    // Tamper: payers no longer add up to the bill, so Σ balances ≠ 0.
    const bad = { ...good, expense: { ...(good as Extract<LedgerEvent, { type: "EXPENSE_ADDED" }>).expense, payers: [{ participantId: GOA.aarav, amountPaise: 999_00 }] } } as LedgerEvent;
    expect(() => validateAppend(events, [bad], member)).toThrow(HttpError);
    expect(() => validateAppend(events, [good], member)).not.toThrow();
  });

  it("refuses a second TRIP_CREATED, duplicates and empty batches", () => {
    const created = createTrip({ name: "X", destination: "Y", startDate: "2026-10-10", endDate: "2026-10-11" }, { actor: "system" }).events[0];
    expect(() => validateAppend(events, [created], member)).toThrow(/once/);
    expect(() => validateAppend(events, [events[3]], member)).toThrow(/Duplicate/);
    expect(() => validateAppend(events, [], member)).toThrow(/No events/);
  });
});

describe("trip summaries", () => {
  it("classifies trips by date and summarises my position from the ledger", () => {
    expect(phaseOf({ startDate: "2026-10-10", endDate: "2026-10-14", status: "active" }, "2026-09-26")).toBe("upcoming");
    expect(phaseOf({ startDate: "2026-09-20", endDate: "2026-09-30", status: "active" }, "2026-09-26")).toBe("ongoing");
    expect(phaseOf({ startDate: "2026-09-01", endDate: "2026-09-05", status: "active" }, "2026-09-26")).toBe("past");
    expect(phaseOf({ startDate: "2026-10-10", endDate: "2026-10-14", status: "closed" }, "2026-09-26")).toBe("past");

    const events = buildGoaEvents(new Date(2026, 8, 26, 12).getTime());
    const now = Date.now();
    const s = summarise({ id: "trip_x", ownerId: "user_1", name: "", destination: "", startDate: "", endDate: "", status: "active", joinCode: "A", createdAt: now, updatedAt: now }, member, events)!;
    expect(s.members).toBe(6);
    expect(s.myNetPaise).toBe(5_250_00);
    expect(s.spentPaise).toBe(99_000_00);
  });
});

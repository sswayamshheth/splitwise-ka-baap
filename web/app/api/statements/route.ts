import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import { repo } from "@/lib/server/repo";
import { phaseOf, requireUserId, route } from "@/lib/server/trips";

/**
 * My ledger across every trip: what I bore (my share of costs), what I
 * handed vendors, what I settled, and where each trip leaves me. Every figure
 * is re-derived from that trip's event log on each request.
 */
export const GET = route(async () => {
  const userId = await requireUserId();
  const r = await repo();
  const rows = await r.listTripsForUser(userId);
  const statements = [];
  for (const { trip, member } of rows) {
    const state = reduceEvents(await r.getEvents(trip.id));
    if (!state) continue;
    const ledger = computeLedger(state);
    const b = ledger.balances[member.participantId];
    if (!b) continue;
    const pid = member.participantId;
    const byCategory: Record<string, number> = {};
    const lines = [];
    for (const c of ledger.expenses) {
      const share = c.shares[pid] ?? 0;
      const paid = c.netPaidByPayer[pid] ?? 0;
      if (!share && !paid) continue;
      byCategory[c.expense.category] = (byCategory[c.expense.category] ?? 0) + share;
      lines.push({ expenseId: c.expense.id, title: c.expense.title, vendor: c.expense.vendor, category: c.expense.category, date: c.expense.date, status: c.expense.status, sharePaise: share, paidPaise: paid, fromPool: !!c.expense.fundedFromPool });
    }
    statements.push({
      tripId: trip.id,
      name: state.trip.name,
      destination: state.trip.destination,
      startDate: state.trip.startDate,
      endDate: state.trip.endDate,
      year: Number(state.trip.startDate.slice(0, 4)),
      phase: phaseOf(state.trip),
      sharePaise: b.sharePaise,
      paidPaise: b.paidPaise - b.refundsReceivedPaise,
      settledOutPaise: b.settledOutPaise,
      settledInPaise: b.settledInPaise,
      poolPaise: b.contributedPaise,
      netPaise: b.netPaise,
      byCategory,
      lines: lines.sort((a, z) => (a.date < z.date ? 1 : -1)),
    });
  }
  statements.sort((a, z) => (a.startDate < z.startDate ? 1 : -1));
  return NextResponse.json({ statements });
});

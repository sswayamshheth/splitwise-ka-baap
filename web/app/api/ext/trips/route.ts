import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { reduceEvents } from "@/lib/ledger/reduce";
import { requireExtensionUser } from "@/lib/server/ext";
import { repo } from "@/lib/server/repo";
import { route, summarise } from "@/lib/server/trips";

/** Trips for the paired extension user (non-closed first). */
export const GET = route(async (req: Request) => {
  const userId = await requireExtensionUser(req);
  const r = await repo();
  const rows = await r.listTripsForUser(userId);
  const trips = [];
  for (const { trip, member } of rows) {
    const events = await r.getEvents(trip.id);
    const t = summarise(trip, member, events);
    const state = reduceEvents(events);
    // Only trips a booking can still belong to: ongoing and upcoming.
    if (!t || !state || t.status === "closed" || t.phase === "past") continue;
    trips.push({
      id: t.id,
      name: t.name,
      destination: t.destination,
      startDate: t.startDate,
      endDate: t.endDate,
      phase: t.phase,
      members: state.participants
        .filter((p) => !p.leftOn)
        .map((p) => ({ id: p.id, name: p.name, isMe: p.id === member.participantId, cards: (p.paymentMethods ?? []).filter((m) => m.kind !== "netbanking").map((m) => m.label) })),
    });
  }
  trips.sort((a, b) => (a.phase === b.phase ? a.startDate.localeCompare(b.startDate) : a.phase === "ongoing" ? -1 : 1));
  return NextResponse.json({ trips });
});

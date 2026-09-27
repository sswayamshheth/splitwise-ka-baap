import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { reduceEvents } from "@/lib/ledger/reduce";
import { repo } from "@/lib/server/repo";
import { prefetchWorld } from "@/lib/server/world";
import { HttpError, loadTripForUser, requireUserId, route } from "@/lib/server/trips";

type Ctx = { params: { id: string } };

/** The whole trip: its event log (the client derives everything from it) plus who I am in it. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { trip, member, events } = await loadTripForUser(params.id, userId);
  const members = await (await repo()).listMembers(trip.id);
  // Warm the Digital Twin's live inputs (weather, places, signals) so the Plan tab finds them ready.
  const state = reduceEvents(events);
  if (state && state.trip.status !== "closed") prefetchWorld(trip.id, state);
  return NextResponse.json({
    trip: { id: trip.id, joinCode: trip.joinCode, ownerId: trip.ownerId },
    me: { participantId: member.participantId, role: member.role },
    // Which participants have an app account (the rest were added by name).
    claimed: members.map((m) => m.participantId),
    seq: events.length,
    events,
  });
});

/** Owners can delete a trip entirely. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { member } = await loadTripForUser(params.id, userId);
  if (member.role !== "owner") throw new HttpError(403, "Only the trip owner can delete it");
  await (await repo()).deleteTrip(params.id);
  return NextResponse.json({ ok: true });
});

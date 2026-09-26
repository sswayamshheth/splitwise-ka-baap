import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { buildGoaEvents, GOA_VIEWER_ID } from "@/lib/ledger/demo-goa";
import { withDemoPool } from "@/lib/ledger/demo-pool";
import { buildSingaporeEvents } from "@/lib/ledger/demo-sg";
import type { LedgerEvent } from "@/lib/ledger/types";
import { repo } from "@/lib/server/repo";
import { newJoinCode, requireProfile, route } from "@/lib/server/trips";

/**
 * Loads (or resets) the Goa demo trip into my account, with me as Aarav, the
 * organiser. It is a real trip in the store — a seeded event log — so every
 * screen, the what-if engine and the audit trail work on it normally.
 * Also loads an upcoming Singapore trip (four of the same people) so the
 * browser extension has to pick the right group for a booking.
 */
export const POST = route(async () => {
  const profile = await requireProfile();
  const r = await repo();
  // Each load is a new trip id: a trip sealed on-chain must never be silently
  // replaced under the same id (the blockchain proof would rightly call that tampering).
  const suffix = `${profile.userId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}_${Date.now().toString(36)}`;
  for (const { trip } of await r.listTripsForUser(profile.userId)) {
    if (trip.ownerId === profile.userId && /^trip_demo_(goa|sg)_/.test(trip.id)) await r.deleteTrip(trip.id);
  }
  const tripId = `trip_demo_goa_${suffix}`;
  const events = withDemoPool(buildGoaEvents(Date.now())).map((e) => (e.type === "TRIP_CREATED" ? { ...e, trip: { ...e.trip, id: tripId } } : e)) as LedgerEvent[];
  const created = events[0].type === "TRIP_CREATED" ? events[0].trip : null;
  const now = Date.now();
  await r.createTrip(
    {
      id: tripId,
      ownerId: profile.userId,
      name: created!.name,
      destination: created!.destination,
      startDate: created!.startDate,
      endDate: created!.endDate,
      status: "active",
      joinCode: await newJoinCode(),
      createdAt: now,
      updatedAt: now,
    },
    { tripId, userId: profile.userId, participantId: GOA_VIEWER_ID, role: "owner", joinedAt: now },
    events,
  );
  const sgId = `trip_demo_sg_${suffix}`;
  const sgEvents = buildSingaporeEvents(now).map((e) => (e.type === "TRIP_CREATED" ? { ...e, trip: { ...e.trip, id: sgId } } : e)) as LedgerEvent[];
  const sg = sgEvents[0].type === "TRIP_CREATED" ? sgEvents[0].trip : null;
  await r.createTrip(
    { id: sgId, ownerId: profile.userId, name: sg!.name, destination: sg!.destination, startDate: sg!.startDate, endDate: sg!.endDate, status: "active", joinCode: await newJoinCode(), createdAt: now, updatedAt: now },
    { tripId: sgId, userId: profile.userId, participantId: GOA_VIEWER_ID, role: "owner", joinedAt: now },
    sgEvents,
  );
  if (!(await r.getProfile(profile.userId))?.name) await r.upsertProfile({ ...profile, name: profile.name || "Aarav Shah" });
  return NextResponse.json({ tripId });
});

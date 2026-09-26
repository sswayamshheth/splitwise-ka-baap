import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { buildGoaEvents, GOA_VIEWER_ID } from "@/lib/ledger/demo-goa";
import type { LedgerEvent } from "@/lib/ledger/types";
import { repo } from "@/lib/server/repo";
import { newJoinCode, requireProfile, route } from "@/lib/server/trips";

/**
 * Loads (or resets) the Goa demo trip into my account, with me as Aarav, the
 * organiser. It is a real trip in the store — a seeded event log — so every
 * screen, the what-if engine and the audit trail work on it normally.
 */
export const POST = route(async () => {
  const profile = await requireProfile();
  const r = await repo();
  const tripId = `trip_demo_goa_${profile.userId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`;
  if (await r.getTrip(tripId)) await r.deleteTrip(tripId);
  const events = buildGoaEvents(Date.now()).map((e) => (e.type === "TRIP_CREATED" ? { ...e, trip: { ...e.trip, id: tripId } } : e)) as LedgerEvent[];
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
  if (!(await r.getProfile(profile.userId))?.name) await r.upsertProfile({ ...profile, name: profile.name || "Aarav Shah" });
  return NextResponse.json({ tripId });
});

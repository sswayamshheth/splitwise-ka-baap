import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { repo } from "@/lib/server/repo";
import { HttpError, newJoinCode, requireProfile, requireUserId, route, summarise } from "@/lib/server/trips";

/** My trips, each summarised from its own ledger. */
export const GET = route(async () => {
  const userId = await requireUserId();
  const r = await repo();
  const rows = await r.listTripsForUser(userId);
  const trips = (await Promise.all(rows.map(async ({ trip, member }) => summarise(trip, member, await r.getEvents(trip.id))))).filter(Boolean);
  return NextResponse.json({ trips });
});

/**
 * Create a trip. The client builds the initial events with the ledger
 * commands (trip, members, budget items); the server checks them, assigns a
 * join code and makes the creator the owner.
 */
export const POST = route(async (req: Request) => {
  const profile = await requireProfile();
  const body = (await req.json().catch(() => null)) as { events?: LedgerEvent[]; selfParticipantId?: string } | null;
  const events = body?.events;
  if (!Array.isArray(events) || events.length === 0 || events[0]?.type !== "TRIP_CREATED") throw new HttpError(400, "A new trip must start with its details");
  if (events.length > 200) throw new HttpError(400, "Too many items in one go");
  if (events.slice(1).some((e) => e.type === "TRIP_CREATED")) throw new HttpError(400, "A trip can only be created once");
  const tripId = events[0].trip.id;
  if (typeof tripId !== "string" || !/^trip_[A-Za-z0-9_-]{4,64}$/.test(tripId)) throw new HttpError(400, "Invalid trip id");

  const selfId = body?.selfParticipantId;
  const stamped = events.map((e) => ({ ...e, actor: selfId ?? "system" })) as LedgerEvent[];
  const state = reduceEvents(stamped);
  if (!state) throw new HttpError(400, "Those trip details don't form a valid trip");
  if (!selfId || !state.participants.some((p) => p.id === selfId)) throw new HttpError(400, "You must be one of the trip's members");
  if (computeLedger(state).reconciliationPaise !== 0) throw new HttpError(422, "Rejected: the ledger would not balance");

  const r = await repo();
  if (await r.getTrip(tripId)) throw new HttpError(409, "That trip already exists");
  const now = Date.now();
  const joinCode = await newJoinCode();
  await r.upsertProfile({ ...profile, name: profile.name || state.participants.find((p) => p.id === selfId)!.name });
  await r.createTrip(
    {
      id: tripId,
      ownerId: profile.userId,
      name: state.trip.name,
      destination: state.trip.destination,
      startDate: state.trip.startDate,
      endDate: state.trip.endDate,
      status: state.trip.status,
      joinCode,
      createdAt: now,
      updatedAt: now,
    },
    { tripId, userId: profile.userId, participantId: selfId, role: "owner", joinedAt: now },
    stamped,
  );
  return NextResponse.json({ tripId, joinCode }, { status: 201 });
});

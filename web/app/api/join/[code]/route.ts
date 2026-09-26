import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { addParticipant, CommandError } from "@/lib/ledger/commands";
import { reduceEvents } from "@/lib/ledger/reduce";
import { repo } from "@/lib/server/repo";
import { HttpError, requireProfile, route, syncTripRow, validateAppend } from "@/lib/server/trips";

type Ctx = { params: { code: string } };

/** Public preview behind an invite link / code: enough to decide, nothing financial. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const r = await repo();
  const trip = await r.findTripByCode(params.code);
  if (!trip) throw new HttpError(404, "That invite code doesn't match a trip");
  const state = reduceEvents(await r.getEvents(trip.id));
  if (!state) throw new HttpError(404, "Trip not found");
  const claimed = new Set((await r.listMembers(trip.id)).map((m) => m.participantId));
  return NextResponse.json({
    trip: { name: state.trip.name, destination: state.trip.destination, startDate: state.trip.startDate, endDate: state.trip.endDate, status: state.trip.status },
    members: state.participants.filter((p) => !p.leftOn).map((p) => ({ id: p.id, name: p.name, claimed: claimed.has(p.id) })),
  });
});

/**
 * Join a trip. Either claim a member the organiser already added by name
 * ("I'm Rohan") or join as a new member. Joining as new appends a real
 * PARTICIPANT_ADDED event, so it shows up in the audit trail.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const profile = await requireProfile();
  const r = await repo();
  const trip = await r.findTripByCode(params.code);
  if (!trip) throw new HttpError(404, "That invite code doesn't match a trip");
  const existing = await r.getMember(trip.id, profile.userId);
  if (existing) return NextResponse.json({ tripId: trip.id, participantId: existing.participantId, already: true });

  const body = (await req.json().catch(() => ({}))) as { claimParticipantId?: string; name?: string };
  const events = await r.getEvents(trip.id);
  const state = reduceEvents(events);
  if (!state) throw new HttpError(404, "Trip not found");
  if (state.trip.status === "closed") throw new HttpError(409, "This trip is closed");
  const now = Date.now();

  if (body.claimParticipantId) {
    const p = state.participants.find((x) => x.id === body.claimParticipantId && !x.leftOn);
    if (!p) throw new HttpError(404, "That member isn't on the trip");
    const claimed = (await r.listMembers(trip.id)).some((m) => m.participantId === p.id);
    if (claimed) throw new HttpError(409, `${p.name} has already been claimed by someone`);
    await r.addMember({ tripId: trip.id, userId: profile.userId, participantId: p.id, role: "member", joinedAt: now });
    return NextResponse.json({ tripId: trip.id, participantId: p.id });
  }

  const name = (body.name ?? profile.name ?? "").trim();
  if (!name) throw new HttpError(400, "Tell us your name first");
  let event;
  try {
    event = addParticipant(state, { name, phone: profile.phone?.replace(/^\+91/, ""), upiId: profile.upiId }, { actor: "system", now });
  } catch (error) {
    throw new HttpError(400, error instanceof CommandError ? error.message : "Could not join");
  }
  if (event.type !== "PARTICIPANT_ADDED") throw new HttpError(500, "Could not join");
  const pid = event.participant.id;
  const { events: stamped, state: next } = validateAppend(events, [event], { tripId: trip.id, userId: profile.userId, participantId: pid, role: "member", joinedAt: now });
  const result = await r.appendEvents(trip.id, events.length, stamped);
  if (!result.ok) throw new HttpError(409, "The trip changed — try again");
  await r.addMember({ tripId: trip.id, userId: profile.userId, participantId: pid, role: "member", joinedAt: now });
  await syncTripRow(trip.id, next);
  return NextResponse.json({ tripId: trip.id, participantId: pid });
});

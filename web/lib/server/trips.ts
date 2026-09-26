import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent, TripState } from "@/lib/ledger/types";
import { todayIso } from "@/lib/dates";
import { repo, type MemberRow, type Profile, type TripRow } from "./repo";

/** Thrown inside handlers; `route()` turns it into a JSON response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Wraps a route handler: JSON errors, never a stack trace to the client. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof HttpError) return NextResponse.json({ error: error.message, ...error.extra }, { status: error.status });
      console.error("[api]", error);
      return NextResponse.json({ error: "Something went wrong on our side" }, { status: 500 });
    }
  };
}

export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "Sign in first");
  return userId;
}

/** The signed-in user's profile, created from their Clerk account on first use. */
export async function requireProfile(): Promise<Profile> {
  const userId = await requireUserId();
  const r = await repo();
  const existing = await r.getProfile(userId);
  if (existing?.email) return existing;
  // The login identity (verified email, and phone for Pro accounts) comes from Clerk.
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? undefined;
  const phone = user?.primaryPhoneNumber?.phoneNumber ?? undefined;
  if (existing) return { ...existing, email, phone: existing.phone ?? phone };
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return { userId, name, email, phone, createdAt: Date.now() };
}

export async function loadTripForUser(tripId: string, userId: string) {
  const r = await repo();
  const trip = await r.getTrip(tripId);
  if (!trip) throw new HttpError(404, "Trip not found");
  const member = await r.getMember(tripId, userId);
  if (!member) throw new HttpError(403, "You are not a member of this trip");
  const events = await r.getEvents(tripId);
  return { trip, member, events };
}

/**
 * Server-side check of events a client wants to append. The client builds
 * them with the same validated commands; the server re-derives the whole trip
 * and refuses anything that breaks the ledger's invariants. The actor on
 * every event is stamped from the authenticated member, so the audit trail
 * can't be spoofed.
 */
export function validateAppend(existing: LedgerEvent[], incoming: unknown, member: MemberRow): { events: LedgerEvent[]; state: TripState } {
  if (!Array.isArray(incoming) || incoming.length === 0) throw new HttpError(400, "No events to append");
  if (incoming.length > 50) throw new HttpError(400, "Too many events in one request");
  const seen = new Set(existing.map((e) => e.id));
  const events = incoming.map((raw, i) => {
    const e = raw as LedgerEvent;
    if (!e || typeof e !== "object" || typeof e.type !== "string" || typeof e.id !== "string") throw new HttpError(400, `Event ${i + 1} is malformed`);
    if (e.type === "TRIP_CREATED") throw new HttpError(400, "A trip can only be created once");
    if (seen.has(e.id)) throw new HttpError(400, `Duplicate event id ${e.id}`);
    seen.add(e.id);
    return { ...e, actor: member.participantId, ts: Number.isFinite(e.ts) ? e.ts : Date.now() } as LedgerEvent;
  });
  const state = reduceEvents([...existing, ...events]);
  if (!state) throw new HttpError(400, "These changes don't apply to this trip");
  const ledger = computeLedger(state);
  if (ledger.reconciliationPaise !== 0) throw new HttpError(422, "Rejected: the ledger would no longer balance");
  return { events, state };
}

export type TripPhase = "ongoing" | "upcoming" | "past";

export function phaseOf(trip: Pick<TripRow, "startDate" | "endDate" | "status">, today = todayIso()): TripPhase {
  if (trip.status === "closed" || trip.endDate < today) return "past";
  if (trip.startDate > today) return "upcoming";
  return "ongoing";
}

export type TripSummary = {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: "active" | "closed";
  phase: TripPhase;
  role: "owner" | "member";
  members: number;
  plannedPaise: number;
  spentPaise: number;
  /** My share of costs so far. */
  mySharePaise: number;
  /** Money I handed vendors (net of refunds I received). */
  myPaidPaise: number;
  /** + I'm owed, − I owe. */
  myNetPaise: number;
  poolPaise: number;
  updatedAt: number;
};

export function summarise(trip: TripRow, member: MemberRow, events: LedgerEvent[]): TripSummary | null {
  const state = reduceEvents(events);
  if (!state) return null;
  const ledger = computeLedger(state);
  const me = ledger.balances[member.participantId];
  return {
    id: trip.id,
    name: state.trip.name,
    destination: state.trip.destination,
    startDate: state.trip.startDate,
    endDate: state.trip.endDate,
    status: state.trip.status,
    phase: phaseOf(state.trip),
    role: member.role,
    members: state.participants.filter((p) => !p.leftOn).length,
    plannedPaise: ledger.budget.estimatedPaise,
    spentPaise: ledger.totals.spendPaise,
    mySharePaise: me?.sharePaise ?? 0,
    myPaidPaise: (me?.paidPaise ?? 0) - (me?.refundsReceivedPaise ?? 0),
    myNetPaise: me?.netPaise ?? 0,
    poolPaise: ledger.totals.contributionsPaise,
    updatedAt: events.length ? events[events.length - 1].ts : trip.updatedAt,
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function newJoinCode(): Promise<string> {
  const r = await repo();
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!(await r.findTripByCode(code))) return code;
  }
  throw new HttpError(500, "Could not allocate a join code");
}

/** Keeps the trip row (used for lists and join lookups) in step with the log. */
export async function syncTripRow(tripId: string, state: TripState) {
  await (await repo()).updateTrip(tripId, {
    name: state.trip.name,
    destination: state.trip.destination,
    startDate: state.trip.startDate,
    endDate: state.trip.endDate,
    status: state.trip.status,
    updatedAt: Date.now(),
  });
}

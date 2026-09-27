import "server-only";

import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent, TripState } from "@/lib/ledger/types";
import { adaptToWeather, type InferenceMeta } from "@/lib/nugen/intelligence";
import type { Scenario } from "@/lib/twin/scenario";
import { buildTwin, type Twin, type TwinWorld } from "@/lib/twin/twin";
import { HttpError, loadTripForUser, requireUserId } from "./trips";
import { buildWorld, loadReplay } from "./world";

/**
 * One place that runs the Digital Twin pipeline for an API route:
 *   real inputs (world) → deterministic twin → GroupTrip Intelligence picks
 *   (validated against the twin's own shortlist) → twin rebuilt with the picks.
 * The real trip's event log is only read.
 */

export type WorldMode = "live" | "replay";

export async function loadTripContext(tripId: string) {
  const userId = await requireUserId();
  const { events } = await loadTripForUser(tripId, userId);
  const state = reduceEvents(events);
  if (!state) throw new HttpError(500, "Trip ledger is unreadable");
  return { events, state };
}

export async function worldFor(tripId: string, state: TripState, mode: WorldMode, force = false): Promise<TwinWorld> {
  if (mode === "replay") {
    const replay = await loadReplay(state.trip.destination, tripId);
    if (!replay) throw new HttpError(404, `No recorded capture for ${state.trip.destination} yet. Load the live view once while online to record one.`);
    return replay;
  }
  try {
    return await buildWorld(tripId, state, { force });
  } catch (e) {
    throw new HttpError(502, (e as Error).message);
  }
}

export async function twinWithIntelligence(state: TripState, events: LedgerEvent[], world: TwinWorld, scenario: Scenario | null): Promise<{ twin: Twin; adaptation: InferenceMeta | null }> {
  const now = Date.now();
  const first = buildTwin(state, events, world, scenario, { now });
  const affected = Object.keys(first.shortlists).filter((k) => first.shortlists[k].length);
  if (!affected.length) return { twin: first, adaptation: null };
  const members = state.participants.filter((p) => !p.leftOn);
  const { picks, meta } = await adaptToWeather({
    trip: { destination: state.trip.destination, dates: `${state.trip.startDate}..${state.trip.endDate}` },
    affected: affected.map((id) => {
      const t = first.items.find((x) => x.id === id)!;
      return { itemId: id, title: t.title, date: t.date, impactScore: t.assessment.impactScore, drivers: t.assessment.drivers, going: t.participantIds.map((p) => members.find((m) => m.id === p)?.name.split(" ")[0] ?? p) };
    }),
    shortlist: Object.fromEntries(affected.map((id) => [id, first.shortlists[id]])),
    signals: world.signals.slice(0, 8).map((s) => `[${s.source}] ${s.summary}`),
    preferences: Object.fromEntries(members.map((m) => [m.name.split(" ")[0], m.interests?.activities ?? []])),
  });
  if (!picks) return { twin: first, adaptation: meta };
  const twin = buildTwin(state, events, world, scenario, { now, nugenPicks: Object.fromEntries(picks.map((p) => [p.itemId, p.candidateId])) });
  return { twin, adaptation: meta };
}

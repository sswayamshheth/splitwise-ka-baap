import type { LedgerEvent, ParticipantData, TripMeta } from "./types";
import { buildGoaEvents, GOA } from "./demo-goa";

/**
 * A second, upcoming demo trip so the browser extension has to pick the right
 * group: four of the Goa gang (no Kavya, no Meera) going to Singapore later.
 * Nothing is booked yet, so the first booking made on MakeMyTrip lands here.
 */
const DAY = 24 * 3_600_000;
export const SG_START_OFFSET = 40;

export function buildSingaporeEvents(now = Date.now()): LedgerEvent[] {
  const iso = (days: number) => {
    const d = new Date(now + days * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const goaPeople = buildGoaEvents(now).flatMap((e) => (e.type === "PARTICIPANT_ADDED" ? [e.participant] : []));
  const going: string[] = [GOA.aarav, GOA.rohan, GOA.siya, GOA.dev];
  const people: ParticipantData[] = goaPeople.filter((p) => going.includes(p.id));
  const trip: TripMeta = {
    id: "trip_demo_sg",
    name: "Singapore squad",
    destination: "Singapore",
    place: { lat: 1.28967, lon: 103.85007, name: "Singapore", country: "Singapore", source: "open-meteo-geocoding" },
    startDate: iso(SG_START_OFFSET),
    endDate: iso(SG_START_OFFSET + 5),
    currency: "INR",
    status: "active",
    description: "Four of us, five nights. Flights and hotel still to book.",
    budgetPaise: 3_20_000_00,
  };
  const t0 = now - 3 * DAY;
  let seq = 0;
  const ev = (ts: number, body: object) => ({ id: `sg_ev_${String(++seq).padStart(3, "0")}`, ts, actor: GOA.aarav, ...body }) as LedgerEvent;
  return [ev(t0, { type: "TRIP_CREATED", trip }), ...people.map((participant, i) => ev(t0 + (i + 1) * 60_000, { type: "PARTICIPANT_ADDED", participant }))];
}

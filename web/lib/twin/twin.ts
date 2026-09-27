import { itemTags } from "@/lib/interests";
import { previewCancellation } from "@/lib/ledger/commands";
import { simulate, describeChange, type Change } from "@/lib/ledger/simulate";
import type { ItineraryItem, LedgerEvent, ParticipantId, TripState } from "@/lib/ledger/types";
import { formatMoney, type Paise } from "@/lib/money";
import { openAt, type Candidate } from "@/lib/signals/osm";
import { ratingScore } from "@/lib/signals/score";
import type { PlaceRatings, ProviderStatus, PublicSignal } from "@/lib/signals/types";
import { dayFor, describeWeatherCode, distanceKm, type Forecast, type LatLon, type WeatherDay } from "@/lib/weather/openmeteo";
import { assess, betterSlot, imdCategory, PROFILE_LABEL, slotsFor, type Assessment, type Conditions, type Level, type Profile, type ScoreComponent, type Slot } from "./impact";
import { isEmptyScenario, simulatedDay, type Scenario } from "./scenario";

/**
 * The trip's Digital Twin: a structured model of the trip ecosystem — places,
 * itinerary items, bookings, members, movement between places — with the
 * weather (real or simulated) and public signals flowing through it.
 *
 * Everything here is deterministic. Money consequences come from the ledger's
 * own what-if engine (`simulate`) run on a copy of the event log, so the twin
 * can never write to, or disagree with, the real trip.
 */

// ---------------------------------------------------------------- world (fetched real inputs)

export type PlacePin = LatLon & { label: string; precision: "item" | "destination"; source: string };

export type WorldForecast = { key: string; point: LatLon; label: string; forecast: Forecast | null; error?: string };

export type TwinWorld = {
  tripId: string;
  /** "live": fetched now. "replay": a recorded capture of real API responses (judge demo mode). */
  mode: "live" | "replay";
  fetchedAt: number;
  capturedAt?: number;
  destination: PlacePin;
  places: Record<string, PlacePin>;
  forecasts: WorldForecast[];
  itemForecast: Record<string, string>;
  signals: PublicSignal[];
  providers: ProviderStatus[];
  candidates: Candidate[];
  ratings: Record<string, PlaceRatings>;
  weatherNote: string;
};

// ---------------------------------------------------------------- twin output

export type TwinItem = {
  id: string;
  title: string;
  date: string;
  time?: string;
  category: ItineraryItem["category"];
  profile: Profile;
  place: PlacePin;
  paid: boolean;
  expenseId?: string;
  participantIds: ParticipantId[];
  estimatedPaise: Paise;
  conditions: { source: Conditions["source"]; day: WeatherDay | null; forecastKey: string };
  assessment: Assessment;
  /** Forced by the scenario (activity closed, hotel removed). */
  forcedUnavailable?: string;
  slots: Slot[];
  bestSlot: Slot | null;
  movement: { fromStayKm: number | null; minutesNormal: number | null; minutesNow: number | null; status: "ok" | "slow" | "disrupted" };
};

export type Effect = { id: string; kind: "direct" | "cascading" | "secondary"; itemId?: string; causeId?: string; text: string; level: Level };

export type Evidence = { icon: string; label: string; text: string; source?: string; url?: string };

export type Recommendation = {
  id: string;
  forItemId: string;
  forTitle: string;
  kind: "replace" | "reschedule";
  alternative?: { candidate: Candidate; distanceKm: number; estTotalPaise: Paise; ratings?: PlaceRatings };
  newTime?: string;
  /** 0 … 100 */
  score: number;
  breakdown: ScoreComponent[];
  evidence: Evidence[];
  rationale: string;
  chosenBy: "deterministic" | "nugen";
  changes: Change[];
  finance?: FinanceSummary;
  chain: string[];
};

export type FinanceSummary = {
  ok: boolean;
  error?: string;
  plannedBefore: Paise;
  plannedAfter: Paise;
  spendBefore: Paise;
  spendAfter: Paise;
  refunds: { amountPaise: Paise; to: string; expense: string }[];
  people: { id: string; name: string; before: Paise; after: Paise; delta: Paise }[];
  lines: string[];
};

export type Twin = {
  mode: "real" | "simulated";
  scenario: Scenario | null;
  generatedAt: number;
  worldMode: TwinWorld["mode"];
  days: string[];
  items: TwinItem[];
  effects: Effect[];
  recommendations: Recommendation[];
  headline: { title: string; detail: string; level: Level; date?: string; itemId?: string; normal: boolean };
  paths: { date: string; real: PathPoint[]; twin: PathPoint[] }[];
  participants: { id: string; name: string; available: boolean; reason?: string }[];
  finance: FinanceSummary | null;
  newsPressure: number;
  /** Top-5 ranked alternatives per affected item — what GroupTrip Intelligence chooses from. */
  shortlists: Record<string, ShortlistEntry[]>;
};

export type ShortlistEntry = { candidateId: string; name: string; kind: string; indoor: boolean; km: number; engineScore: number; rating?: number; reviews?: number; groupLikes: string };

export type PathPoint = LatLon & { itemId: string; title: string; alt?: boolean };

// ---------------------------------------------------------------- helpers

const first = (n: string) => n.split(" ")[0];
const isoAdd = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const todayIn = (now: number) => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);

function tripDays(state: TripState): string[] {
  const out: string[] = [];
  for (let d = state.trip.startDate; d <= state.trip.endDate && out.length < 60; d = isoAdd(d, 1)) out.push(d);
  return out;
}

/** Days an item occupies (stays span nights). */
function daysOf(item: ItineraryItem): string[] {
  if (!item.endDate || item.endDate <= item.date) return [item.date];
  const out: string[] = [];
  for (let d = item.date; d < item.endDate && out.length < 30; d = isoAdd(d, 1)) out.push(d);
  return out;
}

/** Rain-driven road speed factor (1 = normal). */
function speedFactor(day: WeatherDay | null): number {
  if (!day) return 1;
  const mm = day.precipitationMm;
  return mm < 15.6 ? 1 : mm < 64.5 ? 0.8 : mm < 115.6 ? 0.6 : 0.45;
}

function candidateProfile(c: Candidate): Profile {
  if (c.indoor) return "indoor";
  if (c.kind === "water_park" || c.kind === "theme_park") return "outdoor-adventure";
  if (c.kind === "viewpoint") return "outdoor-nature";
  return "outdoor-leisure";
}

function categoryFor(c: Candidate): ItineraryItem["category"] {
  if (c.tags.includes("food")) return "Food";
  if (c.tags.includes("shopping")) return "Shopping";
  return "Activity";
}

/** How strongly recent, relevant public reports talk about bad weather (0…1). */
export function newsPressureOf(signals: PublicSignal[], now: number): number {
  const recent = signals.filter((s) => (s.kind === "news" || s.kind === "social-post") && s.timestamp && now - s.timestamp < 3 * 86_400_000 && (s.weatherTerms?.length ?? 0) > 0);
  if (!recent.length) return 0;
  const weight = recent.reduce((a, s) => a + s.relevance * s.confidence * (s.sentiment !== undefined && s.sentiment < 0 ? 1 : 0.5), 0);
  return Math.round(Math.min(1, weight / 2) * 100) / 100;
}

// ---------------------------------------------------------------- build

export type BuildOpts = { now: number; nugenPicks?: Record<string, string> };

export function buildTwin(state: TripState, events: LedgerEvent[], world: TwinWorld, scenario: Scenario | null, opts: BuildOpts): Twin {
  const now = opts.now;
  const today = todayIn(now);
  const simulatedMode = !!scenario && !isEmptyScenario(scenario);
  const days = tripDays(state);
  const members = state.participants.filter((p) => !p.leftOn);
  const skipping = new Set(simulatedMode ? scenario!.skippingParticipantIds : []);
  const name = (id: string) => state.participants.find((p) => p.id === id)?.name ?? "Former member";
  const newsPressure = newsPressureOf(world.signals, now);

  const forecastByKey = new Map(world.forecasts.map((f) => [f.key, f]));
  const destKey = world.forecasts[0]?.key;
  const live = state.itinerary.filter((i) => i.status !== "cancelled" && !(i.expenseIds.length && i.expenseIds.every((id) => state.expenses.find((e) => e.id === id)?.status === "cancelled")));
  const stayItem = live.find((i) => i.category === "Stay");
  const stayPin = stayItem ? world.places[stayItem.id] : undefined;
  const origin: LatLon = stayPin ?? world.destination;

  // The area a simulated weather change applies to.
  const inArea = (pin: LatLon) => {
    if (!simulatedMode || !scenario!.area || scenario!.area.kind === "trip") return true;
    const centre = world.places[scenario!.area.itemId] ?? world.destination;
    return distanceKm(centre, pin) <= scenario!.area.radiusKm;
  };

  const conditionsFor = (item: ItineraryItem, date: string, pin: PlacePin): { c: Conditions; key: string } => {
    const key = world.itemForecast[item.id] ?? destKey ?? "";
    // If this location's forecast failed, fall back to the destination's rather than showing "no data".
    const f = forecastByKey.get(key)?.forecast ?? (destKey ? forecastByKey.get(destKey)?.forecast : null) ?? null;
    const real = f ? dayFor(f, date) : null;
    const leadDays = Math.max(0, dayDiff(today, date));
    if (simulatedMode && inArea(pin)) {
      const nearest = f?.daily.length ? (real ?? f.daily[f.daily.length - 1]) : null;
      const sim = simulatedDay(real, date, scenario!, nearest);
      if (sim) return { c: { source: "simulated", day: sim, leadDays }, key };
    }
    return { c: { source: real ? "live-forecast" : "no-data", day: real, leadDays }, key };
  };

  // ------------------------------------------------------------ items
  const items: TwinItem[] = live.map((item) => {
    const place = world.places[item.id] ?? world.destination;
    const { c, key } = conditionsFor(item, item.date, place);
    let assessment = assess(item, c, newsPressure);
    let forcedUnavailable: string | undefined;
    if (simulatedMode && scenario!.unavailableItemIds.includes(item.id)) forcedUnavailable = "Marked unavailable in this scenario";
    if (simulatedMode && scenario!.hotelRemoved && item.category === "Stay") forcedUnavailable = "Hotel removed in this scenario";
    if (forcedUnavailable) assessment = { ...assessment, availability: "unavailable", suitability: 0, impactScore: 100, level: "High", drivers: [forcedUnavailable, ...assessment.drivers] };
    const slots = forcedUnavailable ? [] : slotsFor(item, c);
    const km = item.category === "Stay" || item.category === "Transport" ? null : Math.round(distanceKm(origin, place) * 10) / 10;
    const factor = speedFactor(c.day);
    const minutesNormal = km === null ? null : Math.round((km * 1.3 * 60) / 32);
    const expense = state.expenses.find((e) => item.expenseIds.includes(e.id) && e.status === "active");
    return {
      id: item.id,
      title: item.title,
      date: item.date,
      time: item.time,
      category: item.category,
      profile: assessment.profile,
      place,
      paid: !!expense,
      expenseId: expense?.id,
      participantIds: item.participantIds,
      estimatedPaise: item.estimatedPaise,
      conditions: { source: c.source, day: c.day, forecastKey: key },
      assessment,
      forcedUnavailable,
      slots,
      bestSlot: forcedUnavailable ? null : betterSlot(slots, assessment),
      movement: { fromStayKm: km, minutesNormal, minutesNow: minutesNormal === null ? null : Math.round(minutesNormal / factor), status: factor >= 1 ? "ok" : factor >= 0.6 ? "slow" : "disrupted" },
    };
  });

  // ------------------------------------------------------------ effects
  const effects: Effect[] = [];
  let seq = 0;
  const push = (e: Omit<Effect, "id">) => {
    const id = `fx${++seq}`;
    effects.push({ ...e, id });
    return id;
  };
  for (const t of items) {
    const a = t.assessment;
    if (a.availability === "open" || a.availability === "unknown") continue;
    const direct = push({ kind: "direct", itemId: t.id, level: a.level, text: `${t.title}: ${a.availability === "unavailable" ? "unavailable" : "at risk"} — ${a.drivers[0]}` });
    if (t.paid && t.expenseId) {
      try {
        const p = previewCancellation(state, t.expenseId, undefined, today);
        push({ kind: "cascading", itemId: t.id, causeId: direct, level: a.level, text: `Booking consequence: cancelling ${t.title} today returns ${p.refundPercent}% under the vendor's policy — ${formatMoney(p.recoverablePaise)} back, ${formatMoney(p.lossPaise)} lost (ledger preview)` });
      } catch {
        /* expense changed under us: skip the line rather than guess */
      }
    } else {
      push({ kind: "cascading", itemId: t.id, causeId: direct, level: "Low", text: `Not paid yet — ${t.title} can be swapped with no money lost (${formatMoney(t.estimatedPaise)} estimate freed)` });
    }
    if (t.profile === "two-wheeler") {
      const riders = t.participantIds.map((id) => first(name(id)));
      const sameDay = items.filter((o) => o.id !== t.id && o.date === t.date && o.movement.fromStayKm !== null);
      push({ kind: "cascading", itemId: t.id, causeId: direct, level: a.level, text: `Movement: ${riders.join(", ")} lose scooter access on ${t.date}${sameDay.length ? ` — ${sameDay.map((o) => o.title).join(", ")} need a cab instead` : ""}` });
    }
    if (t.profile === "air") {
      const sameDay = items.filter((o) => o.id !== t.id && o.date === t.date);
      push({ kind: "cascading", itemId: t.id, causeId: direct, level: "Medium", text: `Arrival delay risk ripples to ${sameDay.map((o) => o.title).join(", ") || "the rest of the day"}` });
    }
    if ((t.profile === "sea-water" || t.profile === "river-water") && t.conditions.day && t.conditions.day.precipitationMm >= 64.5) {
      push({ kind: "secondary", itemId: t.id, causeId: direct, level: "Medium", text: `After ${imdCategory(t.conditions.day.precipitationMm)}, sea/river conditions usually stay rough into ${isoAdd(t.date, 1)} — water plans the next day are also exposed` });
    }
  }
  for (const t of items) {
    if (t.movement.status !== "ok" && t.movement.minutesNormal !== null && t.movement.minutesNow !== null && (t.movement.fromStayKm ?? 0) >= 8) {
      push({ kind: "cascading", itemId: t.id, level: t.movement.status === "disrupted" ? "High" : "Medium", text: `Travel: ${t.title} is ${t.movement.fromStayKm} km from the stay — about ${t.movement.minutesNormal} min normally, ~${t.movement.minutesNow} min in this rain` });
    }
  }
  // Secondary: traveller behaviour from the group's real preferences.
  const hit = items.filter((t) => t.assessment.availability !== "open" && t.assessment.availability !== "unknown");
  if (hit.length) {
    const hitTags = new Set(hit.flatMap((t) => itemTags(t)));
    const disappointed = members.filter((m) => m.interests?.activities.some((a) => hitTags.has(a)));
    const fine = members.filter((m) => m.interests?.activities.some((a) => a === "indoor" || a === "relaxing" || a === "culture" || a === "food"));
    if (disappointed.length) push({ kind: "secondary", level: "Medium", text: `Traveller behaviour: ${disappointed.map((m) => first(m.name)).join(", ")} list ${[...hitTags].filter((t) => disappointed.some((m) => m.interests?.activities.includes(t))).join("/")} among their interests — expect demand for a like-for-like swap` });
    if (fine.length) push({ kind: "secondary", level: "Low", text: `${fine.map((m) => first(m.name)).join(", ")} also enjoy indoor / culture / food plans — a covered alternative keeps them happy` });
  }
  const hot = items.filter((t) => (t.conditions.day?.tempMaxC ?? 0) >= 38 && t.profile !== "indoor" && t.profile !== "stay");
  if (hot.length) push({ kind: "secondary", level: "High", text: `Heat: ${Math.round(Math.max(...hot.map((t) => t.conditions.day!.tempMaxC)))}°C — outdoor plans (${hot.map((t) => t.title).join(", ")}) are safest before 11:00; plan water and shade` });
  if (simulatedMode && skipping.size) {
    push({ kind: "direct", level: "Medium", text: `${[...skipping].map((id) => first(name(id))).join(", ")} skip${skipping.size === 1 ? "s" : ""} ${scenario!.date ? `plans on ${scenario!.date}` : "the affected plans"} — shares are re-derived by the ledger` });
  }

  // ------------------------------------------------------------ recommendations
  const recommendations: Recommendation[] = [];
  const shortlists: Record<string, ShortlistEntry[]> = {};
  const existingTitles = live.map((i) => i.title.toLowerCase());
  const used = new Set<string>();
  const affected = items
    // Only experiences get swapped; transport and stays surface as movement / booking effects instead.
    .filter((t) => (t.assessment.availability === "unavailable" || t.assessment.availability === "at-risk") && !["stay", "air", "road-transfer", "two-wheeler"].includes(t.profile))
    .sort((a, b) => b.assessment.impactScore - a.assessment.impactScore);
  for (const t of affected) {
    const going = t.participantIds.filter((id) => !skipping.has(id) && members.some((m) => m.id === id));
    const goingPeople = members.filter((m) => going.includes(m.id));
    const ownTags = itemTags(t);
    const scored = world.candidates
      .filter((c) => !used.has(c.id) && !existingTitles.some((x) => x.includes(c.name.toLowerCase())))
      .map((c) => scoreCandidate(c, t, goingPeople.length ? goingPeople : members, ownTags, world, conditionsFor, newsPressure))
      .filter((x): x is Scored => !!x)
      .sort((a, b) => b.score - a.score);
    shortlists[t.id] = scored.slice(0, 5).map((x) => ({
      candidateId: x.c.id,
      name: x.c.name,
      kind: x.c.kind,
      indoor: x.c.indoor,
      km: x.km,
      engineScore: x.score,
      rating: world.ratings[x.c.id]?.rating,
      reviews: world.ratings[x.c.id]?.reviewCount,
      groupLikes: x.breakdown[2].detail,
    }));
    const nugenPick = opts.nugenPicks?.[t.id];
    // GroupTrip Intelligence may choose within the top five the engine ranked — never outside it.
    const picked = (nugenPick && scored.slice(0, 5).find((s) => s.c.id === nugenPick)) || scored[0];
    const recs: Recommendation[] = [];
    if (t.bestSlot) {
      const hh = `${String(t.bestSlot.start).padStart(2, "0")}:00`;
      const item = state.itinerary.find((i) => i.id === t.id)!;
      recs.push({
        id: `rec_${t.id}_slot`,
        forItemId: t.id,
        forTitle: t.title,
        kind: "reschedule",
        newTime: hh,
        score: t.bestSlot.suitability,
        breakdown: [
          { label: "Planned slot", value: t.assessment.suitability, detail: `${t.assessment.window[0]}:00–${t.assessment.window[1]}:00 suitability` },
          { label: "Better slot", value: t.bestSlot.suitability, detail: `${t.bestSlot.start}:00–${t.bestSlot.end}:00, ${t.bestSlot.mm} mm expected` },
        ],
        evidence: [{ icon: "schedule", label: "Hourly forecast", text: `${t.assessment.window[0]}:00 → ${t.assessment.drivers[0]}; ${t.bestSlot.start}:00 → ${t.bestSlot.mm} mm in the slot`, source: t.conditions.source === "simulated" ? "Simulated" : "Open-Meteo hourly" }],
        rationale: `Rain is concentrated earlier in the day; moving ${t.title} to ${hh} raises suitability from ${t.assessment.suitability} to ${t.bestSlot.suitability}.${t.paid ? " It is paid, so the vendor must confirm the new slot — the ledger does not change." : ""}`,
        chosenBy: "deterministic",
        changes: t.paid ? [] : [{ kind: "update-item", itemId: t.id, input: { ...inputOf(item), time: hh }, why: `${t.title} moves to ${hh}` }],
        chain: [],
      });
    }
    if (picked) {
      used.add(picked.c.id);
      const item = state.itinerary.find((i) => i.id === t.id)!;
      const changes: Change[] = [];
      if (t.paid && t.expenseId) changes.push({ kind: "cancel-booking", expenseId: t.expenseId, date: today });
      else changes.push({ kind: "drop-item", itemId: t.id });
      const participantIds = going.length ? going : item.participantIds;
      changes.push({
        kind: "add-item",
        input: {
          title: picked.c.name.slice(0, 80),
          category: categoryFor(picked.c),
          date: t.date,
          time: t.bestSlot ? undefined : item.time,
          location: picked.c.name,
          estimatedPaise: picked.c.estPerPersonPaise * participantIds.length,
          participantIds,
          notes: `Weather alternative for ${t.title}. ${picked.c.url}`,
        },
      });
      recs.push({
        id: `rec_${t.id}_${picked.c.id}`,
        forItemId: t.id,
        forTitle: t.title,
        kind: "replace",
        alternative: { candidate: picked.c, distanceKm: picked.km, estTotalPaise: picked.c.estPerPersonPaise * participantIds.length, ratings: world.ratings[picked.c.id] },
        score: picked.score,
        breakdown: picked.breakdown,
        evidence: picked.evidence,
        rationale: picked.rationale(t),
        chosenBy: nugenPick && nugenPick === picked.c.id ? "nugen" : "deterministic",
        changes,
        chain: [],
      });
    }
    recs.sort((a, b) => b.score - a.score);
    recommendations.push(...recs);
  }

  // Scenario-forced changes that are not weather swaps (members skipping, hotel removed).
  const scenarioChanges: Change[] = [];
  if (simulatedMode) {
    for (const t of items) {
      if (!t.forcedUnavailable || recommendations.some((r) => r.forItemId === t.id && r.kind === "replace")) continue;
      if (t.paid && t.expenseId) scenarioChanges.push({ kind: "cancel-booking", expenseId: t.expenseId, date: today });
      else scenarioChanges.push({ kind: "drop-item", itemId: t.id });
    }
    for (const pid of skipping) {
      for (const t of items) {
        if (scenario!.date && t.date !== scenario!.date) continue;
        if (t.category === "Stay" || t.category === "Transport" || t.forcedUnavailable) continue;
        if (recommendations.some((r) => r.forItemId === t.id && r.kind === "replace")) continue;
        const expense = t.expenseId ? state.expenses.find((e) => e.id === t.expenseId) : undefined;
        if (expense) {
          if (expense.participants.some((p) => p.participantId === pid) && expense.participants.length > 1) scenarioChanges.push({ kind: "withdraw", participantId: pid, expenseId: expense.id, date: today, rule: "redistribute" });
        } else if (t.participantIds.includes(pid) && t.participantIds.length > 1) {
          const item = state.itinerary.find((i) => i.id === t.id)!;
          const prior = scenarioChanges.find((c) => c.kind === "update-item" && c.itemId === t.id) as Extract<Change, { kind: "update-item" }> | undefined;
          const base = prior?.input ?? inputOf(item);
          const idx = base.participantIds.indexOf(pid);
          const next = { ...base, participantIds: base.participantIds.filter((x) => x !== pid), weights: base.weights?.filter((_, i) => i !== idx) };
          if (!next.participantIds.length) continue;
          if (prior) prior.input = next;
          else scenarioChanges.push({ kind: "update-item", itemId: t.id, input: next, why: `${first(name(pid))} skips ${t.title}` });
        }
      }
    }
  }

  // ------------------------------------------------------------ money: the ledger decides
  const names = (id: string) => first(name(id));
  for (const r of recommendations) r.finance = financeOf(state, events, r.changes, names, now);
  const primary = primaryPerItem(recommendations);
  // A reschedule on an item the scenario already edits (someone skipping) is folded into that edit,
  // so the skipper is not put back by a full-item update built from the original.
  const recChanges = primary.flatMap((r) =>
    r.changes.filter((c) => {
      if (c.kind !== "update-item" || r.kind !== "reschedule") return true;
      const prior = scenarioChanges.find((x) => x.kind === "update-item" && x.itemId === c.itemId) as Extract<Change, { kind: "update-item" }> | undefined;
      if (!prior) return true;
      prior.input = { ...prior.input, time: r.newTime };
      return false;
    }),
  );
  const allChanges = [...scenarioChanges, ...recChanges];
  const finance = allChanges.length ? financeOf(state, events, allChanges, names, now) : null;

  for (const r of recommendations) r.chain = chainFor(r, items.find((t) => t.id === r.forItemId)!);

  // ------------------------------------------------------------ paths (real vs twin)
  const paths = days.map((date) => {
    const todays = items.filter((t) => t.date === date && t.category !== "Stay" && t.profile !== "air").sort((a, b) => (a.time ?? "12:00").localeCompare(b.time ?? "12:00"));
    const real: PathPoint[] = todays.map((t) => ({ lat: t.place.lat, lon: t.place.lon, itemId: t.id, title: t.title }));
    const twin: PathPoint[] = todays.flatMap((t): PathPoint[] => {
      const rec = primary.find((r) => r.forItemId === t.id);
      if (rec?.kind === "replace" && rec.alternative) return [{ lat: rec.alternative.candidate.lat, lon: rec.alternative.candidate.lon, itemId: t.id, title: rec.alternative.candidate.name, alt: true }];
      if (t.assessment.availability === "unavailable") return [];
      return [{ lat: t.place.lat, lon: t.place.lon, itemId: t.id, title: t.title }];
    });
    const home = { lat: origin.lat, lon: origin.lon, itemId: stayItem?.id ?? "stay", title: stayItem?.title ?? "Stay" };
    return { date, real: real.length ? [home, ...real, home] : [], twin: twin.length ? [home, ...twin, home] : [] };
  });

  // ------------------------------------------------------------ headline
  const worst = [...items].filter((t) => t.assessment.availability === "unavailable" || t.assessment.availability === "at-risk").sort((a, b) => b.assessment.impactScore - a.assessment.impactScore)[0];
  const city = world.destination.label.split(",")[0];
  let headline: Twin["headline"];
  if (worst) {
    const d = worst.conditions.day;
    const what = d ? (d.precipitationMm >= 15.6 ? `${imdCategory(d.precipitationMm).replace(/^./, (x) => x.toUpperCase())} (${d.precipitationMm.toFixed(0)} mm)` : d.tempMaxC >= 38 ? `${Math.round(d.tempMaxC)}°C heat` : describeWeatherCode(d.weatherCode)) : "Disruption";
    const where = worst.place.precision === "item" ? worst.place.label : city;
    headline = {
      title: `${what} expected on ${worst.date} near ${where}`,
      detail: `${worst.title} ${worst.assessment.availability === "unavailable" ? "is likely unavailable" : "may be affected"} · impact ${worst.assessment.impactScore}/100 (${worst.assessment.level})`,
      level: worst.assessment.level,
      date: worst.date,
      itemId: worst.id,
      normal: false,
    };
  } else {
    const covered = items.filter((t) => t.conditions.source !== "no-data");
    const src = world.mode === "replay" ? "recorded" : "live";
    const ended = state.trip.endDate < today;
    headline = {
      title: !items.length ? `No plan items to check against the weather in ${city}` : ended ? `This trip has ended` : covered.length ? `Weather looks workable for your plan in ${city}` : `No ${src} forecast for ${city} on your trip dates yet`,
      detail: !items.length
        ? "Add stays and activities to the plan — each one is then checked against the forecast."
        : ended
          ? "Forecasts only look ahead, so past days are not assessed."
          : covered.length
            ? `${covered.length} of ${items.length} plan items are inside the ${src} forecast window; none is at risk.`
            : `Open-Meteo forecasts 16 days ahead — your trip starts ${state.trip.startDate}. Current conditions are shown; use What-If to stress-test the plan.`,
      level: "Low",
      normal: true,
    };
  }

  const participants = members.map((m) => ({ id: m.id, name: m.name, available: !skipping.has(m.id), reason: skipping.has(m.id) ? "Skipping in this scenario" : undefined }));

  return { mode: simulatedMode ? "simulated" : "real", scenario: simulatedMode ? scenario : null, generatedAt: now, worldMode: world.mode, days, items, effects, recommendations, headline, paths, participants, finance, newsPressure, shortlists };
}

/** The top recommendation per affected item. */
export function primaryPerItem(recs: Recommendation[]): Recommendation[] {
  const out = new Map<string, Recommendation>();
  for (const r of recs) if (!out.has(r.forItemId) || out.get(r.forItemId)!.score < r.score) out.set(r.forItemId, r);
  return [...out.values()];
}

// ---------------------------------------------------------------- candidate scoring

type Scored = { c: Candidate; km: number; score: number; breakdown: ScoreComponent[]; evidence: Evidence[]; rationale: (t: TwinItem) => string };

function scoreCandidate(
  c: Candidate,
  t: TwinItem,
  people: TripState["participants"],
  ownTags: string[],
  world: TwinWorld,
  conditionsFor: (item: ItineraryItem, date: string, pin: PlacePin) => { c: Conditions; key: string },
  newsPressure: number,
): Scored | null {
  const km = Math.round(distanceKm(t.place, c) * 10) / 10;
  if (km > 30) return null;
  const hour = t.assessment.window[0];
  const open = openAt(c.openingHours, t.date, hour);
  if (open === false) return null;
  const pseudo = { title: `${c.name} ${c.kind}`, category: categoryFor(c), vendor: undefined, time: t.time } as ItineraryItem;
  const pin: PlacePin = { lat: c.lat, lon: c.lon, label: c.name, precision: "item", source: "openstreetmap" };
  const cond = conditionsFor({ ...pseudo, id: c.id, date: t.date } as ItineraryItem, t.date, pin).c;
  const a = assess(pseudo, cond, newsPressure);
  // An indoor venue is weather-proof by construction; its own score reflects only getting there.
  const profile = candidateProfile(c);
  const weatherFit = profile === "indoor" ? Math.max(a.suitability, 90) : a.suitability;
  if (weatherFit < 50) return null;

  const r = world.ratings[c.id];
  const rs = ratingScore(r?.rating, r?.reviewCount);
  const parts: number[] = [];
  const pubDetail: string[] = [];
  if (rs !== null) {
    parts.push(rs * 0.6);
    pubDetail.push(`${r!.rating!.toFixed(1)}★ · ${r!.reviewCount!.toLocaleString("en-IN")} reviews`);
  }
  if (r?.recentSentiment !== undefined) {
    parts.push(((r.recentSentiment + 1) / 2) * 0.25);
    pubDetail.push(`recent reviews ${r.recentSentiment >= 0.2 ? "positive" : r.recentSentiment <= -0.2 ? "negative" : "mixed"}`);
  }
  if (r?.pageviewTrend !== undefined) {
    parts.push(Math.max(0, Math.min(1, 0.5 + r.pageviewTrend)) * 0.15);
    pubDetail.push(`${(r.pageviews30d ?? 0).toLocaleString("en-IN")} Wikipedia views/30d (${r.pageviewTrend >= 0 ? "+" : ""}${Math.round(r.pageviewTrend * 100)}%)`);
  }
  const pubWeight = (rs !== null ? 0.6 : 0) + (r?.recentSentiment !== undefined ? 0.25 : 0) + (r?.pageviewTrend !== undefined ? 0.15 : 0);
  const publicScore = pubWeight > 0 ? parts.reduce((x, y) => x + y, 0) / pubWeight : null;

  const liking = people.filter((p) => p.interests?.activities.some((x) => c.tags.includes(x)));
  const groupFit = people.length ? liking.length / people.length : 0.5;
  const similar = ownTags.length ? c.tags.filter((x) => ownTags.includes(x)).length / ownTags.length : 0;
  const distanceFit = Math.max(0, 1 - km / 30);
  const budgetFit = c.estPerPersonPaise * Math.max(1, t.participantIds.length) <= t.estimatedPaise || c.free ? 1 : 0.6;
  const constraints = distanceFit * 0.7 + budgetFit * 0.3;
  const itineraryFit = 0.5 + 0.5 * similar;

  const W = { weather: 0.35, pub: 0.2, group: 0.22, constraints: 0.15, itinerary: 0.08 };
  const wSum = W.weather + (publicScore !== null ? W.pub : 0) + W.group + W.constraints + W.itinerary;
  const score = Math.round(((weatherFit / 100) * W.weather + (publicScore ?? 0) * (publicScore !== null ? W.pub : 0) + groupFit * W.group + constraints * W.constraints + itineraryFit * W.itinerary) / wSum * 100);

  const breakdown: ScoreComponent[] = [
    { label: "Weather suitability", value: weatherFit, detail: profile === "indoor" ? "indoor — unaffected by rain" : a.drivers[0] },
    { label: "Public / social signals", value: publicScore === null ? -1 : Math.round(publicScore * 100), detail: publicScore === null ? "no ratings/trend data for this place (not invented)" : pubDetail.join(" · ") },
    { label: "Group preferences", value: Math.round(groupFit * 100), detail: liking.length ? `${liking.map((p) => first(p.name)).join(", ")} like ${c.tags.join("/")}` : `nobody lists ${c.tags.join("/")} as an interest` },
    { label: "Trip constraints", value: Math.round(constraints * 100), detail: `${km} km from ${t.title}; ${c.free ? "free entry" : `est. ${formatMoney(c.estPerPersonPaise)}/person`}${open === true ? "; open then" : open === null ? "; hours unknown" : ""}` },
    { label: "Itinerary fit", value: Math.round(itineraryFit * 100), detail: similar ? `shares ${c.tags.filter((x) => ownTags.includes(x)).join("/")} with the plan it replaces` : "adds variety on the same day" },
  ];
  const evidence: Evidence[] = [
    { icon: "rainy", label: "Weather", text: profile === "indoor" ? `Indoor venue; ${t.title} faces ${t.assessment.drivers[0]}` : a.drivers[0], source: cond.source === "simulated" ? "Simulated" : "Open-Meteo" },
  ];
  if (r?.rating !== undefined) evidence.push({ icon: "star", label: "Rating", text: `${r.rating.toFixed(1)}★ from ${r.reviewCount?.toLocaleString("en-IN")} reviews`, source: "Google Places" });
  if (r?.recentSentiment !== undefined) evidence.push({ icon: "reviews", label: "Recent reviews", text: `sentiment ${r.recentSentiment >= 0 ? "+" : ""}${r.recentSentiment}${r.latestReviewAt ? ` · newest ${new Date(r.latestReviewAt).toISOString().slice(0, 10)}` : ""}`, source: "Google Places" });
  if (r?.pageviewTrend !== undefined) evidence.push({ icon: "trending_up", label: "Interest trend", text: `${(r.pageviews30d ?? 0).toLocaleString("en-IN")} views in 30 days (${r.pageviewTrend >= 0 ? "+" : ""}${Math.round(r.pageviewTrend * 100)}%)`, source: "Wikipedia page views" });
  if (rs === null && r?.pageviewTrend === undefined) evidence.push({ icon: "star_half", label: "Rating", text: "No rating provider data for this place — ranked without it", source: "—" });
  evidence.push({ icon: "place", label: "Location", text: `${km} km from the original plan · OSM ${c.kind.replace(/_/g, " ")}`, source: "OpenStreetMap", url: c.url });
  evidence.push({ icon: "group", label: "Group fit", text: liking.length ? `${liking.length}/${people.length} going like ${c.tags.join("/")}` : "no stated preference match", source: "Member preferences" });

  const rationale = (tt: TwinItem) => {
    const why: string[] = [];
    why.push(tt.assessment.drivers[0].includes("mm") ? `${tt.title} faces ${tt.assessment.drivers[0]}` : `${tt.title} is ${tt.assessment.availability}`);
    why.push(profile === "indoor" ? `${c.name} is indoors` : `${c.name} stays ${weatherFit}/100 suitable`);
    if (publicScore !== null) why.push(`public signals score it ${Math.round(publicScore * 100)}/100 (${pubDetail.join(", ")})`);
    if (liking.length) why.push(`${liking.length} of ${people.length} going like ${c.tags.join("/")}`);
    why.push(`${km} km away`);
    return `Recommended because ${why.join("; ")}.`;
  };
  return { c, km, score, breakdown, evidence, rationale };
}

// ---------------------------------------------------------------- finance via the ledger

function financeOf(state: TripState, events: LedgerEvent[], changes: Change[], name: (id: string) => string, now: number): FinanceSummary {
  const empty = { plannedBefore: 0, plannedAfter: 0, spendBefore: 0, spendAfter: 0, refunds: [], people: [], lines: [] };
  if (!changes.length) return { ok: true, ...empty };
  const sim = simulate(events, changes, { actor: "system", now }, name);
  if (!sim.ok) return { ok: false, error: sim.error, ...empty };
  const title = (id: string) => sim.after.state.expenses.find((e) => e.id === id)?.title ?? "booking";
  return {
    ok: true,
    plannedBefore: sim.before.ledger.budget.estimatedPaise,
    plannedAfter: sim.after.ledger.budget.estimatedPaise,
    spendBefore: sim.diff.spendBefore,
    spendAfter: sim.diff.spendAfter,
    refunds: sim.diff.refundsAdded.map((r) => ({ amountPaise: r.amountPaise, to: name(r.receivedBy), expense: title(r.expenseId) })),
    people: sim.diff.people.filter((p) => p.deltaPaise !== 0).map((p) => ({ id: p.participantId, name: name(p.participantId), before: p.netBefore, after: p.netAfter, delta: p.deltaPaise })),
    lines: changes.map((c) => describeChange(state, c)),
  };
}

function chainFor(r: Recommendation, t: TwinItem): string[] {
  const d = t.conditions.day;
  const chain: string[] = [];
  chain.push(d ? `${t.conditions.source === "simulated" ? "Simulated" : "Forecast"}: ${d.precipitationMm.toFixed(0)} mm (${imdCategory(d.precipitationMm)}), ${Math.round(d.tempMaxC)}°C, wind ${Math.round(d.windMaxKmh)} km/h` : "Scenario change");
  chain.push(`${PROFILE_LABEL[t.profile]} risk ${t.assessment.impactScore}/100 (${t.assessment.level})`);
  chain.push(t.assessment.availability === "unavailable" ? `${t.title} becomes unavailable` : `${t.title} at risk`);
  if (r.kind === "reschedule") {
    chain.push(`Hourly view: ${r.newTime} slot is ${r.score}/100 suitable`);
    chain.push(r.changes.length ? `Itinerary: ${t.title} moves to ${r.newTime}` : "Itinerary: ask the vendor for the later slot");
  } else if (r.alternative) {
    chain.push("Alternative required");
    chain.push(`${r.alternative.candidate.name} selected · score ${r.score}/100 (weather + public signals + group + constraints)`);
    chain.push(`Itinerary: − ${t.title}, + ${r.alternative.candidate.name}`);
  }
  const f = r.finance;
  if (f?.ok && f.lines.length) {
    const money: string[] = [];
    if (f.refunds.length) money.push(f.refunds.map((x) => `refund ${formatMoney(x.amountPaise)} → ${x.to}`).join(", "));
    if (f.plannedAfter !== f.plannedBefore) money.push(`plan ${formatMoney(f.plannedAfter - f.plannedBefore, { signed: true })}`);
    if (f.spendAfter !== f.spendBefore) money.push(`spend ${formatMoney(f.spendAfter - f.spendBefore, { signed: true })}`);
    chain.push(`Ledger recalculated: ${money.join(" · ") || "no money moves"}`);
  } else if (f && !f.ok) chain.push(`Ledger: not possible — ${f.error}`);
  return chain;
}

export function inputOf(item: ItineraryItem) {
  return {
    title: item.title,
    category: item.category,
    date: item.date,
    endDate: item.endDate,
    time: item.time,
    location: item.location,
    vendor: item.vendor,
    vendorUpi: item.vendorUpi,
    vendorUpiName: item.vendorUpiName,
    estimatedPaise: item.estimatedPaise,
    actualPaise: item.actualPaise,
    participantIds: item.participantIds,
    weights: item.weights,
    notes: item.notes,
    cancellationPolicy: item.cancellationPolicy,
    status: item.status,
  };
}

import type { TripState } from "@/lib/ledger/types";
import { EMPTY_SCENARIO, validateScenario, type Scenario } from "./scenario";

/**
 * Deterministic reader for What-If questions — the fallback when GroupTrip
 * Intelligence (Nugen) is not configured or returns something invalid.
 * Understands: rainfall N mm, storm lasts N more hours, temperature N°C,
 * wind N km/h, day N / a date, "<activity> unavailable/closed",
 * "<names> / three members skip", "hotel removed", "at <place>".
 */

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1 };

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const STOP = new Set(["the", "and", "with", "from", "trip", "tour", "day", "days", "session", "rentals", "meals", "dinner", "lunch"]);
const words = (t: string) => t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

export function parseScenarioText(text: string, state: TripState): { scenario: Scenario; understood: string[] } {
  const t = text.toLowerCase();
  const raw: Record<string, unknown> = { ...EMPTY_SCENARIO, unavailableItemIds: [], skippingParticipantIds: [] };
  const understood: string[] = [];
  const live = state.itinerary.filter((i) => i.status !== "cancelled");

  const rain = /(\d+(?:\.\d+)?)\s*mm/.exec(t);
  if (rain) {
    raw.rainfallMm = Number(rain[1]);
    understood.push(`rainfall ${rain[1]} mm`);
  } else if (/\b(heavy|torrential|very heavy|extreme)\s+(rain|downpour|storm)|cloudburst/.test(t)) {
    raw.rainfallMm = /very heavy|torrential|extreme|cloudburst/.test(t) ? 130 : 80;
    understood.push(`${raw.rainfallMm} mm (IMD ${raw.rainfallMm === 80 ? "heavy" : "very heavy"} rain)`);
  } else if (/\b(light rain|drizzle|showers?)\b/.test(t)) {
    raw.rainfallMm = 10;
    understood.push("10 mm (light rain)");
  }
  const longer = /(?:storm|rain)[^.]*?(?:lasts?|continues?|goes on)[^.]*?(\d+)\s*(?:more|extra|additional)?\s*h(?:ou)?rs?/.exec(t) ?? /(\d+)\s*(?:more|extra|additional)\s*h(?:ou)?rs?/.exec(t);
  if (longer) {
    raw.stormExtraHours = Number(longer[1]);
    if (raw.rainfallMm === undefined) raw.rainfallMm = 60;
    understood.push(`storm +${longer[1]} h`);
  }
  const temp = /(-?\d+(?:\.\d+)?)\s*(?:°|degrees?|deg)\s*c?/.exec(t) ?? /temperature\D{0,12}(-?\d+(?:\.\d+)?)/.exec(t);
  if (temp) {
    raw.temperatureC = Number(temp[1]);
    understood.push(`${temp[1]}°C`);
  } else if (/heat ?wave|scorching/.test(t)) {
    raw.temperatureC = 42;
    understood.push("42°C heatwave");
  }
  const wind = /(\d+)\s*(?:km\/?h|kmph|kph)/.exec(t);
  if (wind) {
    raw.windKmh = Number(wind[1]);
    understood.push(`wind ${wind[1]} km/h`);
  }
  const day = /\bday\s*(\d{1,2})\b/.exec(t);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) raw.date = iso[1];
  else if (day) raw.date = addDays(state.trip.startDate, Number(day[1]) - 1);
  else if (/\btomorrow\b/.test(t)) raw.date = addDays(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10), 1);
  if (raw.date) understood.push(`on ${raw.date}`);

  // "<activity> unavailable / closed / cancelled"
  const closedClause = /([a-z\s]+?)\s+(?:is|are|gets?|becomes?)?\s*(?:unavailable|closed|shut|cancelled|canceled|not available)/.exec(t);
  if (closedClause) {
    const w = words(closedClause[1]);
    const hit = live.filter((i) => i.category !== "Stay" && words(i.title).some((x) => w.includes(x)));
    if (hit.length) {
      raw.unavailableItemIds = hit.map((i) => i.id);
      understood.push(`${hit.map((i) => i.title).join(", ")} unavailable`);
    }
  }
  // Location: "at/in/near <item place>"
  const at = /\b(?:at|in|near)\s+([a-z][a-z\s]{3,30})/.exec(t);
  if (at) {
    const w = words(at[1]);
    const hit = live.find((i) => words(`${i.title} ${i.location ?? ""}`).some((x) => w.includes(x)));
    if (hit && !(raw.unavailableItemIds as string[]).includes(hit.id)) {
      raw.area = { kind: "item", itemId: hit.id, radiusKm: 15 };
      understood.push(`affected area around ${hit.title}`);
    }
  }
  if (/\b(hotel|villa|stay|homestay|resort)\b[^.]*\b(removed|cancel+ed|gone|unavailable|lost)|\b(remove|cancel|lose)\s+the\s+(hotel|villa|stay)/.test(t)) {
    raw.hotelRemoved = true;
    understood.push("stay removed");
  }
  // Members skipping: by name, or "three members skip"
  if (/\bskip|drop out|stay back|don'?t go|not go|opt out|miss/.test(t)) {
    const members = state.participants.filter((p) => !p.leftOn);
    const named = members.filter((m) => t.includes(m.name.split(" ")[0].toLowerCase()));
    let ids = named.map((m) => m.id);
    const count = /\b(\d|one|two|three|four|five|six)\s+(?:members?|people|friends|of us|travell?ers)/.exec(t);
    if (!ids.length && count) {
      const n = Number(count[1]) || NUM[count[1]] || 0;
      // Deterministic choice: members with the fewest matching interests for the affected day skip first.
      ids = [...members].sort((a, b) => (a.interests?.activities.length ?? 0) - (b.interests?.activities.length ?? 0) || a.name.localeCompare(b.name)).slice(0, Math.min(n, members.length - 1)).map((m) => m.id);
    }
    if (ids.length) {
      raw.skippingParticipantIds = ids;
      understood.push(`${ids.length} member${ids.length === 1 ? "" : "s"} skip`);
    }
  }
  const { scenario } = validateScenario(raw, state);
  scenario.label = text.slice(0, 80);
  return { scenario, understood };
}

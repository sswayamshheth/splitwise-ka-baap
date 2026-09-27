import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { factsFor, explainDeterministic } from "@/lib/twin/explain";
import { parseScenarioText } from "@/lib/twin/parse-scenario";
import { buildTwin, primaryPerItem, type TwinWorld } from "@/lib/twin/twin";
import { SYSTEM_PROMPT } from "./intelligence";

/**
 * Builds the GroupTrip Intelligence alignment corpus from REAL app data:
 * real trips' event logs + a real captured world (Open-Meteo forecast, OSM
 * places, public signals). Everything in it is produced by the deterministic
 * engines, so the model is aligned to the app's own ground truth.
 *
 * Nugen alignment (docs.nugen.in, /api/v3/alignment-projects/create) trains on
 * uploaded plain-text DOCUMENTS; its benchmark upload takes
 * [{sample_num, instruction, response}]. We produce both:
 *   - corpus.txt      domain documents (rules + worked examples)
 *   - benchmark.json  instruction/response pairs for evaluation
 */

export type BenchSample = { sample_num: number; instruction: string; response: string };

const RULES = `${SYSTEM_PROMPT}

GroupTrip Intelligence domain rules
- Rain categories (IMD, daily): light < 15.6 mm, moderate < 64.5 mm, heavy < 115.6 mm, very heavy < 204.5 mm.
- Sea and river activities (scuba, snorkelling, rafting, cruises) are the most rain- and wind-sensitive; indoor venues are not affected by rain.
- Paid bookings are never deleted; they are cancelled under the vendor's refund policy by the ledger, which computes refunds and balances.
- An alternative is chosen by weather suitability, public signals (ratings, review counts, recent sentiment, interest trends), the group's stated interests, distance and budget, and fit with the existing plan — never by rating alone.
- A What-If question is converted into a structured scenario (rainfallMm, stormStartHour, stormHours, stormExtraHours, temperatureC, windKmh, date, area, unavailableItemIds, skippingParticipantIds, hotelRemoved). The deterministic Digital Twin computes the result.
- Explanations only use numbers that appear in the supplied facts.
`;

const QUESTIONS = ["Why did you recommend this?", "Why was this activity removed?", "Why did my cost change?", "Why is this better?"];
const WHATIFS = ["rainfall becomes 100mm on day 2", "storm lasts another 12 hours with 90mm on day 2", "temperature 42°C on day 2", "rainfall 20mm on day 2", "three members skip day 2", "hotel removed", "heavy rain on day 2 and scuba unavailable"];

export function buildDataset(trips: { id: string; events: LedgerEvent[] }[], world: TwinWorld, now = Date.now()): { corpus: string; benchmark: BenchSample[] } {
  const docs: string[] = [RULES];
  const bench: BenchSample[] = [];
  for (const t of trips) {
    const state = reduceEvents(t.events);
    if (!state) continue;
    const w: TwinWorld = { ...world, tripId: t.id };
    for (const text of WHATIFS) {
      const { scenario } = parseScenarioText(text.replace("day 2", `day 2`), state);
      const twin = buildTwin(state, t.events, w, scenario, { now });
      const items = state.itinerary.filter((i) => i.status !== "cancelled").map((i) => ({ id: i.id, title: i.title, date: i.date }));
      const scenarioOut = JSON.stringify({ ...scenario, label: undefined });
      bench.push({ sample_num: bench.length + 1, instruction: `TASK: scenario\nTRIP: ${state.trip.destination} ${state.trip.startDate}..${state.trip.endDate}\nITEMS: ${JSON.stringify(items)}\nQUESTION: ${text}`, response: scenarioOut });
      docs.push(`Example — What-If for ${state.trip.name} (${state.trip.destination}): "${text}" → ${scenarioOut}`);
      for (const rec of primaryPerItem(twin.recommendations)) {
        const shortlist = twin.shortlists[rec.forItemId] ?? [];
        if (rec.alternative && shortlist.length) {
          const pick = { picks: [{ itemId: rec.forItemId, candidateId: rec.alternative.candidate.id, reason: rec.rationale }] };
          bench.push({ sample_num: bench.length + 1, instruction: `TASK: weather-adaptation\nAFFECTED: ${rec.forTitle} (${rec.chain[0]})\nSHORTLIST: ${JSON.stringify(shortlist)}`, response: JSON.stringify(pick) });
        }
        docs.push(`Example — ${text}: ${rec.chain.join(" → ")}. ${rec.rationale}`);
        const facts = factsFor(twin, rec.forItemId);
        for (const q of QUESTIONS) {
          const answer = explainDeterministic(q, facts);
          bench.push({ sample_num: bench.length + 1, instruction: `TASK: explanation\nFACTS: ${JSON.stringify(facts)}\nQUESTION: ${q}`, response: JSON.stringify({ answer, citedFacts: [] }) });
          docs.push(`Q: ${q} (${text}) A: ${answer}`);
        }
      }
    }
  }
  return { corpus: docs.join("\n\n"), benchmark: bench };
}

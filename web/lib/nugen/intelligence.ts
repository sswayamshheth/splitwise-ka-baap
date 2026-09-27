import { validateOps, type PlanOp, type PlanProposal } from "@/lib/itinerary/planner";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type TripState } from "@/lib/ledger/types";
import { explainDeterministic, type Facts } from "@/lib/twin/explain";
import { parseScenarioText } from "@/lib/twin/parse-scenario";
import type { Scenario } from "@/lib/twin/scenario";
import { nugenChat, nugenConfig, type ChatMessage, type NugenConfig } from "./client";
import { extractJson, validateAdaptation, validateExplanation, validateScenarioOutput, type AdaptationPick, type Shortlist, type Validated } from "./schemas";

/**
 * GroupTrip Intelligence — ONE domain model for the whole app, four tasks:
 *   A) itinerary generation / adaptation   → PlanOp[]            → validateOps → ledger commands
 *   B) weather adaptation                   → picks per item      → shortlist check → twin
 *   C) What-If language → scenario          → Scenario            → validateScenario → deterministic twin
 *   D) explanation                          → grounded answer     → number-grounding check
 *
 * USER → Nugen → structured intent → deterministic engine → result → Nugen explanation → USER.
 * Every call returns `meta` saying exactly which engine produced the answer
 * and why; invalid model output is rejected, never shown.
 */

export type Task = "itinerary" | "weather-adaptation" | "scenario" | "explanation";

export type InferenceMeta = {
  task: Task;
  engine: "nugen" | "deterministic";
  model?: string;
  aligned?: boolean;
  confidenceScore?: number | null;
  latencyMs?: number;
  /** Why the deterministic engine answered instead (not configured, error, invalid output). */
  fallbackReason?: string;
  repaired?: string[];
  inputs: string[];
};

export const SYSTEM_PROMPT = [
  "You are GroupTrip Intelligence, a model aligned for group-travel planning in the GroupTrip Ledger app.",
  "You reason over: live weather forecasts, public/social signals (news, posts, ratings, reviews), the trip itinerary and bookings, and each member's preferences.",
  "Rules: reply with ONE JSON object and nothing else. Use only ids that appear in the input. Never invent prices, refunds, balances, ratings or reviews — money is computed by the ledger engine, not by you.",
].join(" ");

async function run<T>(task: Task, cfg: NugenConfig | null, user: string, validate: (raw: unknown) => Validated<T>, maxTokens = 600, timeoutMs = 25_000): Promise<{ value: T | null; meta: Omit<InferenceMeta, "inputs"> }> {
  if (!cfg) return { value: null, meta: { task, engine: "deterministic", fallbackReason: "NUGEN_API_KEY not configured" } };
  if (timeoutMs < 3_000) return { value: null, meta: { task, engine: "deterministic", model: cfg.model, aligned: cfg.aligned, fallbackReason: "Not enough time left in this request for a model call" } };
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
  try {
    const res = await nugenChat(cfg, messages, { maxTokens, timeoutMs });
    let raw: unknown;
    try {
      raw = extractJson(res.text);
    } catch (e) {
      return { value: null, meta: { task, engine: "deterministic", model: res.model, aligned: cfg.aligned, fallbackReason: `Model output rejected: ${(e as Error).message}` } };
    }
    const v = validate(raw);
    if (!v.ok) return { value: null, meta: { task, engine: "deterministic", model: res.model, aligned: cfg.aligned, fallbackReason: `Model output rejected: ${v.error}` } };
    return { value: v.value, meta: { task, engine: "nugen", model: res.model, aligned: cfg.aligned, confidenceScore: res.confidenceScore, latencyMs: res.latencyMs, repaired: v.repaired } };
  } catch (e) {
    return { value: null, meta: { task, engine: "deterministic", model: cfg.model, aligned: cfg.aligned, fallbackReason: (e as Error).message.slice(0, 200) } };
  }
}

// ---------------------------------------------------------------- B

export type AdaptationInput = {
  trip: { destination: string; dates: string };
  affected: { itemId: string; title: string; date: string; impactScore: number; drivers: string[]; going: string[] }[];
  shortlist: Record<string, { candidateId: string; name: string; kind: string; indoor: boolean; km: number; engineScore: number; rating?: number; reviews?: number; groupLikes: string }[]>;
  signals: string[];
  preferences: Record<string, string[]>;
};

export async function adaptToWeather(input: AdaptationInput, cfg = nugenConfig(), timeoutMs = 25_000): Promise<{ picks: AdaptationPick[] | null; meta: InferenceMeta }> {
  const shortlist: Shortlist = Object.fromEntries(Object.entries(input.shortlist).map(([k, v]) => [k, v.map((c) => c.candidateId)]));
  const user = [
    "TASK: weather-adaptation. For each affected item choose the best alternative from ITS shortlist, balancing weather suitability, public signals (ratings/reviews/reports), group preferences, distance and the existing itinerary.",
    'Return {"picks":[{"itemId":"...","candidateId":"...","reason":"one sentence citing the evidence"}]}.',
    `INPUT: ${JSON.stringify(input)}`,
  ].join("\n");
  const r = await run("weather-adaptation", cfg, user, (raw) => validateAdaptation(raw, shortlist), 600, timeoutMs);
  return { picks: r.value, meta: { ...r.meta, inputs: ["Open-Meteo forecast", "Public signals", "Itinerary & bookings", "Member preferences", "Candidate places (OSM)"] } };
}

// ---------------------------------------------------------------- C

export async function scenarioFromText(text: string, state: TripState, cfg = nugenConfig()): Promise<{ scenario: Scenario; understood: string[]; meta: InferenceMeta }> {
  const items = state.itinerary.filter((i) => i.status !== "cancelled").map((i) => ({ id: i.id, title: i.title, date: i.date, category: i.category }));
  const members = state.participants.filter((p) => !p.leftOn).map((p) => ({ id: p.id, name: p.name }));
  const user = [
    "TASK: scenario. Turn the traveller's What-If question into a scenario for the deterministic Digital Twin.",
    'Schema: {"rainfallMm"?:number,"stormStartHour"?:0-23,"stormHours"?:1-24,"stormExtraHours"?:number,"temperatureC"?:number,"windKmh"?:number,"date"?:"YYYY-MM-DD","area"?:{"kind":"item","itemId":"...","radiusKm":number},"unavailableItemIds":[],"skippingParticipantIds":[],"hotelRemoved":boolean}',
    `TRIP: ${state.trip.destination}, ${state.trip.startDate}..${state.trip.endDate}`,
    `ITEMS: ${JSON.stringify(items)}`,
    `MEMBERS: ${JSON.stringify(members)}`,
    `QUESTION: ${text}`,
  ].join("\n");
  const r = await run("scenario", cfg, user, (raw) => validateScenarioOutput(raw, state), 400);
  const inputs = ["What-If question", "Itinerary ids", "Member ids", "Trip dates"];
  if (r.value) return { scenario: { ...r.value, label: text.slice(0, 80) }, understood: ["parsed by GroupTrip Intelligence"], meta: { ...r.meta, inputs } };
  const det = parseScenarioText(text, state);
  return { ...det, meta: { ...r.meta, inputs } };
}

// ---------------------------------------------------------------- D

export async function explain(question: string, facts: Facts, cfg = nugenConfig(), timeoutMs = 25_000): Promise<{ answer: string; citedFacts: string[]; meta: InferenceMeta }> {
  const factsJson = JSON.stringify(facts);
  const user = [
    "TASK: explanation. Answer the traveller's question in 2-4 plain sentences using ONLY these facts. Quote numbers exactly as given. Say clearly when something is simulated.",
    'Return {"answer":"...","citedFacts":["short quotes of the facts you used"]}.',
    `FACTS: ${factsJson}`,
    `QUESTION: ${question}`,
  ].join("\n");
  const r = await run("explanation", cfg, user, (raw) => validateExplanation(raw, factsJson), 500, timeoutMs);
  const inputs = ["Twin facts (weather, scores, evidence)", "Ledger simulation results", "Question"];
  if (r.value) return { ...r.value, meta: { ...r.meta, inputs } };
  return { answer: explainDeterministic(question, facts), citedFacts: [], meta: { ...r.meta, inputs } };
}

// ---------------------------------------------------------------- A

export async function planWithNugen(state: TripState, instruction: string, cfg = nugenConfig()): Promise<{ proposal: PlanProposal | null; meta: InferenceMeta }> {
  const members = state.participants.filter((p) => !p.leftOn);
  const plan = state.itinerary.filter((i) => i.status !== "cancelled").map((i) => ({ id: i.id, title: i.title, category: i.category, date: i.date, estimateRupees: i.estimatedPaise / 100, paid: i.expenseIds.length > 0 }));
  const user = [
    "TASK: itinerary. Propose minimal itinerary changes for the instruction. Paid items must not be removed or changed.",
    `Schema: {"summary":"...","ops":[{"op":"add","title":"...","category":one of ${JSON.stringify(EXPENSE_CATEGORIES)},"date":"YYYY-MM-DD","estimateRupees":number,"reason":"..."}|{"op":"remove","itemId":"...","reason":"..."}|{"op":"update","itemId":"...","date"?:"...","title"?:"...","estimateRupees"?:number,"reason":"..."}]}`,
    `TRIP: ${state.trip.destination}, ${state.trip.startDate}..${state.trip.endDate}, ${members.length} travellers${state.trip.budgetPaise ? `, budget ₹${state.trip.budgetPaise / 100}` : ""}`,
    `PREFERENCES: ${JSON.stringify(members.map((m) => ({ name: m.name.split(" ")[0], ...m.interests })))}`,
    `ITINERARY: ${JSON.stringify(plan)}`,
    `INSTRUCTION: ${instruction}`,
  ].join("\n");
  const r = await run(
    "itinerary",
    cfg,
    user,
    (raw): Validated<PlanProposal> => {
      const o = raw as { summary?: unknown; ops?: Record<string, unknown>[] };
      if (!Array.isArray(o?.ops)) return { ok: false, error: "Expected ops[]" };
      const ops: PlanOp[] = o.ops.flatMap((x): PlanOp[] => {
        const reason = typeof x.reason === "string" ? x.reason : "";
        if (x.op === "add") return [{ op: "add", item: { title: String(x.title ?? ""), category: (EXPENSE_CATEGORIES as string[]).includes(String(x.category)) ? (x.category as ExpenseCategory) : "Activity", date: String(x.date ?? ""), estimatedPaise: Math.round(Number(x.estimateRupees ?? 0) * 100) }, reason }];
        if (x.op === "remove" && typeof x.itemId === "string") return [{ op: "remove", itemId: x.itemId, title: "", reason }];
        if (x.op === "update" && typeof x.itemId === "string") return [{ op: "update", itemId: x.itemId, title: "", changes: { date: typeof x.date === "string" ? x.date : undefined, title: typeof x.title === "string" ? x.title : undefined, estimatedPaise: typeof x.estimateRupees === "number" ? Math.round(x.estimateRupees * 100) : undefined }, reason }];
        return [];
      });
      const valid = validateOps(state, ops);
      if (!valid.length && o.ops.length) return { ok: false, error: "No op survived validation against the trip" };
      return { ok: true, value: { ops: valid, summary: typeof o.summary === "string" ? o.summary : "", understood: true }, repaired: valid.length < o.ops.length ? [`${o.ops.length - valid.length} unsafe op(s) dropped`] : [] };
    },
    900,
  );
  return { proposal: r.value, meta: { ...r.meta, inputs: ["Trip & dates", "Budget", "Member preferences", "Existing itinerary & bookings", "Instruction"] } };
}

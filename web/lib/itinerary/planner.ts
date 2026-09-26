import { ACTIVITIES, itemTags } from "@/lib/interests";
import { suggestItinerary } from "@/lib/itinerary/suggest";
import { ideasFor } from "@/lib/itinerary/suggest";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ItineraryItem, type TripState } from "@/lib/ledger/types";

/**
 * The Plan assistant. An instruction ("add water sports", "remove nightlife",
 * "make a new plan for our group", "move scuba to day 3") becomes a list of
 * PROPOSED changes the user reviews and applies — the plan is never changed
 * without that confirmation. Paid bookings are never touched here (they go
 * through cancellation, which has money consequences).
 *
 * This file is the built-in planner that works without any AI key. When the
 * server has ANTHROPIC_API_KEY, Claude produces the same PlanOp shape for any
 * free-form instruction; the result is validated with `validateOps` either way.
 */

export type PlanAdd = { title: string; category: ExpenseCategory; date: string; estimatedPaise: number; vendor?: string };
export type PlanOp =
  | { op: "add"; item: PlanAdd; reason: string }
  | { op: "remove"; itemId: string; title: string; reason: string }
  | { op: "update"; itemId: string; title: string; changes: { date?: string; estimatedPaise?: number; title?: string }; reason: string };

export type PlanProposal = { ops: PlanOp[]; summary: string; understood: boolean };

const TAG_WORDS: [RegExp, string][] = [
  [/water ?sports?|scuba|snorkel|raft|kayak|beach|parasail|jet ?ski|swim|boat|cruise|surf|water/i, "water"],
  [/trek|hike|hiking|mountain|snow|summit|peak/i, "mountain"],
  [/adventure|paraglid|bungee|zip ?line|atv|thrill|extreme/i, "adventure"],
  [/nature|waterfall|wildlife|safari|plantation|forest|bird/i, "nature"],
  [/culture|cultural|temple|heritage|museum|fort|church|history|historic|monument/i, "culture"],
  [/food|eat|cuisine|restaurant|caf[eé]|street food|dinner|lunch|foodie/i, "food"],
  [/nightlife|party|club|bar|pub|night out/i, "nightlife"],
  [/relax|spa|chill|rest|wellness|yoga|slow/i, "relaxing"],
  [/indoor|board ?games?|bowling|arcade|games?/i, "indoor"],
  [/shopping|market|souvenir|mall|bazaar/i, "shopping"],
];

const NUM_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, couple: 2, few: 3 };

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function dayIndex(start: string, date: string) {
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = date.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const STOP = new Set(["with", "from", "the", "and", "for", "day", "trip", "tour", "visit", "session", "slot", "time", "evening", "morning", "afternoon", "night"]);
const KEY = /scuba|snorkel|parasail|cruise|raft|kayak|paraglid|bungee|trek|hike|safari|spa|bowling|arcade|market|falls|temple|church|fort|museum|club|brewery|zipline|atv|yoga|aarti/;
const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
/** Two titles describe the same activity if they share a key activity word or two significant words. */
export function sameActivity(a: string, b: string): boolean {
  const A = tokens(a);
  const shared = [...tokens(b)].filter((w) => A.has(w));
  return shared.length >= 2 || shared.some((w) => KEY.test(w));
}

const isPaid = (i: ItineraryItem) => i.expenseIds.length > 0;
const isLive = (i: ItineraryItem) => i.status !== "cancelled";
const tagLabel = (t: string) => ACTIVITIES.find((a) => a.id === t)?.label.toLowerCase() ?? t;

/** Validates ops against the trip (used for both built-in and AI output). Drops anything unsafe. */
export function validateOps(state: TripState, ops: PlanOp[]): PlanOp[] {
  const { startDate, endDate } = state.trip;
  const byId = new Map(state.itinerary.map((i) => [i.id, i]));
  const out: PlanOp[] = [];
  const touched = new Set<string>();
  for (const op of ops.slice(0, 25)) {
    if (op.op === "add") {
      const t = op.item.title?.trim().slice(0, 80);
      if (!t) continue;
      const category = EXPENSE_CATEGORIES.includes(op.item.category) ? op.item.category : "Activity";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(op.item.date) && op.item.date >= startDate && op.item.date <= endDate ? op.item.date : startDate;
      const est = Number.isFinite(op.item.estimatedPaise) ? Math.max(0, Math.min(1_00_00_000_00, Math.round(op.item.estimatedPaise))) : 0;
      out.push({ op: "add", item: { title: t, category, date, estimatedPaise: est, vendor: op.item.vendor?.slice(0, 60) }, reason: op.reason?.slice(0, 160) ?? "" });
    } else {
      const item = byId.get(op.itemId);
      if (!item || !isLive(item) || isPaid(item) || touched.has(item.id)) continue;
      touched.add(item.id);
      if (op.op === "remove") out.push({ ...op, title: item.title, reason: op.reason?.slice(0, 160) ?? "" });
      else {
        const c = op.changes ?? {};
        const changes: { date?: string; estimatedPaise?: number; title?: string } = {};
        if (c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.date >= startDate && c.date <= endDate && c.date !== item.date) changes.date = c.date;
        if (typeof c.estimatedPaise === "number" && c.estimatedPaise >= 0 && Math.round(c.estimatedPaise) !== item.estimatedPaise) changes.estimatedPaise = Math.round(c.estimatedPaise);
        if (c.title && c.title.trim() && c.title.trim() !== item.title) changes.title = c.title.trim().slice(0, 80);
        if (Object.keys(changes).length) out.push({ op: "update", itemId: item.id, title: item.title, changes, reason: op.reason?.slice(0, 160) ?? "" });
      }
    }
  }
  return out;
}

/** Built-in planner (no AI key needed). Understands add / remove / move / replan / cheaper / relaxed. */
export function planOffline(state: TripState, instruction: string): PlanProposal {
  const text = instruction.trim();
  const lower = text.toLowerCase();
  const { startDate, endDate, destination } = state.trip;
  const members = state.participants.filter((p) => !p.leftOn);
  const people = Math.max(1, members.length);
  const live = state.itinerary.filter(isLive);
  const unpaid = live.filter((i) => !isPaid(i));
  const tripDays = Math.max(1, dayIndex(startDate, endDate) + 1);
  const tags = [...new Set(TAG_WORDS.filter(([re]) => re.test(text)).map(([, t]) => t))];
  const dayMatch = /\bday\s*(\d{1,2})\b/i.exec(text);
  const wantDay = dayMatch ? Math.min(tripDays, Math.max(1, Number(dayMatch[1]))) : null;
  const countMatch = /\b(\d|one|two|three|a|an|couple|few)\b(?:\s+(?:more|extra))?\s+(?:water|adventure|food|nightlife|culture|nature|relax|indoor|shopping|trek|activit|thing|option|idea)/i.exec(text);
  const wanted = countMatch ? Math.min(4, Number(countMatch[1]) || NUM_WORDS[countMatch[1].toLowerCase()] || 1) : null;
  const interests: Record<string, number> = {};
  for (const p of members) for (const a of p.interests?.activities ?? []) interests[a] = (interests[a] ?? 0) + 1;

  const experiencesOn = (date: string) => live.filter((i) => i.date === date && itemTags(i).length > 0).length;
  const quietestDay = (exclude: Set<string> = new Set()) => {
    let best = startDate;
    let bestN = Infinity;
    for (let d = 0; d < tripDays; d++) {
      const date = addDays(startDate, d);
      const n = experiencesOn(date) + (exclude.has(date) ? 1 : 0);
      if (n < bestN) {
        best = date;
        bestN = n;
      }
    }
    return best;
  };
  const alreadyHas = (title: string) => live.some((i) => sameActivity(i.title, title));

  // ----- replan
  if (/\b(new|fresh|whole|entire|complete)\s+(plan|itinerary)|re-?plan|from scratch|start over|redo (the )?plan/i.test(text)) {
    const drafts = suggestItinerary({ destination, startDate, endDate, travellers: people, interests });
    const hasStay = live.some((i) => i.category === "Stay");
    const ops: PlanOp[] = unpaid
      .filter((i) => i.category !== "Stay" && i.category !== "Transport")
      .map((i) => ({ op: "remove" as const, itemId: i.id, title: i.title, reason: "Replaced by the new plan" }));
    for (const d of drafts) {
      if (d.category === "Stay" && hasStay) continue;
      if (alreadyHas(d.title)) continue;
      ops.push({ op: "add", item: { title: d.title, category: d.category, date: d.date ?? startDate, estimatedPaise: d.estimatedPaise }, reason: d.evidence });
    }
    return { ops: validateOps(state, ops), understood: true, summary: `A fresh plan for ${people} from your group's interests. Paid bookings stay as they are.` };
  }

  // ----- move
  const move = /\bmove\s+(.+?)\s+to\s+day\s*(\d{1,2})/i.exec(text);
  if (move) {
    const words = move[1].toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const target = unpaid.find((i) => words.some((w) => i.title.toLowerCase().includes(w)));
    const day = Math.min(tripDays, Math.max(1, Number(move[2])));
    if (target) {
      return { ops: validateOps(state, [{ op: "update", itemId: target.id, title: target.title, changes: { date: addDays(startDate, day - 1) }, reason: `Moved to day ${day} as asked` }]), understood: true, summary: `Move ${target.title} to day ${day}.` };
    }
  }

  // ----- remove
  if (/\b(remove|drop|delete|skip|cancel|no more|get rid of|without)\b/i.test(text)) {
    const words = lower
      .replace(/\b(remove|drop|delete|skip|cancel|no more|get rid of|without|the|a|an|all|any|from|plan|trip|please|activities|activity)\b/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);
    const hits = unpaid.filter((i) => words.some((w) => i.title.toLowerCase().includes(w)) || itemTags(i).some((t) => tags.includes(t)));
    const paidHits = live.filter((i) => isPaid(i) && (words.some((w) => i.title.toLowerCase().includes(w)) || itemTags(i).some((t) => tags.includes(t))));
    if (hits.length || paidHits.length) {
      return {
        ops: validateOps(state, hits.map((i) => ({ op: "remove" as const, itemId: i.id, title: i.title, reason: "You asked to remove it" }))),
        understood: true,
        summary: `${hits.length ? `Remove ${hits.length} planned item${hits.length === 1 ? "" : "s"}.` : ""}${paidHits.length ? ` ${paidHits.map((p) => p.title).join(", ")} ${paidHits.length === 1 ? "is" : "are"} already paid — cancel from Activity to get the refund.` : ""}`.trim(),
      };
    }
  }

  // ----- cheaper
  if (/\b(cheap|cheaper|budget|save money|less expensive|reduce (the )?cost|cut cost)/i.test(text)) {
    const pricey = [...unpaid].filter((i) => i.category !== "Stay" && i.category !== "Transport").sort((a, b) => b.estimatedPaise - a.estimatedPaise)[0];
    if (pricey) {
      const ptags = itemTags(pricey);
      const alt = ideasFor(destination)
        .filter((idea) => idea.tags.some((t) => ptags.includes(t)) && idea.perPerson * 100 * people < pricey.estimatedPaise && !alreadyHas(idea.title))
        .sort((a, b) => a.perPerson - b.perPerson)[0];
      const ops: PlanOp[] = [{ op: "remove", itemId: pricey.id, title: pricey.title, reason: "Most expensive unpaid item in the plan" }];
      if (alt) ops.push({ op: "add", item: { title: alt.title, category: alt.category, date: pricey.date, estimatedPaise: alt.perPerson * 100 * people }, reason: `Cheaper ${ptags.map(tagLabel).join("/")} option (est. ₹${alt.perPerson.toLocaleString("en-IN")}/person)` });
      return { ops: validateOps(state, ops), understood: true, summary: alt ? `Swap ${pricey.title} for ${alt.title} to save money.` : `Drop ${pricey.title}, the most expensive unpaid item.` };
    }
  }

  // ----- add (default when an activity type is named)
  const addTags = tags.length ? tags : /\b(relax|slow|chill)/i.test(text) ? ["relaxing"] : [];
  if (addTags.length) {
    const ops: PlanOp[] = [];
    const usedDays = new Set<string>();
    for (const tag of addTags) {
      const ideas = ideasFor(destination).filter((i) => i.tags.includes(tag) && !alreadyHas(i.title));
      for (const idea of ideas.slice(0, wanted ?? 1)) {
        const date = wantDay ? addDays(startDate, wantDay - 1) : quietestDay(usedDays);
        usedDays.add(date);
        ops.push({
          op: "add",
          item: { title: idea.title, category: idea.category, date, estimatedPaise: idea.perPerson * 100 * people },
          reason: `${tagLabel(tag)} for your group · est. ₹${idea.perPerson.toLocaleString("en-IN")}/person × ${people}${interests[tag] ? ` · ${interests[tag]} of you like this` : ""}`,
        });
      }
    }
    if (ops.length) return { ops: validateOps(state, ops), understood: true, summary: `Add ${ops.length} ${addTags.map(tagLabel).join(" & ")} option${ops.length === 1 ? "" : "s"} on the quietest day${ops.length === 1 ? "" : "s"}.` };
    return { ops: [], understood: true, summary: `Your plan already has every ${addTags.map(tagLabel).join("/")} idea we know for ${destination.split(",")[0]}.` };
  }

  return {
    ops: [],
    understood: false,
    summary: "The built-in planner understands: add <activity type> (water sports, trek, nightlife, culture, food, spa, games, shopping…), remove <item>, move <item> to day N, make it cheaper, or make a new plan. Add ANTHROPIC_API_KEY for free-form requests.",
  };
}

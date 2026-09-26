import { isValidIso, todayIso } from "@/lib/dates";
import { findAnomalies, tripHealth } from "@/lib/ledger/checks";
import { describeEvent, buildNameLookup } from "@/lib/ledger/describe";
import type { Ledger } from "@/lib/ledger/engine";
import { balanceBreakdown, balanceTimeline } from "@/lib/ledger/explain";
import { describePolicy, pricingOf } from "@/lib/ledger/policy";
import { MAX_EXACT } from "@/lib/ledger/settlement";
import { describeChange, simulate, type Change } from "@/lib/ledger/simulate";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type LedgerEvent, type ParticipantId, type TripState } from "@/lib/ledger/types";
import { formatMoney, parseAmount, sumPaise, type Paise } from "@/lib/money";

/**
 * The AI's only window into the trip. Every tool is a thin, pure adapter over
 * the deterministic ledger engine: it validates the model's input, resolves
 * names to ids (refusing to guess when ambiguous), calls the engine, and
 * returns compact JSON. No tool writes to the event log — simulate_change
 * returns a preview; only the simulator screen's Apply button commits it.
 */

export type ToolContext = {
  state: TripState;
  ledger: Ledger;
  events: LedgerEvent[];
  viewerId: ParticipantId | null;
  /** ISO date used when a what-if gives no date. Defaults to today. */
  today?: string;
  now?: number;
};

export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; candidates?: string[] };

export type ToolName =
  | "get_trip_health"
  | "get_balances"
  | "explain_balance"
  | "get_spending"
  | "list_bookings"
  | "simulate_change"
  | "get_settlement_plan"
  | "get_anomalies"
  | "check_budget_target";

export type ToolDefinition = { name: ToolName; description: string; input_schema: Record<string, unknown> };

const PERSON = { type: "string", description: 'A trip member\'s name or first name (e.g. "Siya"), or "me" for the person asking.' };
const BOOKING = { type: "string", description: 'A booking or expense by title, vendor or keyword (e.g. "villa", "scuba", "flights").' };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_trip_health",
    description: "Trip-level overview: budget, committed, spent, refunds, settled %, outstanding, members, bookings, pending payments and consistency warnings.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_balances",
    description: "Every member's net balance (positive = is owed, negative = owes), who owes the most, who is owed the most, and payments awaiting confirmation.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "explain_balance",
    description: "Why a member's balance is what it is: each booking's paid vs share with the arithmetic, settlements, and the most recent events that changed it.",
    input_schema: { type: "object", properties: { person: PERSON }, required: ["person"], additionalProperties: false },
  },
  {
    name: "get_spending",
    description: "Planned vs paid vs refunded spend, per category (Stay, Transport, Activity, Food, Local travel, Shopping, Other) or for one category.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string", description: "Optional category name or synonym (e.g. accommodation → Stay, flights → Transport)." } },
      additionalProperties: false,
    },
  },
  {
    name: "list_bookings",
    description: "Bookings and expenses with who participates, who paid, pricing (per-head or fixed), cancellation policy and each person's share. Optionally only those involving one person.",
    input_schema: { type: "object", properties: { person: PERSON }, additionalProperties: false },
  },
  {
    name: "simulate_change",
    description:
      "Run a WHAT-IF on a copy of the ledger and return the exact financial impact (refunds under each vendor policy, per-person balance changes with reasons, affected and unaffected bookings, plan estimate change, settlement before/after). NEVER applies anything. kinds: leave-trip (person leaves from date), withdraw (person drops out of one booking), join-booking (person joins a booking), cancel-booking (whole booking cancelled on date), reprice (a booking's or unpaid plan item's price changes: give new_amount OR change_by in rupees), drop-item (an unpaid plan item is removed from the plan).",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["leave-trip", "withdraw", "join-booking", "cancel-booking", "reprice", "drop-item"] },
        person: PERSON,
        booking: BOOKING,
        date: { type: "string", description: "ISO date YYYY-MM-DD the change happens. Defaults to today." },
        new_amount: { type: ["number", "string"], description: "reprice only: the new total price in rupees, e.g. 60000 or \"60,000\"." },
        change_by: { type: ["number", "string"], description: "reprice only: rupees to add (positive) or remove (negative) from the current price, e.g. 5000 or -2000." },
        fixed_price_rule: {
          type: "string",
          enum: ["redistribute", "leaver-pays"],
          description: "For fixed-price bookings (villa, cab): remaining people absorb the cost (default) or the leaver keeps paying.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "get_settlement_plan",
    description: "The minimum set of member-to-member transfers that settles the trip, compared with the naive pairwise count.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_anomalies",
    description: "Deterministic consistency checks: plan vs split mismatches, missing seats, possible duplicates, members who left still charged, unconfirmed payments.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_budget_target",
    description: "Compare the trip against a total budget target: planned estimate, committed with vendors and spent net of refunds, with the headroom or overrun against the target for each, per-person average, and the biggest planned items to cut.",
    input_schema: {
      type: "object",
      properties: { target: { type: ["number", "string"], description: 'Total trip budget in rupees, e.g. 75000, "75,000", "75k" or "1 lakh".' } },
      required: ["target"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- helpers

export const money = (paise: Paise) => ({ text: formatMoney(paise), paise });
/** For changes: "+₹600" / "−₹1,800", so direction is never ambiguous. */
export const delta = (paise: Paise) => ({ text: formatMoney(paise, { signed: true }), paise });

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SELF = new Set(["me", "i", "my", "myself", "mine", "you", "your", "yourself"]);

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string; candidates: string[] };

export function resolvePerson(ctx: ToolContext, query: unknown): Resolved<ParticipantId> {
  const people = ctx.state.participants;
  const all = people.map((p) => p.name);
  if (typeof query !== "string" || !query.trim()) return { ok: false, error: "Which member? A name is required.", candidates: all };
  const q = norm(query);
  if (SELF.has(q)) {
    if (ctx.viewerId && people.some((p) => p.id === ctx.viewerId)) return { ok: true, value: ctx.viewerId };
    return { ok: false, error: "I don't know who 'me' is on this trip. Name the member.", candidates: all };
  }
  const tiers: ((name: string) => boolean)[] = [
    (n) => norm(n) === q,
    (n) => norm(n).split(" ")[0] === q,
    (n) => norm(n).split(" ").some((part) => part === q),
    (n) => q.length >= 3 && norm(n).split(" ").some((part) => part.startsWith(q)),
  ];
  for (const test of tiers) {
    const hits = people.filter((p) => test(p.name));
    if (hits.length === 1) return { ok: true, value: hits[0].id };
    if (hits.length > 1) return { ok: false, error: `"${query}" matches more than one member.`, candidates: hits.map((p) => p.name) };
  }
  return { ok: false, error: `No member called "${query}" on this trip.`, candidates: all };
}

const BOOKING_SYNONYMS: Record<string, string[]> = {
  villa: ["stay", "villa", "hotel", "accommodation", "homestay", "room"],
  flight: ["flight", "flights", "plane", "airline", "indigo", "air"],
  scuba: ["scuba", "dive", "diving"],
  cab: ["cab", "taxi", "pickup", "innova", "transfer"],
};

export function resolveBooking(ctx: ToolContext, query: unknown): Resolved<string> {
  const expenses = ctx.state.expenses;
  const all = expenses.map((e) => e.title);
  if (typeof query !== "string" || !query.trim()) return { ok: false, error: "Which booking? A title or keyword is required.", candidates: all };
  const q = norm(query).replace(/^the /, "");
  const words = q.split(" ").filter((w) => w.length >= 3 && !["the", "our", "booking", "trip"].includes(w));
  const expanded = new Set(words);
  for (const w of words) for (const syns of Object.values(BOOKING_SYNONYMS)) if (syns.includes(w)) syns.forEach((s) => expanded.add(s));

  const score = (e: (typeof expenses)[number]) => {
    const hay = norm(`${e.title} ${e.vendor ?? ""} ${e.category}`);
    if (norm(e.title) === q) return 100;
    if (q.length >= 3 && hay.includes(q)) return 50;
    let s = 0;
    for (const w of expanded) if (hay.split(" ").some((h) => h === w || (w.length >= 4 && h.startsWith(w)))) s += words.includes(w) ? 10 : 4;
    return s;
  };
  const ranked = expenses.map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!ranked.length) return { ok: false, error: `No booking matches "${query}".`, candidates: all };
  const top = ranked.filter((x) => x.s === ranked[0].s);
  if (top.length > 1) return { ok: false, error: `"${query}" matches more than one booking.`, candidates: top.map((x) => x.e.title) };
  return { ok: true, value: ranked[0].e.id };
}

const CATEGORY_SYNONYMS: Record<string, ExpenseCategory> = {
  stay: "Stay",
  stays: "Stay",
  accommodation: "Stay",
  hotel: "Stay",
  hotels: "Stay",
  villa: "Stay",
  lodging: "Stay",
  transport: "Transport",
  flight: "Transport",
  flights: "Transport",
  travel: "Transport",
  train: "Transport",
  activity: "Activity",
  activities: "Activity",
  food: "Food",
  dining: "Food",
  meals: "Food",
  restaurants: "Food",
  "local travel": "Local travel",
  cab: "Local travel",
  cabs: "Local travel",
  taxi: "Local travel",
  shopping: "Shopping",
  other: "Other",
};

export function resolveCategory(query: unknown): Resolved<ExpenseCategory> {
  if (typeof query !== "string" || !query.trim()) return { ok: false, error: "Which category?", candidates: EXPENSE_CATEGORIES };
  const q = norm(query);
  const direct = EXPENSE_CATEGORIES.find((c) => norm(c) === q);
  if (direct) return { ok: true, value: direct };
  if (CATEGORY_SYNONYMS[q]) return { ok: true, value: CATEGORY_SYNONYMS[q] };
  return { ok: false, error: `Unknown category "${query}".`, candidates: EXPENSE_CATEGORIES };
}

/**
 * Rupee input from the model or the offline router → paise. Accepts numbers
 * (rupees) and strings like "75,000", "₹75000", "75k", "1.2 lakh". Negative
 * values are allowed only when `signed` is set (price reductions).
 */
export function parseRupees(value: unknown, signed = false): { ok: true; paise: Paise } | { ok: false; error: string } {
  let text: string;
  if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else if (typeof value === "string" && value.trim()) text = value.trim();
  else return { ok: false, error: "An amount in rupees is required." };
  let negative = false;
  text = text.replace(/^[-−]\s*/, () => {
    negative = true;
    return "";
  });
  if (text.startsWith("+")) text = text.slice(1);
  const lower = text.toLowerCase().replace(/rs\.?|inr|₹/g, "").replace(/,/g, "").trim();
  const unit = /^(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lakhs|lac|cr|crore)?$/.exec(lower);
  if (!unit) return { ok: false, error: `"${String(value)}" is not an amount in rupees.` };
  const mult = unit[2] ? (/^(k|thousand)$/.test(unit[2]) ? 1_000 : /^(cr|crore)$/.test(unit[2]) ? 1_00_00_000 : 1_00_000) : 1;
  const rupees = Number(unit[1]) * mult;
  const parsed = parseAmount(String(Math.round(rupees * 100) / 100));
  if (parsed.paise === undefined) return { ok: false, error: parsed.error };
  if (negative && !signed) return { ok: false, error: "The amount can't be negative." };
  return { ok: true, paise: negative ? -parsed.paise : parsed.paise };
}

/** Unpaid, non-cancelled plan items by title/vendor keyword. */
export function resolvePlanItem(ctx: ToolContext, query: unknown): Resolved<string> {
  const items = ctx.state.itinerary.filter((i) => i.status !== "cancelled" && !i.expenseIds.length);
  const all = items.map((i) => i.title);
  if (typeof query !== "string" || !query.trim()) return { ok: false, error: "Which plan item?", candidates: all };
  const q = norm(query).replace(/^the /, "");
  const words = q.split(" ").filter((w) => w.length >= 3);
  const ranked = items
    .map((i) => {
      const hay = norm(`${i.title} ${i.vendor ?? ""} ${i.category}`);
      if (norm(i.title) === q) return { i, s: 100 };
      if (q.length >= 3 && hay.includes(q)) return { i, s: 50 };
      return { i, s: words.filter((w) => hay.split(" ").some((h) => h === w || (w.length >= 4 && h.startsWith(w)))).length * 10 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return { ok: false, error: `No unpaid plan item matches "${query}".`, candidates: all };
  const top = ranked.filter((x) => x.s === ranked[0].s);
  if (top.length > 1) return { ok: false, error: `"${query}" matches more than one plan item.`, candidates: top.map((x) => x.i.title) };
  return { ok: true, value: ranked[0].i.id };
}

function nameFn(ctx: ToolContext) {
  return (id: ParticipantId) => ctx.state.participants.find((p) => p.id === id)?.name ?? "Former member";
}

function fail(r: { error: string; candidates?: string[] }): ToolResult {
  return { ok: false, error: r.error, candidates: r.candidates };
}

// ---------------------------------------------------------------- executors

function getTripHealth(ctx: ToolContext): ToolResult {
  const anomalies = findAnomalies(ctx.state, ctx.ledger);
  const h = tripHealth(ctx.state, ctx.ledger, anomalies);
  return {
    ok: true,
    data: {
      trip: { name: ctx.state.trip.name, destination: ctx.state.trip.destination, startDate: ctx.state.trip.startDate, endDate: ctx.state.trip.endDate, status: ctx.state.trip.status },
      budgetPlanned: money(h.budgetPaise),
      committed: money(h.committedPaise),
      spentNetOfRefunds: money(h.spentPaise),
      refunded: money(h.refundedPaise),
      settledPercent: Math.round(h.settledFraction * 100),
      settledBetweenMembers: money(h.settledPaise),
      outstandingBetweenMembers: money(h.outstandingPaise),
      vendorOutstanding: money(h.vendorOutstandingPaise),
      members: h.members,
      membersWhoLeft: h.leftMembers,
      activeBookings: h.bookings,
      cancelledBookings: h.cancelledBookings,
      paymentsAwaitingConfirmation: h.pendingSettlements,
      transfersToSettle: h.transfersToSettle,
      warnings: anomalies.map((a) => ({ severity: a.severity, title: a.title, detail: a.detail })),
      ledgerBalances: ctx.ledger.reconciliationPaise === 0,
    },
  };
}

function getBalances(ctx: ToolContext): ToolResult {
  const name = nameFn(ctx);
  const rows = ctx.state.participants
    .map((p) => {
      const b = ctx.ledger.balances[p.id];
      return {
        name: p.name,
        net: money(b.netPaise),
        position: b.netPaise > 0 ? "is owed" : b.netPaise < 0 ? "owes" : "settled",
        amount: money(Math.abs(b.netPaise)),
        paidToVendors: money(b.paidPaise - b.refundsReceivedPaise),
        share: money(b.sharePaise),
        leftOn: p.leftOn ?? null,
      };
    })
    .sort((a, b) => a.net.paise - b.net.paise);
  const debtor = rows[0] && rows[0].net.paise < 0 ? rows[0] : null;
  const creditor = [...rows].reverse().find((r) => r.net.paise > 0) ?? null;
  return {
    ok: true,
    data: {
      balances: rows,
      owesTheMost: debtor ? { name: debtor.name, amount: money(-debtor.net.paise) } : null,
      isOwedTheMost: creditor ? { name: creditor.name, amount: creditor.net } : null,
      paymentsAwaitingConfirmation: ctx.ledger.pendingSettlements.map((s) => ({ from: name(s.from), to: name(s.to), amount: money(s.amountPaise), note: "balances move only when the recipient confirms" })),
      sumOfAllBalances: money(ctx.ledger.reconciliationPaise),
    },
  };
}

function explainBalance(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const who = resolvePerson(ctx, input.person);
  if (!who.ok) return fail(who);
  const name = nameFn(ctx);
  const b = balanceBreakdown(ctx.state, ctx.ledger, who.value);
  const names = buildNameLookup(ctx.events, null);
  const timeline = balanceTimeline(ctx.events, who.value, name).slice(-5).reverse();
  return {
    ok: true,
    data: {
      person: name(who.value),
      net: money(b.netPaise),
      position: b.netPaise > 0 ? "is owed" : b.netPaise < 0 ? "owes" : "settled",
      amount: money(Math.abs(b.netPaise)),
      bookings: b.lines.map((l) => ({ booking: l.title, status: l.status, paid: money(l.paidPaise), share: money(l.sharePaise), effectOnBalance: delta(l.netPaise), howShareIsComputed: l.formula })),
      settlements: b.settlements.map((s) => ({ direction: s.direction, with: name(s.counterparty), amount: money(s.amountPaise), status: s.status })),
      totals: { paid: money(b.paidPaise), share: money(b.sharePaise), settledNet: money(b.settledNetPaise), net: money(b.netPaise), check: "paid − share + settled = net" },
      recentChanges: timeline.map((t) => ({
        event: describeEvent(t.event, names).title,
        balanceBefore: money(t.netBefore),
        balanceAfter: money(t.netAfter),
        change: delta(t.deltaPaise),
        reasons: t.lines.map((l) => ({ booking: l.title, change: delta(l.deltaPaise), reason: l.reason, ...(l.shareBefore !== undefined ? { shareBefore: money(l.shareBefore), shareAfter: money(l.shareAfter ?? 0) } : {}) })),
      })),
    },
  };
}

function getSpending(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  let only: ExpenseCategory | null = null;
  if (input.category !== undefined && input.category !== null && input.category !== "") {
    const c = resolveCategory(input.category);
    if (!c.ok) return fail(c);
    only = c.value;
  }
  const planned = new Map(ctx.ledger.budget.categories.map((c) => [c.category, c.estimatedPaise]));
  const rows = EXPENSE_CATEGORIES.filter((c) => !only || c === only)
    .map((category) => {
      const inCat = ctx.ledger.expenses.filter((x) => x.expense.category === category);
      const paid = sumPaise(inCat.map((x) => x.expense.amountPaise));
      const refunded = sumPaise(inCat.map((x) => x.refundedPaise));
      return {
        category,
        planned: money(planned.get(category) ?? 0),
        paidToVendors: money(paid),
        refunded: money(refunded),
        netSpend: money(paid - refunded),
        bookings: inCat.map((x) => ({ title: x.expense.title, status: x.expense.status, paid: money(x.expense.amountPaise), refunded: money(x.refundedPaise), netCost: money(x.effectivePaise) })),
      };
    })
    .filter((r) => only || r.bookings.length || r.planned.paise);
  return {
    ok: true,
    data: {
      categories: rows,
      totals: only ? undefined : { planned: money(ctx.ledger.budget.estimatedPaise), paidToVendors: money(ctx.ledger.totals.grossPaise), refunded: money(ctx.ledger.totals.refundedPaise), netSpend: money(ctx.ledger.totals.spendPaise) },
    },
  };
}

function listBookings(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  let pid: ParticipantId | null = null;
  if (input.person !== undefined && input.person !== null && input.person !== "") {
    const who = resolvePerson(ctx, input.person);
    if (!who.ok) return fail(who);
    pid = who.value;
  }
  const name = nameFn(ctx);
  const rows = ctx.ledger.expenses
    .filter((c) => !pid || c.expense.participants.some((p) => p.participantId === pid) || c.expense.payers.some((p) => p.participantId === pid) || c.expense.withdrawals?.some((w) => w.participantId === pid))
    .map((c) => ({
      booking: c.expense.title,
      date: c.expense.date,
      category: c.expense.category,
      status: c.expense.status,
      pricing: pricingOf(c.expense),
      cancellationPolicy: describePolicy(c.expense.cancellationPolicy),
      amount: money(c.expense.amountPaise),
      refunded: money(c.refundedPaise),
      netCost: money(c.effectivePaise),
      paidBy: c.expense.payers.map((p) => ({ name: name(p.participantId), amount: money(p.amountPaise) })),
      participants: c.expense.participants.map((p) => name(p.participantId)),
      droppedOut: (c.expense.withdrawals ?? []).map((w) => ({ name: name(w.participantId), stillBears: money(w.retainedPaise), refunded: money(w.refundPaise) })),
      shares: Object.entries(c.shares).map(([id, s]) => ({ name: name(id), share: money(s) })),
      ...(pid ? { shareOf: { name: name(pid), share: money(c.shares[pid] ?? 0) } } : {}),
    }));
  const planned = ctx.state.itinerary
    .filter((i) => i.status !== "cancelled" && !i.expenseIds.length && (!pid || i.participantIds.includes(pid)))
    .map((i) => ({ item: i.title, date: i.date, estimate: money(i.estimatedPaise), people: i.participantIds.map(name), status: "planned, not paid yet" }));
  return { ok: true, data: { person: pid ? name(pid) : null, bookings: rows, plannedNotYetPaid: planned } };
}

function simulateChange(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const kind = input.kind;
  if (kind !== "leave-trip" && kind !== "withdraw" && kind !== "join-booking" && kind !== "cancel-booking" && kind !== "reprice" && kind !== "drop-item") {
    return { ok: false, error: "kind must be one of leave-trip, withdraw, join-booking, cancel-booking, reprice, drop-item" };
  }
  const date = typeof input.date === "string" && input.date ? input.date : (ctx.today ?? todayIso());
  if (!isValidIso(date)) return { ok: false, error: `"${String(input.date)}" is not a valid YYYY-MM-DD date.` };
  const rule = input.fixed_price_rule === "leaver-pays" ? "leaver-pays" : input.fixed_price_rule === undefined || input.fixed_price_rule === "redistribute" ? "redistribute" : null;
  if (!rule) return { ok: false, error: "fixed_price_rule must be redistribute or leaver-pays" };

  let change: Change;
  if (kind === "reprice") {
    // A paid booking first; otherwise an unpaid plan item (e.g. "dinner").
    const b = resolveBooking(ctx, input.booking);
    const target = b.ok
      ? { expenseId: b.value, current: ctx.state.expenses.find((e) => e.id === b.value)!.amountPaise }
      : (() => {
          const item = resolvePlanItem(ctx, input.booking);
          return item.ok ? { itemId: item.value, current: ctx.state.itinerary.find((i) => i.id === item.value)!.estimatedPaise } : null;
        })();
    if (!target) return b.ok ? { ok: false, error: "No booking or plan item matches." } : fail(b);
    let newAmountPaise: Paise;
    if (input.new_amount !== undefined && input.new_amount !== null && input.new_amount !== "") {
      const amt = parseRupees(input.new_amount);
      if (!amt.ok) return { ok: false, error: amt.error };
      newAmountPaise = amt.paise;
    } else if (input.change_by !== undefined && input.change_by !== null && input.change_by !== "") {
      const by = parseRupees(input.change_by, true);
      if (!by.ok) return { ok: false, error: by.error };
      newAmountPaise = target.current + by.paise;
    } else return { ok: false, error: "reprice needs new_amount or change_by (rupees)." };
    change = "expenseId" in target ? { kind, expenseId: target.expenseId, newAmountPaise } : { kind, itemId: target.itemId, newAmountPaise };
  } else if (kind === "drop-item") {
    const item = resolvePlanItem(ctx, input.booking);
    if (!item.ok) return fail(item);
    change = { kind, itemId: item.value };
  } else if (kind === "cancel-booking") {
    const b = resolveBooking(ctx, input.booking);
    if (!b.ok) return fail(b);
    change = { kind, expenseId: b.value, date };
  } else {
    const who = resolvePerson(ctx, input.person);
    if (!who.ok) return fail(who);
    if (kind === "leave-trip") change = { kind, participantId: who.value, date, rule };
    else {
      const b = resolveBooking(ctx, input.booking);
      if (!b.ok) return fail(b);
      change = kind === "withdraw" ? { kind, participantId: who.value, expenseId: b.value, date, rule } : { kind, participantId: who.value, expenseId: b.value };
    }
  }

  const name = nameFn(ctx);
  // simulate() replays a COPY of the log; ctx.events is never modified.
  const sim = simulate(ctx.events, [change], { actor: ctx.viewerId ?? "system", now: ctx.now ?? Date.now() }, name);
  if (!sim.ok) return { ok: false, error: `The ledger rejected this change: ${sim.error}` };
  const d = sim.diff;
  return {
    ok: true,
    data: {
      simulated: true,
      applied: false,
      note: "Preview only. Nothing was written. The organiser can open this in the simulator and press Apply.",
      change: describeChange(ctx.state, change),
      changeSpec: change,
      tripSpend: { before: money(d.spendBefore), after: money(d.spendAfter), change: delta(d.spendAfter - d.spendBefore) },
      vendorRefunds: d.refundsAdded.map((r) => ({
        booking: ctx.state.expenses.find((e) => e.id === r.expenseId)?.title ?? r.expenseId,
        amount: money(r.amountPaise),
        paidBackTo: name(r.receivedBy),
        reason: r.reason ?? "",
      })),
      people: d.people
        .filter((p) => p.deltaPaise !== 0 || p.lines.length)
        .map((p) => ({
          name: name(p.participantId),
          balanceBefore: money(p.netBefore),
          balanceAfter: money(p.netAfter),
          change: delta(p.deltaPaise),
          reasons: p.lines.map((l) => ({ booking: l.title, change: delta(l.deltaPaise), reason: l.reason, ...(l.shareBefore !== undefined ? { shareBefore: money(l.shareBefore), shareAfter: money(l.shareAfter ?? 0) } : {}) })),
        })),
      unchangedPeople: d.people.filter((p) => p.deltaPaise === 0 && !p.lines.length).map((p) => name(p.participantId)),
      affectedBookings: d.affected.map((b) => ({ booking: b.title, costBefore: money(b.effectiveBefore), costAfter: money(b.effectiveAfter), peopleBefore: b.peopleBefore, peopleAfter: b.peopleAfter, what: b.reason })),
      unaffectedBookings: d.unaffected.map((b) => ({ booking: b.title, why: b.why })),
      plan: {
        estimateBefore: money(d.budget.beforePaise),
        estimateAfter: money(d.budget.afterPaise),
        change: delta(d.budget.deltaPaise),
        items: d.budget.lines.map((l) => ({ item: l.title, before: money(l.beforePaise), after: money(l.afterPaise), change: delta(l.deltaPaise), reason: l.reason })),
      },
      ledgerEventsToWrite: sim.events.length,
      settlement: {
        transfersBefore: d.transfersBefore.length,
        transfersAfter: d.transfersAfter.length,
        planAfter: d.transfersAfter.map((t) => ({ from: name(t.from), to: name(t.to), amount: money(t.amountPaise) })),
      },
      ledgerStillBalances: d.reconciliationAfter === 0,
    },
  };
}

function getSettlementPlan(ctx: ToolContext): ToolResult {
  const name = nameFn(ctx);
  const nonZero = Object.values(ctx.ledger.balances).filter((b) => b.provisionalNetPaise !== 0).length;
  return {
    ok: true,
    data: {
      transfers: ctx.ledger.transfers.map((t) => ({ from: name(t.from), to: name(t.to), amount: money(t.amountPaise) })),
      transferCount: ctx.ledger.transfers.length,
      naivePairwiseDebts: ctx.ledger.naiveTransferCount,
      basedOn: "net balances including payments already sent but not yet confirmed",
      peopleWithBalance: nonZero,
      algorithm:
        nonZero <= MAX_EXACT
          ? `The ${nonZero} non-zero balances are split into the largest number of independent zero-sum groups (${nonZero - ctx.ledger.transfers.length}) by an exact search over subsets; a group of k people needs k−1 transfers, so this is the minimum possible number of transfers.`
          : `More than ${MAX_EXACT} people have a balance, so transfers are chosen greedily (largest debtor pays largest creditor): at most n−1 transfers, not guaranteed minimal.`,
      paymentsAwaitingConfirmation: ctx.ledger.pendingSettlements.map((s) => ({ from: name(s.from), to: name(s.to), amount: money(s.amountPaise) })),
    },
  };
}

function getAnomalies(ctx: ToolContext): ToolResult {
  const anomalies = findAnomalies(ctx.state, ctx.ledger);
  return {
    ok: true,
    data: {
      count: anomalies.length,
      detectedBy: "deterministic rules over the ledger (no AI)",
      anomalies: anomalies.map((a) => ({ severity: a.severity, title: a.title, detail: a.detail })),
    },
  };
}

function checkBudgetTarget(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const target = parseRupees(input.target);
  if (!target.ok) return { ok: false, error: target.error };
  if (target.paise <= 0) return { ok: false, error: "The target must be above ₹0." };
  const b = ctx.ledger.budget;
  const compare = (value: Paise) => {
    const diff = target.paise - value;
    return diff >= 0 ? { within: true, headroom: money(diff) } : { within: false, overBy: money(-diff) };
  };
  const members = ctx.state.participants.filter((p) => !p.leftOn).length || 1;
  const levers = b.items
    .filter((x) => x.item.status !== "cancelled")
    .sort((x, y) => y.estimatedPaise - x.estimatedPaise)
    .slice(0, 3)
    .map((x) => ({ item: x.item.title, planned: money(x.estimatedPaise), status: x.item.status, people: x.item.participantIds.length }));
  return {
    ok: true,
    data: {
      target: money(target.paise),
      planned: { amount: money(b.estimatedPaise), ...compare(b.estimatedPaise) },
      committedWithVendors: { amount: money(b.committedPaise), ...compare(b.committedPaise) },
      spentNetOfRefunds: { amount: money(ctx.ledger.totals.spendPaise), ...compare(ctx.ledger.totals.spendPaise) },
      plannedPerPerson: money(Math.round(b.estimatedPaise / members)),
      targetPerPerson: money(Math.round(target.paise / members)),
      members,
      biggestPlannedItems: levers,
      note: "Differences are computed by the ledger engine. Planned = itinerary estimates; committed = booked prices; spent = paid to vendors minus refunds.",
    },
  };
}

export function runTool(name: string, input: unknown, ctx: ToolContext): ToolResult {
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    switch (name as ToolName) {
      case "get_trip_health":
        return getTripHealth(ctx);
      case "get_balances":
        return getBalances(ctx);
      case "explain_balance":
        return explainBalance(ctx, args);
      case "get_spending":
        return getSpending(ctx, args);
      case "list_bookings":
        return listBookings(ctx, args);
      case "simulate_change":
        return simulateChange(ctx, args);
      case "get_settlement_plan":
        return getSettlementPlan(ctx);
      case "get_anomalies":
        return getAnomalies(ctx);
      case "check_budget_target":
        return checkBudgetTarget(ctx, args);
      default:
        return { ok: false, error: `Unknown tool "${name}".` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

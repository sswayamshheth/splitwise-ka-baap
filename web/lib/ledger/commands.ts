import { newId } from "@/lib/id";
import type { Interests } from "@/lib/interests";
import { isValidIso } from "@/lib/dates";
import { allocate, isPaise, sumPaise, type Paise } from "@/lib/money";
import { computeBudget } from "./budget";
import { computeExpense, computeLedger } from "./engine";
import { planScalesWithHeadcount, pricingOf, refundPercentOn, sortedTiers, withoutPlanParticipant } from "./policy";
import { applyEvent } from "./reduce";
import type { CancellationPolicy, ContributionData, ExpenseCategory, ExpenseData, ExpenseId, ExpenseView, FixedLeaveRule, ItineraryItem, ItineraryItemId, LedgerEvent, ParticipantData, ParticipantId, PaymentMethod, PaymentMethodId, RefundData, SettlementData, SettlementId, SettlementMethod, TripMeta, TripState, Withdrawal, TripPlace } from "./types";

/**
 * Commands validate intent against current state and return the event(s) to
 * append. They never mutate state; the store appends what they return. Every
 * rule that protects money conservation lives here so the UI cannot bypass it.
 */

export class CommandError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "CommandError";
    this.field = field;
  }
}

type Ctx = { actor: ParticipantId | "system"; now?: number };

function base(ctx: Ctx) {
  return { id: newId("ev"), ts: ctx.now ?? Date.now(), actor: ctx.actor };
}

const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
export function isValidUpiId(value: string): boolean {
  return UPI_RE.test(value.trim());
}

export function normaliseName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function assertOpen(state: TripState) {
  if (state.trip.status === "closed") throw new CommandError("This trip is closed. Reopen it before making changes.");
}

// ---------------------------------------------------------------- trips

export type TripInput = { name: string; destination: string; startDate: string; endDate: string; description?: string; place?: TripPlace };

/** Keeps a picked place only if its coordinates are real numbers in range. */
export function cleanPlace(p: unknown): TripPlace | undefined {
  const x = p as Partial<TripPlace> | null | undefined;
  if (!x || typeof x.name !== "string" || !x.name.trim()) return undefined;
  const lat = Number(x.lat);
  const lon = Number(x.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);
  return { lat, lon, name: x.name.trim().slice(0, 80), admin: str(x.admin), country: str(x.country), source: "open-meteo-geocoding" };
}

/** "Manali, Himachal Pradesh, India" — the label a picked place is shown and stored as. */
export function placeLabel(p: Pick<TripPlace, "name" | "admin" | "country">): string {
  return [p.name, p.admin, p.country].filter((v, i, a) => v && a.indexOf(v) === i).join(", ");
}

export function validateTrip(input: TripInput): Partial<Record<keyof TripInput, string>> {
  const errors: Partial<Record<keyof TripInput, string>> = {};
  if (!normaliseName(input.name)) errors.name = "Give the trip a name";
  else if (normaliseName(input.name).length > 60) errors.name = "Keep the name under 60 characters";
  if (!normaliseName(input.destination)) errors.destination = "Where are you going?";
  if (!isValidIso(input.startDate)) errors.startDate = "Use YYYY-MM-DD";
  if (!isValidIso(input.endDate)) errors.endDate = "Use YYYY-MM-DD";
  if (!errors.startDate && !errors.endDate && input.endDate < input.startDate) errors.endDate = "End date is before the start";
  return errors;
}

export function createTrip(input: TripInput, ctx: Ctx): { tripId: string; events: LedgerEvent[] } {
  const errors = validateTrip(input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const trip: TripMeta = {
    id: newId("trip"),
    name: normaliseName(input.name),
    destination: normaliseName(input.destination),
    place: cleanPlace(input.place),
    startDate: input.startDate,
    endDate: input.endDate,
    description: input.description?.trim() || undefined,
    currency: "INR",
    status: "active",
  };
  return { tripId: trip.id, events: [{ ...base(ctx), type: "TRIP_CREATED", trip }] };
}

export function updateTrip(state: TripState, input: TripInput, ctx: Ctx): LedgerEvent {
  const errors = validateTrip(input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const after: Partial<TripMeta> = {
    name: normaliseName(input.name),
    destination: normaliseName(input.destination),
    startDate: input.startDate,
    endDate: input.endDate,
    description: input.description?.trim() || undefined,
  };
  const before: Partial<TripMeta> = {};
  for (const key of Object.keys(after) as (keyof TripMeta)[]) {
    if (state.trip[key] !== after[key]) (before as Record<string, unknown>)[key] = state.trip[key];
    else delete (after as Record<string, unknown>)[key];
  }
  if (Object.keys(after).length === 0) throw new CommandError("Nothing changed");
  return { ...base(ctx), type: "TRIP_UPDATED", before, after };
}

export function closeTrip(state: TripState, ctx: Ctx): LedgerEvent {
  if (state.trip.status === "closed") throw new CommandError("This trip is already closed");
  const ledger = computeLedger(state);
  const budget = computeBudget(state);
  const outstanding = sumPaise(
    Object.values(ledger.balances)
      .map((b) => b.netPaise)
      .filter((n) => n > 0),
  );
  return {
    ...base(ctx),
    type: "TRIP_CLOSED",
    summary: {
      plannedPaise: budget.estimatedPaise,
      actualPaise: ledger.totals.spendPaise,
      settledPaise: sumPaise(ledger.confirmedSettlements.map((s) => s.amountPaise)),
      outstandingPaise: outstanding,
    },
  };
}

export function reopenTrip(state: TripState, ctx: Ctx): LedgerEvent {
  if (state.trip.status !== "closed") throw new CommandError("This trip is already open");
  return { ...base(ctx), type: "TRIP_REOPENED" };
}

// ---------------------------------------------------------------- participants

export type ParticipantInput = { name: string; upiId?: string; phone?: string };

export function validateParticipant(state: TripState | null, input: ParticipantInput, excludeId?: ParticipantId) {
  const errors: Partial<Record<keyof ParticipantInput, string>> = {};
  const name = normaliseName(input.name);
  if (!name) errors.name = "Enter a name";
  else if (name.length > 40) errors.name = "Keep the name under 40 characters";
  else if (state?.participants.some((p) => p.id !== excludeId && p.name.toLowerCase() === name.toLowerCase())) {
    errors.name = `${name} is already on this trip`;
  }
  const upi = input.upiId?.trim();
  if (upi && !isValidUpiId(upi)) errors.upiId = "UPI IDs look like name@bank";
  const phone = input.phone?.replace(/\s/g, "");
  if (phone && !/^(\+91)?[6-9]\d{9}$/.test(phone)) errors.phone = "Enter a 10-digit Indian mobile number";
  return errors;
}

export function addParticipant(state: TripState, input: ParticipantInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const errors = validateParticipant(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const participant: ParticipantData = {
    id: newId("p"),
    name: normaliseName(input.name),
    upiId: input.upiId?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    paymentMethods: [],
  };
  return { ...base(ctx), type: "PARTICIPANT_ADDED", participant };
}

export function updateParticipant(state: TripState, participantId: ParticipantId, input: ParticipantInput, ctx: Ctx): LedgerEvent {
  const current = state.participants.find((p) => p.id === participantId);
  if (!current) throw new CommandError("That member is no longer on the trip");
  const errors = validateParticipant(state, input, participantId);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const after: Partial<ParticipantData> = {
    name: normaliseName(input.name),
    upiId: input.upiId?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
  };
  const before: Partial<ParticipantData> = {};
  for (const key of ["name", "upiId", "phone"] as const) {
    if ((current[key] ?? "") !== (after[key] ?? "")) before[key] = current[key];
    else delete after[key];
  }
  if (Object.keys(after).length === 0) throw new CommandError("Nothing changed");
  return { ...base(ctx), type: "PARTICIPANT_UPDATED", participantId, before, after };
}

/** Why a member can't be removed, or null if they can. */
export function removalBlocker(state: TripState, participantId: ParticipantId): string | null {
  const p = state.participants.find((x) => x.id === participantId);
  if (!p) return "That member is no longer on the trip";
  if (state.participants.length === 1) return "A trip needs at least one member";
  const paid = state.expenses.filter((e) => e.payers.some((x) => x.participantId === participantId));
  if (paid.length) return `${p.name} paid for ${paid.length} expense${paid.length === 1 ? "" : "s"}. Change the payer first.`;
  const refunds = state.refunds.filter((r) => r.receivedBy === participantId);
  if (refunds.length) return `${p.name} received a refund. Edit that refund first.`;
  const settlements = state.settlements.filter((s) => s.status !== "cancelled" && (s.from === participantId || s.to === participantId));
  if (settlements.length) return `${p.name} is part of a settlement. Cancel or keep it first.`;
  const contributions = state.contributions.filter((c) => c.participantId === participantId);
  if (contributions.length) return `${p.name} contributed to the trip kitty. Remove that contribution first.`;
  const sole = state.expenses.filter((e) => e.participants.length === 1 && e.participants[0].participantId === participantId);
  if (sole.length) return `${p.name} is the only person on "${sole[0].title}". Edit or delete that expense first.`;
  return null;
}

export function removeParticipant(state: TripState, participantId: ParticipantId, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const blocker = removalBlocker(state, participantId);
  if (blocker) throw new CommandError(blocker);
  const p = state.participants.find((x) => x.id === participantId)!;
  return {
    ...base(ctx),
    type: "PARTICIPANT_REMOVED",
    participantId,
    name: p.name,
    removedFromExpenses: state.expenses.filter((e) => e.participants.some((x) => x.participantId === participantId)).map((e) => e.id),
    removedFromItinerary: state.itinerary.filter((i) => i.participantIds.includes(participantId)).map((i) => i.id),
  };
}

/** Sets (or clears) a member's travel preferences. Recorded like any other member update. */
export function setParticipantInterests(state: TripState, participantId: ParticipantId, interests: Interests | undefined, ctx: Ctx): LedgerEvent {
  const current = state.participants.find((p) => p.id === participantId);
  if (!current) throw new CommandError("That member is not on the trip");
  if (JSON.stringify(current.interests ?? null) === JSON.stringify(interests ?? null)) throw new CommandError("Nothing changed");
  return { ...base(ctx), type: "PARTICIPANT_UPDATED", participantId, before: { interests: current.interests }, after: { interests } };
}

// ---------------------------------------------------------------- payment methods

export type PaymentMethodInput = {
  label: string;
  bank: string;
  kind: PaymentMethod["kind"];
  network?: PaymentMethod["network"];
  last4?: string;
  headroomPaise?: Paise;
  upiId?: string;
};

export function validatePaymentMethod(input: PaymentMethodInput) {
  const errors: Partial<Record<keyof PaymentMethodInput, string>> = {};
  if (!normaliseName(input.label)) errors.label = "Name the card or account";
  if (!normaliseName(input.bank)) errors.bank = "Which bank?";
  if (input.last4 && !/^\d{4}$/.test(input.last4)) errors.last4 = "Exactly four digits — never the full number";
  if (input.upiId && !isValidUpiId(input.upiId)) errors.upiId = "UPI IDs look like name@bank";
  if (input.headroomPaise !== undefined && (!isPaise(input.headroomPaise) || input.headroomPaise < 0)) errors.headroomPaise = "Enter a valid limit";
  return errors;
}

export function addPaymentMethod(state: TripState, participantId: ParticipantId, input: PaymentMethodInput, ctx: Ctx): LedgerEvent {
  if (!state.participants.some((p) => p.id === participantId)) throw new CommandError("That member is no longer on the trip");
  const errors = validatePaymentMethod(input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const method: PaymentMethod = {
    id: newId("pm"),
    kind: input.kind,
    label: normaliseName(input.label),
    bank: normaliseName(input.bank),
    network: input.network,
    last4: input.last4 || undefined,
    headroomPaise: input.headroomPaise,
    upiId: input.upiId?.trim() || undefined,
  };
  return { ...base(ctx), type: "PAYMENT_METHOD_ADDED", participantId, method };
}

export function removePaymentMethod(state: TripState, participantId: ParticipantId, methodId: PaymentMethodId, ctx: Ctx): LedgerEvent {
  const p = state.participants.find((x) => x.id === participantId);
  const method = p?.paymentMethods?.find((m) => m.id === methodId);
  if (!method) throw new CommandError("That payment method no longer exists");
  if (state.expenses.some((e) => e.paymentMethodId === methodId && e.status === "active")) {
    throw new CommandError(`${method.label} was used on an expense. Change that expense first.`);
  }
  return { ...base(ctx), type: "PAYMENT_METHOD_REMOVED", participantId, methodId, label: method.label };
}

// ---------------------------------------------------------------- itinerary

const pctOk = (pct: number) => Number.isFinite(pct) && pct >= 0 && pct <= 100;

export function validatePolicy(policy: CancellationPolicy | undefined): string | undefined {
  if (!policy) return undefined;
  if (!pctOk(policy.refundPercent)) return "Refundable percentage must be 0–100";
  for (const tier of policy.tiers ?? []) {
    if (!isValidIso(tier.until)) return "Each refund tier needs a date (YYYY-MM-DD)";
    if (!pctOk(tier.refundPercent)) return "Refundable percentage must be 0–100";
  }
  return undefined;
}

/** Normalises a policy, keeping its date tiers sorted. */
export function cleanPolicy(policy: CancellationPolicy | undefined): CancellationPolicy | undefined {
  if (!policy) return undefined;
  const tiers = sortedTiers(policy).map((t) => ({ until: t.until, refundPercent: Math.round(t.refundPercent) }));
  return {
    refundPercent: Math.round(policy.refundPercent),
    ...(tiers.length ? { tiers } : {}),
    note: policy.note?.trim() || undefined,
  };
}

export type ItineraryInput = {
  title: string;
  category: ExpenseCategory;
  date: string;
  endDate?: string;
  time?: string;
  location?: string;
  vendor?: string;
  vendorUpi?: string;
  vendorUpiName?: string;
  estimatedPaise: Paise;
  actualPaise?: Paise;
  participantIds: ParticipantId[];
  weights?: number[];
  notes?: string;
  cancellationPolicy?: CancellationPolicy;
  status?: ItineraryItem["status"];
};

export type ItineraryErrors = Partial<Record<"title" | "date" | "endDate" | "estimated" | "actual" | "participants" | "policy" | "vendorUpi", string>>;

export function validateItinerary(state: TripState, input: ItineraryInput): ItineraryErrors {
  const errors: ItineraryErrors = {};
  const ids = new Set(state.participants.map((p) => p.id));
  if (!normaliseName(input.title)) errors.title = "What is this item?";
  else if (normaliseName(input.title).length > 80) errors.title = "Keep the title under 80 characters";
  if (!isValidIso(input.date)) errors.date = "Use YYYY-MM-DD";
  if (input.endDate && !isValidIso(input.endDate)) errors.endDate = "Use YYYY-MM-DD";
  else if (input.endDate && isValidIso(input.date) && input.endDate < input.date) errors.endDate = "End date is before the start";
  if (!isPaise(input.estimatedPaise) || input.estimatedPaise < 0) errors.estimated = "Enter a valid estimate";
  if (input.actualPaise !== undefined && (!isPaise(input.actualPaise) || input.actualPaise < 0)) errors.actual = "Enter a valid booked price";
  if (input.participantIds.length === 0) errors.participants = "Pick who this is for";
  else if (input.participantIds.some((id) => !ids.has(id))) errors.participants = "Someone here is not on this trip";
  else if (new Set(input.participantIds).size !== input.participantIds.length) errors.participants = "Each person can appear once";
  if (input.weights && input.weights.length !== input.participantIds.length) errors.participants = "Shares must match the people picked";
  else if (input.weights && (input.weights.some((w) => !Number.isFinite(w) || w < 0) || !input.weights.some((w) => w > 0))) {
    errors.participants = "At least one share must be more than zero";
  }
  const policyError = validatePolicy(input.cancellationPolicy);
  if (input.vendorUpi && !isValidUpiId(input.vendorUpi)) errors.vendorUpi = "UPI IDs look like name@bank";
  if (policyError) errors.policy = policyError;
  return errors;
}

export function buildItineraryItem(input: ItineraryInput, id = newId("it"), source: ItineraryItem["source"] = "manual"): ItineraryItem {
  return {
    id,
    title: normaliseName(input.title),
    category: input.category,
    date: input.date,
    endDate: input.endDate || undefined,
    time: input.time?.trim() || undefined,
    location: input.location?.trim() || undefined,
    vendor: input.vendor?.trim() || undefined,
    vendorUpi: input.vendorUpi?.trim() || undefined,
    vendorUpiName: input.vendorUpiName?.trim() || undefined,
    estimatedPaise: input.estimatedPaise,
    actualPaise: input.actualPaise,
    participantIds: [...input.participantIds],
    weights: input.weights ? [...input.weights] : undefined,
    status: input.status ?? "planned",
    notes: input.notes?.trim() || undefined,
    cancellationPolicy: cleanPolicy(input.cancellationPolicy),
    expenseIds: [],
    source,
  };
}

export function addItineraryItem(state: TripState, input: ItineraryInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const errors = validateItinerary(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  return { ...base(ctx), type: "ITINERARY_ITEM_ADDED", item: buildItineraryItem(input) };
}

export function importItinerary(state: TripState, items: ItineraryInput[], sourceName: string, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  if (items.length === 0) throw new CommandError("Nothing to import");
  const built = items.map((input, i) => {
    const errors = validateItinerary(state, input);
    const first = Object.entries(errors)[0];
    if (first) throw new CommandError(`Item ${i + 1} (${input.title || "untitled"}): ${first[1]}`, first[0]);
    return buildItineraryItem(input, newId("it"), "imported");
  });
  return { ...base(ctx), type: "ITINERARY_IMPORTED", items: built, sourceName };
}

export function updateItineraryItem(state: TripState, itemId: ItineraryItemId, input: ItineraryInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const current = state.itinerary.find((i) => i.id === itemId);
  if (!current) throw new CommandError("That itinerary item no longer exists");
  const errors = validateItinerary(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const after: ItineraryItem = {
    ...buildItineraryItem(input, itemId, current.source),
    status: input.status ?? current.status,
    expenseIds: current.expenseIds,
  };
  if (JSON.stringify(current) === JSON.stringify(after)) throw new CommandError("Nothing changed");
  return { ...base(ctx), type: "ITINERARY_ITEM_UPDATED", itemId, before: current, after };
}

export function removeItineraryItem(state: TripState, itemId: ItineraryItemId, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const item = state.itinerary.find((i) => i.id === itemId);
  if (!item) throw new CommandError("That itinerary item no longer exists");
  if (item.expenseIds.length) {
    throw new CommandError(`"${item.title}" already has ${item.expenseIds.length} payment${item.expenseIds.length === 1 ? "" : "s"} against it. Cancel it instead of removing it.`);
  }
  return { ...base(ctx), type: "ITINERARY_ITEM_REMOVED", itemId, item };
}

/** Turns a planned item into an expense form draft: money actually moving. */
export function expenseDraftFromItem(item: ItineraryItem, payerId: ParticipantId): ExpenseInput {
  const amount = item.actualPaise ?? item.estimatedPaise;
  return {
    title: item.title,
    vendor: item.vendor,
    amountPaise: amount,
    date: item.date,
    category: item.category,
    payers: [{ participantId: payerId, amountPaise: amount }],
    participants: item.participantIds.map((id, i) => ({ participantId: id, weight: item.weights?.[i] ?? 1 })),
    splitMode: item.weights ? "weighted" : "equal",
    notes: item.notes,
    cancellationPolicy: item.cancellationPolicy,
    itineraryItemId: item.id,
  };
}

// ---------------------------------------------------------------- expenses

export type ExpenseInput = Omit<ExpenseData, "id">;

export type ExpenseErrors = Partial<Record<"title" | "amount" | "date" | "payers" | "participants" | "policy" | "discount", string>>;

export function validateExpense(state: TripState, input: ExpenseInput): ExpenseErrors {
  const errors: ExpenseErrors = {};
  const ids = new Set(state.participants.map((p) => p.id));
  if (!normaliseName(input.title)) errors.title = "What was this for?";
  else if (normaliseName(input.title).length > 80) errors.title = "Keep the title under 80 characters";
  if (!isPaise(input.amountPaise) || input.amountPaise < 0) errors.amount = "Enter a valid amount";
  else if (input.amountPaise === 0) errors.amount = "Amount must be more than ₹0";
  if (!isValidIso(input.date)) errors.date = "Use YYYY-MM-DD";

  if (input.payers.length === 0) errors.payers = "Who paid?";
  else if (input.payers.some((p) => !ids.has(p.participantId))) errors.payers = "A payer is not on this trip";
  else if (input.payers.some((p) => !isPaise(p.amountPaise) || p.amountPaise < 0)) errors.payers = "Payer amounts must be valid";
  else if (new Set(input.payers.map((p) => p.participantId)).size !== input.payers.length) errors.payers = "Each payer can appear once";
  else if (!errors.amount && sumPaise(input.payers.map((p) => p.amountPaise)) !== input.amountPaise) {
    errors.payers = "Payer amounts must add up to the expense amount";
  }

  if (input.participants.length === 0) errors.participants = "Pick at least one person to share this";
  else if (input.participants.some((p) => !ids.has(p.participantId))) errors.participants = "A participant is not on this trip";
  else if (new Set(input.participants.map((p) => p.participantId)).size !== input.participants.length) errors.participants = "Each person can appear once";
  else if (input.participants.some((p) => !Number.isFinite(p.weight) || p.weight < 0)) errors.participants = "Shares must be valid";
  else if (!input.participants.some((p) => p.weight > 0)) errors.participants = "At least one share must be more than zero";
  else if (input.splitMode === "exact" && !errors.amount && sumPaise(input.participants.map((p) => p.weight)) !== input.amountPaise) {
    errors.participants = "Exact shares must add up to the expense amount";
  }

  const policyError = validatePolicy(input.cancellationPolicy);
  if (policyError) errors.policy = policyError;
  if (input.discountPaise !== undefined) {
    if (!isPaise(input.discountPaise) || input.discountPaise < 0) errors.discount = "Enter a valid discount";
    else if (!errors.amount && input.discountPaise > input.amountPaise) errors.discount = "Discount can't be more than the bill";
  }
  if (input.itineraryItemId && !state.itinerary.some((i) => i.id === input.itineraryItemId)) {
    errors.title = "The linked itinerary item no longer exists";
  }
  return errors;
}

function cleanExpense(input: ExpenseInput): ExpenseInput {
  return {
    ...input,
    title: normaliseName(input.title),
    vendor: input.vendor?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    participants: input.participants.filter((p) => p.weight > 0 || input.splitMode !== "equal"),
    cancellationPolicy: cleanPolicy(input.cancellationPolicy),
  };
}

export function addExpense(state: TripState, input: ExpenseInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const errors = validateExpense(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const gone = input.participants.map((p) => state.participants.find((x) => x.id === p.participantId)).find((p) => p?.leftOn);
  if (gone) throw new CommandError(`${gone.name} left the trip on ${gone.leftOn} and can't share new expenses`, "participants");
  const expense: ExpenseData = { id: newId("x"), ...cleanExpense(input) };
  return { ...base(ctx), type: "EXPENSE_ADDED", expense };
}

export function updateExpense(state: TripState, expenseId: ExpenseId, input: ExpenseInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const current = state.expenses.find((e) => e.id === expenseId);
  if (!current) throw new CommandError("That expense no longer exists");
  if (current.status === "cancelled") throw new CommandError("Cancelled bookings can't be edited");
  const errors = validateExpense(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const before = new Set(current.participants.map((p) => p.participantId));
  for (const p of input.participants) {
    if (before.has(p.participantId)) continue;
    const who = state.participants.find((x) => x.id === p.participantId);
    if (who?.leftOn) throw new CommandError(`${who.name} left the trip and can't be added`, "participants");
    if (current.withdrawals?.some((w) => w.participantId === p.participantId)) {
      throw new CommandError(`${who?.name ?? "They"} already withdrew from this booking`, "participants");
    }
  }
  const refunded = sumPaise(state.refunds.filter((r) => r.expenseId === expenseId).map((r) => r.amountPaise));
  if (input.amountPaise < refunded) {
    throw new CommandError("This expense already has refunds totalling more than the new amount", "amount");
  }
  const { status: _s, cancellation: _c, withdrawals: _w, ...beforeData } = current;
  const after: ExpenseData = { id: expenseId, ...cleanExpense(input) };
  if (JSON.stringify(beforeData) === JSON.stringify(after)) throw new CommandError("Nothing changed");
  return { ...base(ctx), type: "EXPENSE_UPDATED", expenseId, before: beforeData as ExpenseData, after };
}

export function deleteExpense(state: TripState, expenseId: ExpenseId, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const current = state.expenses.find((e) => e.id === expenseId);
  if (!current) throw new CommandError("That expense no longer exists");
  if (current.withdrawals?.length) {
    throw new CommandError("Someone withdrew from this booking with a vendor refund. Cancel it instead of deleting it.");
  }
  const { status: _s, cancellation: _c, withdrawals: _w, ...data } = current;
  return { ...base(ctx), type: "EXPENSE_DELETED", expenseId, expense: data as ExpenseData };
}

/** The largest payer — the card or account a vendor refund goes back to. */
export function refundRecipient(expense: ExpenseData): ParticipantId | undefined {
  return expense.payers.length ? [...expense.payers].sort((a, b) => b.amountPaise - a.amountPaise)[0].participantId : undefined;
}

/** Value still held with the vendor: per-head seats already withdrawn were dealt with at the time. */
export function bookedValue(expense: ExpenseView): Paise {
  const withdrawnSeats = sumPaise((expense.withdrawals ?? []).filter((w) => w.pricing === "per-head").map((w) => w.seatPaise));
  return Math.max(0, expense.amountPaise - withdrawnSeats);
}

/**
 * Preview of what cancelling under the vendor's policy would do — shown before
 * the user confirms. The refundable percentage comes from the policy tier that
 * applies on `date` unless an explicit percentage is given.
 */
export function previewCancellation(state: TripState, expenseId: ExpenseId, refundPercent?: number, date?: string) {
  const expense = state.expenses.find((e) => e.id === expenseId);
  if (!expense) throw new CommandError("That expense no longer exists");
  const pct = refundPercent ?? (date ? refundPercentOn(expense.cancellationPolicy, date) : (expense.cancellationPolicy?.refundPercent ?? 0));
  const already = sumPaise(state.refunds.filter((r) => r.expenseId === expenseId).map((r) => r.amountPaise));
  const recoverable = Math.min(expense.amountPaise - already, Math.round((bookedValue(expense) * pct) / 100));
  const loss = expense.amountPaise - already - recoverable;
  return { expense, refundPercent: pct, recoverablePaise: Math.max(0, recoverable), lossPaise: Math.max(0, loss), receivedBy: refundRecipient(expense) };
}

export function cancelExpense(
  state: TripState,
  expenseId: ExpenseId,
  opts: { refundPercent?: number; receivedBy?: ParticipantId; date: string; reason?: string },
  ctx: Ctx,
): LedgerEvent {
  assertOpen(state);
  if (!isValidIso(opts.date)) throw new CommandError("Use YYYY-MM-DD", "date");
  const preview = previewCancellation(state, expenseId, opts.refundPercent, opts.date);
  if (preview.expense.status === "cancelled") throw new CommandError("This booking is already cancelled");
  if (!Number.isFinite(preview.refundPercent) || preview.refundPercent < 0 || preview.refundPercent > 100) {
    throw new CommandError("Refundable percentage must be 0–100", "policy");
  }
  let refund: RefundData | undefined;
  if (preview.recoverablePaise > 0) {
    const receivedBy = opts.receivedBy ?? preview.receivedBy;
    if (!receivedBy || !state.participants.some((p) => p.id === receivedBy)) throw new CommandError("Who received the refund?", "receivedBy");
    refund = {
      id: newId("rf"),
      expenseId,
      amountPaise: preview.recoverablePaise,
      receivedBy,
      date: opts.date,
      reason: opts.reason?.trim() || `Cancelled · ${preview.refundPercent}% refundable`,
      source: "cancellation",
    };
  }
  return {
    ...base(ctx),
    type: "EXPENSE_CANCELLED",
    expenseId,
    refund,
    recoverablePaise: preview.recoverablePaise,
    lossPaise: preview.lossPaise,
    refundPercent: preview.refundPercent,
  };
}

// ---------------------------------------------------------------- participation changes

/** The date a booking is consumed: the linked itinerary item's date, else the expense date. */
export function bookingDate(state: TripState, expense: ExpenseData): string {
  const item = expense.itineraryItemId ? state.itinerary.find((i) => i.id === expense.itineraryItemId) : undefined;
  return item?.date ?? expense.date;
}

export type WithdrawInput = { participantId: ParticipantId; expenseId: ExpenseId; date: string; rule?: FixedLeaveRule };

/**
 * One person drops out of one booking that is already paid for.
 *  - per-head: the vendor refunds their seat per the policy tier on `date`;
 *    they keep the non-refundable part; everyone else's share is unchanged.
 *  - fixed price: the vendor refunds nothing (the villa costs the same). By
 *    default the remaining people absorb it; with "leaver-pays" the leaver
 *    keeps their share and nobody else moves.
 */
export function withdrawFromBooking(state: TripState, input: WithdrawInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  if (!isValidIso(input.date)) throw new CommandError("Use YYYY-MM-DD", "date");
  const expense = state.expenses.find((e) => e.id === input.expenseId);
  if (!expense) throw new CommandError("That booking no longer exists");
  if (expense.status === "cancelled") throw new CommandError(`"${expense.title}" is already cancelled`);
  const person = state.participants.find((p) => p.id === input.participantId);
  if (!person) throw new CommandError("That member is not on this trip");
  if (!expense.participants.some((p) => p.participantId === input.participantId)) {
    throw new CommandError(`${person.name} is not part of "${expense.title}"`);
  }
  const others = expense.participants.filter((p) => p.participantId !== input.participantId && p.weight > 0);
  if (others.length === 0) throw new CommandError(`${person.name} is the only person on "${expense.title}". Cancel the booking instead.`);

  const computed = computeExpense(expense, state.refunds);
  const seat = computed.shares[input.participantId] ?? 0;
  const pricing = pricingOf(expense);
  let refundPercent = 0;
  let refundPaise = 0;
  let retainedPaise = seat;
  let rule: FixedLeaveRule | undefined;
  if (pricing === "per-head") {
    refundPercent = refundPercentOn(expense.cancellationPolicy, input.date);
    refundPaise = Math.min(Math.round((seat * refundPercent) / 100), refundableRemaining(state, expense.id));
    retainedPaise = seat - refundPaise;
  } else {
    rule = input.rule ?? "redistribute";
    retainedPaise = rule === "leaver-pays" ? seat : 0;
  }

  const withdrawal: Withdrawal = {
    participantId: input.participantId,
    date: input.date,
    pricing,
    rule,
    seatPaise: seat,
    refundPercent,
    refundPaise,
    retainedPaise,
    ts: ctx.now ?? Date.now(),
  };
  let refund: RefundData | undefined;
  if (refundPaise > 0) {
    const receivedBy = refundRecipient(expense);
    if (!receivedBy) throw new CommandError("Nobody paid for this booking, so there is no one to refund");
    refund = {
      id: newId("rf"),
      expenseId: expense.id,
      amountPaise: refundPaise,
      receivedBy,
      date: input.date,
      reason: `${person.name} dropped out · ${refundPercent}% of their seat refunded`,
      source: "withdrawal",
    };
  }
  return { ...base(ctx), type: "PARTICIPANT_WITHDRAWN", expenseId: expense.id, expenseTitle: expense.title, withdrawal, refund };
}

export type JoinInput = { participantId: ParticipantId; expenseId: ExpenseId; payerId?: ParticipantId };

/**
 * Someone joins a booking. A fixed-price booking is re-split across one more
 * person. A per-head booking needs one more seat: the vendor charges another
 * seat at the going rate, paid by `payerId` (default: the main payer).
 */
export function joinBooking(state: TripState, input: JoinInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const expense = state.expenses.find((e) => e.id === input.expenseId);
  if (!expense) throw new CommandError("That booking no longer exists");
  if (expense.status === "cancelled") throw new CommandError(`"${expense.title}" is cancelled`);
  const person = state.participants.find((p) => p.id === input.participantId);
  if (!person) throw new CommandError("That member is not on this trip");
  if (person.leftOn) throw new CommandError(`${person.name} has left the trip`);
  if (expense.participants.some((p) => p.participantId === input.participantId)) throw new CommandError(`${person.name} is already on "${expense.title}"`);
  if (expense.withdrawals?.some((w) => w.participantId === input.participantId)) throw new CommandError(`${person.name} already withdrew from "${expense.title}"`);
  if (expense.splitMode === "exact") throw new CommandError(`"${expense.title}" uses exact amounts — edit it to add someone`);

  const { status: _s, cancellation: _c, withdrawals: _w, ...rest } = expense;
  const before = rest as ExpenseData;
  let after: ExpenseData = { ...before, participants: [...expense.participants, { participantId: input.participantId, weight: 1 }] };
  if (pricingOf(expense) === "per-head") {
    // One more seat at the going rate: what the current seats cost per unit of weight.
    const seatsGross = expense.amountPaise - sumPaise((expense.withdrawals ?? []).map((w) => w.retainedPaise + w.refundPaise));
    const totalWeight = expense.participants.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
    const seat = totalWeight > 0 ? Math.round(seatsGross / totalWeight) : 0;
    const payerId = input.payerId ?? refundRecipient(expense);
    if (!payerId || !state.participants.some((p) => p.id === payerId)) throw new CommandError("Who pays for the extra seat?", "payer");
    const payers = expense.payers.some((p) => p.participantId === payerId)
      ? expense.payers.map((p) => (p.participantId === payerId ? { ...p, amountPaise: p.amountPaise + seat } : p))
      : [...expense.payers, { participantId: payerId, amountPaise: seat }];
    after = { ...after, amountPaise: expense.amountPaise + seat, payers };
  }
  return { ...base(ctx), type: "EXPENSE_UPDATED", expenseId: expense.id, before, after };
}

export type LeaveInput = { participantId: ParticipantId; date: string; rule?: FixedLeaveRule };

export type LeavePlan = {
  events: LedgerEvent[];
  /** Bookings dated before the leave date: already used, share kept. */
  consumed: ExpenseId[];
  withdrawn: ExpenseId[];
  cancelled: ExpenseId[];
  itineraryUpdated: ItineraryItemId[];
};

/**
 * A member leaves the trip on `date`. Every booking from that date on is
 * resolved under its own pricing and policy; bookings already consumed keep
 * their share. They stay on the books (paid, owed) until settled — leaving
 * the trip never erases money that already moved.
 */
export function leaveTrip(state: TripState, input: LeaveInput, ctx: Ctx): LeavePlan {
  assertOpen(state);
  if (!isValidIso(input.date)) throw new CommandError("Use YYYY-MM-DD", "date");
  const person = state.participants.find((p) => p.id === input.participantId);
  if (!person) throw new CommandError("That member is not on this trip");
  if (person.leftOn) throw new CommandError(`${person.name} already left on ${person.leftOn}`);
  const stillHere = state.participants.filter((p) => !p.leftOn && p.id !== person.id);
  if (stillHere.length === 0) throw new CommandError("A trip needs at least one member");

  const plan: LeavePlan = { events: [], consumed: [], withdrawn: [], cancelled: [], itineraryUpdated: [] };
  let working: TripState = state;
  // Distinct timestamps keep the audit trail ordered.
  let tick = 0;
  const at = (): Ctx => ({ ...ctx, now: (ctx.now ?? Date.now()) + tick++ });
  const push = (event: LedgerEvent) => {
    plan.events.push(event);
    working = applyEvent(working, event) ?? working;
  };

  for (const expense of state.expenses) {
    if (expense.status !== "active" || !expense.participants.some((p) => p.participantId === person.id)) continue;
    if (bookingDate(state, expense) < input.date) {
      plan.consumed.push(expense.id);
      continue;
    }
    const current = working.expenses.find((e) => e.id === expense.id)!;
    const others = current.participants.filter((p) => p.participantId !== person.id && p.weight > 0);
    if (others.length === 0) {
      push(cancelExpense(working, expense.id, { date: input.date, reason: `${person.name} left the trip` }, at()));
      plan.cancelled.push(expense.id);
    } else {
      push(withdrawFromBooking(working, { participantId: person.id, expenseId: expense.id, date: input.date, rule: input.rule }, at()));
      plan.withdrawn.push(expense.id);
    }
  }

  // Unpaid plan items from the leave date on: drop them from the estimate too.
  for (const item of working.itinerary) {
    if (item.status === "cancelled" || item.expenseIds.length || item.date < input.date || !item.participantIds.includes(person.id)) continue;
    if (item.participantIds.length === 1) {
      push({ ...base(at()), type: "ITINERARY_ITEM_REMOVED", itemId: item.id, item });
    } else {
      const after = withoutPlanParticipant(item, person.id, planScalesWithHeadcount(item));
      push({ ...base(at()), type: "ITINERARY_ITEM_UPDATED", itemId: item.id, before: item, after });
    }
    plan.itineraryUpdated.push(item.id);
  }

  push({ ...base(at()), type: "PARTICIPANT_LEFT", participantId: person.id, name: person.name, date: input.date });
  return plan;
}

export type RepriceInput = { expenseId?: ExpenseId; itemId?: ItineraryItemId; newAmountPaise: Paise; payerId?: ParticipantId };

/**
 * The vendor's price changes. For a paid booking the difference is settled
 * with the vendor by one payer (default: the main payer), and every share is
 * re-derived from participation. For an unpaid plan item only the estimate
 * moves.
 */
export function repriceBooking(state: TripState, input: RepriceInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  if (!isPaise(input.newAmountPaise) || input.newAmountPaise <= 0) throw new CommandError("Enter a new price above ₹0", "amount");
  if (input.expenseId) {
    const expense = state.expenses.find((e) => e.id === input.expenseId);
    if (!expense) throw new CommandError("That booking no longer exists");
    if (expense.status === "cancelled") throw new CommandError(`"${expense.title}" is cancelled`);
    if (expense.splitMode === "exact") throw new CommandError(`"${expense.title}" uses exact amounts — edit each person's amount instead`);
    const delta = input.newAmountPaise - expense.amountPaise;
    if (delta === 0) throw new CommandError("That is the current price");
    const refunded = sumPaise(state.refunds.filter((r) => r.expenseId === expense.id).map((r) => r.amountPaise));
    const carved = sumPaise((expense.withdrawals ?? []).map((w) => w.retainedPaise + w.refundPaise));
    if (input.newAmountPaise < Math.max(refunded, carved)) throw new CommandError("The new price is below what has already been refunded or kept by people who dropped out", "amount");
    const payerId = input.payerId ?? refundRecipient(expense);
    if (!payerId || !state.participants.some((p) => p.id === payerId)) throw new CommandError("Who settles the difference with the vendor?", "payer");
    const current = expense.payers.find((p) => p.participantId === payerId)?.amountPaise ?? 0;
    if (current + delta < 0) throw new CommandError("That payer paid less than the price drop — pick the payer who gets the money back", "payer");
    const payers = (expense.payers.some((p) => p.participantId === payerId)
      ? expense.payers.map((p) => (p.participantId === payerId ? { ...p, amountPaise: p.amountPaise + delta } : p))
      : [...expense.payers, { participantId: payerId, amountPaise: delta }]
    ).filter((p) => p.amountPaise > 0);
    const { status: _s, cancellation: _c, withdrawals: _w, ...rest } = expense;
    const before = rest as ExpenseData;
    return { ...base(ctx), type: "EXPENSE_UPDATED", expenseId: expense.id, before, after: { ...before, amountPaise: input.newAmountPaise, payers } };
  }
  const item = input.itemId ? state.itinerary.find((i) => i.id === input.itemId) : undefined;
  if (!item) throw new CommandError("Pick a booking or plan item");
  if (item.status === "cancelled") throw new CommandError(`"${item.title}" is cancelled`);
  if (item.expenseIds.length) throw new CommandError(`"${item.title}" is already paid — change the booking's price instead`);
  if (input.newAmountPaise === item.estimatedPaise) throw new CommandError("That is the current estimate");
  return { ...base(ctx), type: "ITINERARY_ITEM_UPDATED", itemId: item.id, before: item, after: { ...item, estimatedPaise: input.newAmountPaise } };
}

// ---------------------------------------------------------------- refunds

export type RefundInput = { expenseId: ExpenseId; amountPaise: Paise; receivedBy: ParticipantId; date: string; reason?: string };

export function refundableRemaining(state: TripState, expenseId: ExpenseId): Paise {
  const expense = state.expenses.find((e) => e.id === expenseId);
  if (!expense) return 0;
  const already = sumPaise(state.refunds.filter((r) => r.expenseId === expenseId).map((r) => r.amountPaise));
  return Math.max(0, expense.amountPaise - already);
}

export function validateRefund(state: TripState, input: RefundInput) {
  const errors: Partial<Record<"amount" | "receivedBy" | "date", string>> = {};
  const expense = state.expenses.find((e) => e.id === input.expenseId);
  if (!expense) return { amount: "That expense no longer exists" };
  const remaining = refundableRemaining(state, input.expenseId);
  if (!isPaise(input.amountPaise) || input.amountPaise <= 0) errors.amount = "Enter a refund amount";
  else if (input.amountPaise > remaining) errors.amount = `Only ${remaining} paise remain refundable on this expense`;
  if (!state.participants.some((p) => p.id === input.receivedBy)) errors.receivedBy = "Who received the money?";
  if (!isValidIso(input.date)) errors.date = "Use YYYY-MM-DD";
  return errors;
}

export function recordRefund(state: TripState, input: RefundInput, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const errors = validateRefund(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const refund: RefundData = {
    id: newId("rf"),
    expenseId: input.expenseId,
    amountPaise: input.amountPaise,
    receivedBy: input.receivedBy,
    date: input.date,
    reason: input.reason?.trim() || undefined,
    source: "manual",
  };
  return { ...base(ctx), type: "REFUND_RECORDED", refund };
}

export function deleteRefund(state: TripState, refundId: string, ctx: Ctx): LedgerEvent {
  assertOpen(state);
  const refund = state.refunds.find((r) => r.id === refundId);
  if (!refund) throw new CommandError("That refund no longer exists");
  if (refund.source === "cancellation") throw new CommandError("This refund came from a cancellation and can't be removed on its own");
  return { ...base(ctx), type: "REFUND_DELETED", refundId, refund };
}

// ---------------------------------------------------------------- settlements

export type SettlementInput = { from: ParticipantId; to: ParticipantId; amountPaise: Paise; method: SettlementMethod; reference?: string };

export function validateSettlement(state: TripState, input: SettlementInput) {
  const errors: Partial<Record<"from" | "to" | "amount", string>> = {};
  const ids = new Set(state.participants.map((p) => p.id));
  if (!ids.has(input.from)) errors.from = "Payer is not on this trip";
  if (!ids.has(input.to)) errors.to = "Recipient is not on this trip";
  if (input.from === input.to) errors.to = "Payer and recipient must be different people";
  if (!isPaise(input.amountPaise) || input.amountPaise <= 0) errors.amount = "Enter an amount";
  if (!errors.from && !errors.to && !errors.amount) {
    // Guard against over-paying: the payer must currently owe at least this much once pending payments are counted.
    const ledger = computeLedger(state);
    const owes = -ledger.balances[input.from].provisionalNetPaise;
    if (owes <= 0) errors.amount = `${state.participants.find((p) => p.id === input.from)?.name} doesn't owe anything right now`;
    else if (input.amountPaise > owes) errors.amount = `That's more than the ${owes} paise still owed`;
  }
  return errors;
}

export function initiateSettlement(state: TripState, input: SettlementInput, ctx: Ctx): LedgerEvent {
  const errors = validateSettlement(state, input);
  const first = Object.entries(errors)[0];
  if (first) throw new CommandError(first[1], first[0]);
  const settlement: SettlementData = {
    id: newId("st"),
    from: input.from,
    to: input.to,
    amountPaise: input.amountPaise,
    method: input.method,
    reference: input.reference?.trim() || undefined,
    initiatedTs: ctx.now ?? Date.now(),
    status: "initiated",
  };
  return { ...base(ctx), type: "SETTLEMENT_INITIATED", settlement };
}

export function confirmSettlement(state: TripState, settlementId: SettlementId, ctx: Ctx): LedgerEvent {
  const s = state.settlements.find((x) => x.id === settlementId);
  if (!s) throw new CommandError("That payment no longer exists");
  if (s.status !== "initiated") throw new CommandError(`This payment is already ${s.status}`);
  return { ...base(ctx), type: "SETTLEMENT_CONFIRMED", settlementId, confirmedTs: ctx.now ?? Date.now() };
}

export function cancelSettlement(state: TripState, settlementId: SettlementId, ctx: Ctx, reason?: string): LedgerEvent {
  const s = state.settlements.find((x) => x.id === settlementId);
  if (!s) throw new CommandError("That payment no longer exists");
  if (s.status === "cancelled") throw new CommandError("This payment is already cancelled");
  if (s.status === "confirmed") throw new CommandError("Confirmed payments can't be cancelled. Record a payment in the other direction instead.");
  return { ...base(ctx), type: "SETTLEMENT_CANCELLED", settlementId, reason };
}

// ---------------------------------------------------------------- contributions (trip funding)

export function recordContribution(
  state: TripState,
  input: { participantId: ParticipantId; amountPaise: Paise; method: SettlementMethod; reference?: string },
  ctx: Ctx,
): LedgerEvent {
  assertOpen(state);
  if (!state.participants.some((p) => p.id === input.participantId)) throw new CommandError("That member is not on the trip");
  if (!isPaise(input.amountPaise) || input.amountPaise <= 0) throw new CommandError("Enter an amount", "amount");
  const contribution: ContributionData = {
    id: newId("ct"),
    participantId: input.participantId,
    amountPaise: input.amountPaise,
    method: input.method,
    reference: input.reference?.trim() || undefined,
    ts: ctx.now ?? Date.now(),
  };
  return { ...base(ctx), type: "CONTRIBUTION_RECORDED", contribution };
}

export function removeContribution(state: TripState, contributionId: string, ctx: Ctx): LedgerEvent {
  const contribution = state.contributions.find((c) => c.id === contributionId);
  if (!contribution) throw new CommandError("That contribution no longer exists");
  return { ...base(ctx), type: "CONTRIBUTION_REMOVED", contributionId, contribution };
}

// ---------------------------------------------------------------- UPI helpers

/** Build a UPI intent URL. Never executes a transaction; the phone's UPI app does. */
export function upiIntentUrl(opts: { vpa: string; name: string; amountPaise: Paise; note?: string }): string {
  const amount = (opts.amountPaise / 100).toFixed(2);
  // Written the way bank QR codes are: a literal "@" in the UPI ID (some apps reject "%40") and
  // spaces as "%20" (URLSearchParams' "+" shows up literally in some apps' payee name).
  const enc = (v: string) => encodeURIComponent(v);
  const parts = [`pa=${opts.vpa.trim()}`, `pn=${enc(opts.name)}`, `am=${amount}`, "cu=INR"];
  if (opts.note) parts.push(`tn=${enc(opts.note.slice(0, 50))}`);
  return `upi://pay?${parts.join("&")}`;
}

/** Parses a scanned/pasted UPI QR payload into its parts. */
export function parseUpiIntent(raw: string): { vpa: string; name?: string; amountPaise?: Paise; note?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (isValidUpiId(text)) return { vpa: text };
  const match = /^upi:\/\/pay\?(.*)$/i.exec(text);
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const vpa = params.get("pa");
  if (!vpa || !isValidUpiId(vpa)) return null;
  const am = params.get("am");
  const amount = am ? Number(am) : NaN;
  return {
    vpa,
    name: params.get("pn") ?? undefined,
    amountPaise: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : undefined,
    note: params.get("tn") ?? undefined,
  };
}

/** Splits an amount evenly across payers for the "several people paid" form. */
export function evenPayers(amountPaise: Paise, ids: ParticipantId[]) {
  const parts = allocate(
    amountPaise,
    ids.map(() => 1),
  );
  return ids.map((participantId, i) => ({ participantId, amountPaise: parts[i] }));
}

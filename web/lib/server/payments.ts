import "server-only";

import { newId } from "@/lib/id";
import { addExpense, CommandError } from "@/lib/ledger/commands";
import { pricingOf } from "@/lib/ledger/policy";
import { poolFunding, poolSummary } from "@/lib/ledger/pool";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { ContributionData, LedgerEvent, TripState } from "@/lib/ledger/types";
import { DemoGateway, gateway, GatewayUnavailable, type GatewayPayment } from "./razorpay";
import { repo, type Contribution, type MemberRow, type PaymentStatus } from "./repo";
import { HttpError, loadTripForUser, syncTripRow, validateAppend } from "./trips";

/**
 * Trip Pool payments through Razorpay TEST MODE.
 *
 *   create order → Checkout → verify (signature + trusted fetch) / webhook
 *     → contribution VERIFIED → ONE ledger CONTRIBUTION_RECORDED event
 *     → pool, balances and settlement re-derive from the ledger as usual.
 *
 * Idempotency, end to end:
 *  - contribution status moves only by compare-and-set (PENDING → VERIFIED …);
 *  - a provider payment id can belong to one contribution only;
 *  - the ledger event for a payment has a deterministic id (ct_pay_<contribution>),
 *    and is written only if absent — so a replayed verify/webhook finds it and
 *    does nothing. One payment = one contribution = one financial recognition.
 *
 * The pool is a SIMULATED escrow layer: GroupTrip records who paid what; it
 * is not a regulated escrow and holds no funds itself.
 */

export const MIN_CONTRIBUTION_PAISE = 1_00; // ₹1
export const MAX_CONTRIBUTION_PAISE = 5_00_000_00; // ₹5,00,000 per payment

const ledgerContributionId = (contributionId: string) => `ct_pay_${contributionId}`;
const ledgerRefundId = (refundId: string) => `ct_rf_${refundId}`;

function gw() {
  try {
    return gateway();
  } catch (e) {
    if (e instanceof GatewayUnavailable) throw new HttpError(503, e.message, { missing: e.missing });
    throw e;
  }
}

function stateOf(events: LedgerEvent[]): TripState {
  const s = reduceEvents(events);
  if (!s) throw new HttpError(500, "Trip ledger is unreadable");
  return s;
}

const hasLedgerContribution = (events: LedgerEvent[], contributionDataId: string) =>
  events.some((e) => e.type === "CONTRIBUTION_RECORDED" && e.contribution.id === contributionDataId);

/**
 * Appends server-built ledger events, rebuilding on the latest log if another
 * writer got in first. `build` returns null when there is nothing to write
 * (e.g. the event is already there) — that is what makes it idempotent.
 */
async function appendLedger(tripId: string, member: MemberRow, build: (events: LedgerEvent[]) => LedgerEvent[] | null) {
  const r = await repo();
  for (let attempt = 0; attempt < 5; attempt++) {
    const events = await r.getEvents(tripId);
    const built = build(events);
    if (!built || built.length === 0) return false;
    const { events: stamped, state } = validateAppend(events, built, member);
    const res = await r.appendEvents(tripId, events.length, stamped);
    if (res.ok) {
      await syncTripRow(tripId, state);
      return true;
    }
  }
  throw new HttpError(409, "The trip is busy — try again");
}

async function memberRowFor(c: Contribution): Promise<MemberRow> {
  return (await (await repo()).getMember(c.tripId, c.userId)) ?? { tripId: c.tripId, userId: c.userId, participantId: c.participantId, role: "member", joinedAt: c.createdAt };
}

const ledgerExpenseId = (contributionId: string) => `x_pay_${contributionId}`;

/**
 * A verified vendor payment becomes ONE expense in the ledger: paid by the
 * member whose card was charged, shared by the itinerary item's members,
 * linked to the item (which is then "booked"). Deterministic id → written once.
 */
async function ensureVendorExpenseInLedger(c: Contribution) {
  if (!c.paymentId || c.status !== "VERIFIED") return false;
  const expenseId = ledgerExpenseId(c.id);
  return appendLedger(c.tripId, await memberRowFor(c), (events) => {
    if (events.some((e) => e.type === "EXPENSE_ADDED" && e.expense.id === expenseId)) return null;
    const state = stateOf(events);
    const item = state.itinerary.find((i) => i.id === c.itemId);
    const me = state.participants.find((p) => p.id === c.participantId);
    const method = me?.paymentMethods?.find((m) => m.label.toLowerCase() === (c.methodLabel ?? "").toLowerCase());
    const participants = (item?.participantIds.length ? item.participantIds : [c.participantId]).map((participantId, i) => ({ participantId, weight: item?.weights?.[i] ?? 1 }));
    let event: LedgerEvent;
    try {
      event = addExpense(
        state,
        {
          title: item?.title ?? "Vendor payment",
          vendor: item?.vendor,
          amountPaise: c.amountPaise,
          date: new Date(c.createdAt).toISOString().slice(0, 10),
          category: item?.category ?? "Other",
          payers: [{ participantId: c.participantId, amountPaise: c.amountPaise }],
          participants,
          splitMode: item?.weights ? "weighted" : "equal",
          pricing: item ? pricingOf({ category: item.category }) : undefined,
          cancellationPolicy: item?.cancellationPolicy,
          itineraryItemId: item?.id,
          paymentMethodId: method?.id,
          capture: { kind: "deeplink", reference: `${c.paymentId}${c.methodLabel ? ` · ${c.methodLabel}` : ""}` },
          notes: "Paid through Razorpay checkout; recorded after server-side verification.",
        },
        { actor: c.participantId },
      );
    } catch (e) {
      throw new HttpError(409, e instanceof CommandError ? `Payment verified but couldn't be booked: ${e.message}` : "Payment verified but couldn't be booked");
    }
    if (event.type !== "EXPENSE_ADDED") return null;
    return [{ ...event, id: `ev_pay_${c.id}`, expense: { ...event.expense, id: expenseId } }];
  });
}

/** Writes the ledger event for a verified payment, exactly once. */
async function ensureContributionInLedger(c: Contribution) {
  if (c.purpose === "vendor") return ensureVendorExpenseInLedger(c);
  if (!c.paymentId || (c.status !== "VERIFIED" && c.status !== "REFUND_PENDING" && c.status !== "REFUNDED")) return false;
  const dataId = ledgerContributionId(c.id);
  return appendLedger(c.tripId, await memberRowFor(c), (events) => {
    if (hasLedgerContribution(events, dataId)) return null;
    const contribution: ContributionData = {
      id: dataId,
      participantId: c.participantId,
      amountPaise: c.amountPaise,
      direction: "in",
      method: "razorpay",
      reference: c.paymentId,
      ts: Date.now(),
    };
    return [{ id: `ev_pay_${c.id}`, ts: Date.now(), actor: c.participantId, type: "CONTRIBUTION_RECORDED", contribution }];
  });
}

/** Marks a captured payment as the contribution's payment and recognises it in the ledger (idempotent). */
async function recognise(c: Contribution, payment: GatewayPayment) {
  const r = await repo();
  if (payment.order_id !== c.orderId) throw new HttpError(400, "Payment does not belong to this contribution's order");
  if (payment.amount !== c.amountPaise || payment.currency !== c.currency) throw new HttpError(400, "Payment amount does not match the contribution");
  const owner = await r.findContributionByPayment(payment.id);
  if (owner && owner.id !== c.id) throw new HttpError(409, "This payment is already recorded for another contribution");
  let current = await r.transitionContribution(c.id, ["PENDING", "FAILED"], { status: "VERIFIED", paymentId: payment.id, failureReason: undefined });
  if (!current) current = await r.getContribution(c.id);
  if (!current) throw new HttpError(404, "Contribution not found");
  if (current.paymentId !== payment.id) throw new HttpError(409, "This contribution was already paid by a different payment");
  const wrote = await ensureContributionInLedger(current);
  return { contribution: current, newlyRecorded: wrote };
}

// ---------------------------------------------------------------- create order

export async function createPaymentOrder(
  userId: string,
  input: { tripId?: unknown; memberId?: unknown; amountPaise?: unknown; currency?: unknown; purpose?: unknown; itemId?: unknown; methodLabel?: unknown },
) {
  const tripId = typeof input.tripId === "string" ? input.tripId : "";
  const purpose: "pool" | "vendor" = input.purpose === "vendor" ? "vendor" : "pool";
  const amount = input.amountPaise;
  if (!tripId) throw new HttpError(400, "tripId is required");
  if (typeof amount !== "number" || !Number.isInteger(amount)) throw new HttpError(400, "amountPaise must be a whole number of paise");
  if (amount < MIN_CONTRIBUTION_PAISE) throw new HttpError(400, "Contribute at least ₹1");
  if (amount > MAX_CONTRIBUTION_PAISE) throw new HttpError(400, "That's above the ₹5,00,000 per-payment limit");
  const currency = input.currency ?? "INR";
  if (currency !== "INR") throw new HttpError(400, "Only INR is supported");

  const { member, events } = await loadTripForUser(tripId, userId);
  if (input.memberId !== undefined && input.memberId !== member.participantId) throw new HttpError(403, "You can only contribute for yourself");
  const state = stateOf(events);
  if (state.trip.status === "closed") throw new HttpError(409, "This trip is closed — the pool no longer takes contributions");
  const me = state.participants.find((p) => p.id === member.participantId);
  if (!me || me.leftOn) throw new HttpError(409, "You have left this trip");
  let itemId: string | undefined;
  if (purpose === "vendor") {
    const item = state.itinerary.find((i) => i.id === input.itemId);
    if (!item) throw new HttpError(400, "Pick the itinerary item you're paying for");
    if (item.status === "cancelled") throw new HttpError(409, `"${item.title}" is cancelled`);
    itemId = item.id;
  }
  const methodLabel = typeof input.methodLabel === "string" && input.methodLabel.trim() ? input.methodLabel.trim().slice(0, 60) : undefined;

  const g = gw();
  const r = await repo();
  const now = Date.now();
  const contribution: Contribution = {
    id: newId("pc"),
    tripId,
    participantId: member.participantId,
    userId,
    amountPaise: amount,
    currency: "INR",
    provider: "razorpay",
    purpose,
    itemId,
    methodLabel,
    status: "PENDING",
    refundedPaise: 0,
    createdAt: now,
    updatedAt: now,
  };
  await r.createContribution(contribution);
  let orderId: string;
  try {
    const order = await g.createOrder({
      amountPaise: amount,
      currency: "INR",
      receipt: contribution.id,
      notes: { tripId, contributionId: contribution.id, participantId: member.participantId, purpose: purpose === "vendor" ? `GroupTrip vendor payment · ${itemId}` : "GroupTrip pool contribution" },
    });
    if (order.amount !== amount || order.currency !== "INR") throw new Error("Order amount mismatch");
    orderId = order.id;
  } catch (e) {
    await r.transitionContribution(contribution.id, ["PENDING"], { status: "FAILED", failureReason: "Could not create the payment order" });
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "Razorpay could not create the order — check the test keys and try again");
  }
  await r.transitionContribution(contribution.id, ["PENDING"], { orderId });
  return { contributionId: contribution.id, orderId, amountPaise: amount, currency: "INR" as const, keyId: g.keyId, mode: g.mode, name: me.name, purpose };
}

// ---------------------------------------------------------------- verify (Checkout handler)

export async function verifyPayment(userId: string, input: { contributionId?: unknown; razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown }) {
  const { contributionId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = input;
  if (typeof contributionId !== "string" || typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "contributionId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required");
  }
  const r = await repo();
  const c = await r.getContribution(contributionId);
  if (!c) throw new HttpError(404, "Contribution not found");
  if (c.userId !== userId) throw new HttpError(403, "This isn't your contribution");
  if (!c.orderId || c.orderId !== orderId) throw new HttpError(400, "Order does not match this contribution");

  const g = gw();
  // 1) The signature proves Razorpay issued this payment for this order. No state changes before this passes.
  if (!g.verifyPaymentSignature(orderId, paymentId, signature)) throw new HttpError(400, "Payment signature is invalid — nothing was recorded");

  // Idempotent replay of a verification we've already done.
  if (c.paymentId === paymentId && (c.status === "VERIFIED" || c.status === "REFUND_PENDING" || c.status === "REFUNDED")) {
    await ensureContributionInLedger(c);
    return { status: c.status, contribution: c, alreadyVerified: true, pool: await poolView(c.tripId, userId) };
  }

  // 2) Never trust the browser: fetch the payment from Razorpay and check it belongs to this order and amount.
  let payment = await g.fetchPayment(paymentId);
  if (payment.order_id !== orderId) throw new HttpError(400, "Payment does not belong to this order");
  if (payment.amount !== c.amountPaise || payment.currency !== c.currency) throw new HttpError(400, "Payment amount does not match the contribution");
  if (payment.status === "authorized") payment = await g.capturePayment(paymentId, c.amountPaise, c.currency);
  if (payment.status === "failed") {
    const failed = await markFailed(c, payment.error_description ?? "Payment failed");
    return { status: failed?.status ?? "FAILED", contribution: failed ?? c, alreadyVerified: false, pool: await poolView(c.tripId, userId) };
  }
  if (payment.status !== "captured") {
    return { status: "PENDING" as PaymentStatus, contribution: c, alreadyVerified: false, pool: await poolView(c.tripId, userId) };
  }
  const { contribution } = await recognise(c, payment);
  return { status: contribution.status, contribution, alreadyVerified: false, pool: await poolView(c.tripId, userId) };
}

async function markFailed(c: Contribution, reason: string) {
  return (await repo()).transitionContribution(c.id, ["PENDING"], { status: "FAILED", failureReason: reason.slice(0, 200) });
}

// ---------------------------------------------------------------- webhook

type WebhookBody = {
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: GatewayPayment };
    refund?: { entity?: { id: string; payment_id: string; amount: number; status: string } };
  };
};

export async function handleWebhook(rawBody: string, signature: string | null, eventIdHeader: string | null) {
  const g = gw();
  if (!signature || !g.verifyWebhookSignature(rawBody, signature)) throw new HttpError(400, "Invalid webhook signature");
  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    throw new HttpError(400, "Malformed webhook body");
  }
  const event = body.event ?? "unknown";
  const payment = body.payload?.payment?.entity;
  const refund = body.payload?.refund?.entity;
  const eventId = eventIdHeader || `${event}:${refund?.id ?? payment?.id ?? "?"}:${body.created_at ?? ""}`;
  const r = await repo();
  let outcome = "ignored";

  // Processing is idempotent on its own (compare-and-set + ledger-id checks), so
  // a retried or duplicated delivery can never double count. The event id is
  // recorded afterwards for the audit trail and to report duplicates.
  if ((event === "payment.captured" || event === "order.paid") && payment?.order_id) {
    const c = await r.findContributionByOrder(payment.order_id);
    if (c) {
      const res = await recognise(c, payment);
      outcome = res.newlyRecorded ? "recorded" : "already-recorded";
    }
  } else if (event === "payment.failed" && payment?.order_id) {
    const c = await r.findContributionByOrder(payment.order_id);
    if (c) outcome = (await markFailed(c, payment.error_description ?? "Payment failed")) ? "marked-failed" : "unchanged";
  } else if (event === "refund.processed" && refund?.payment_id) {
    const c = await r.findContributionByPayment(refund.payment_id);
    if (c) outcome = (await finaliseRefund(c, refund.id, refund.amount)) ? "refund-recorded" : "refund-already-recorded";
  } else if (event === "refund.failed" && refund?.payment_id) {
    const c = await r.findContributionByPayment(refund.payment_id);
    if (c && c.refundId === refund.id) outcome = (await r.transitionContribution(c.id, ["REFUND_PENDING"], { status: "VERIFIED", refundId: undefined })) ? "refund-reverted" : "unchanged";
  }
  const first = await r.claimWebhookEvent(eventId, event);
  return { event, outcome, duplicate: !first };
}

// ---------------------------------------------------------------- refunds

export async function refundContribution(userId: string, paymentId: string, input: { amountPaise?: unknown }) {
  const r = await repo();
  const c = await r.findContributionByPayment(paymentId);
  if (!c) throw new HttpError(404, "No contribution found for that payment");
  const { member, events } = await loadTripForUser(c.tripId, userId);
  if (member.role !== "owner" && c.userId !== userId) throw new HttpError(403, "Only the contributor or the trip organiser can refund this");
  if (c.status === "REFUNDED" || c.status === "REFUND_PENDING") throw new HttpError(409, "This contribution has already been refunded");
  if (c.status !== "VERIFIED") throw new HttpError(409, "Only a verified payment can be refunded");
  if (c.purpose === "vendor") throw new HttpError(409, "Vendor payments are refunded through the booking's cancellation, not here");

  const remaining = c.amountPaise - c.refundedPaise;
  const amount = input.amountPaise === undefined ? remaining : input.amountPaise;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > remaining) throw new HttpError(400, "Refund amount must be between ₹0.01 and the amount paid");
  const unspent = poolSummary(stateOf(events)).members[c.participantId]?.availablePaise ?? 0;
  if (amount > unspent) throw new HttpError(409, `Only ₹${(unspent / 100).toLocaleString("en-IN")} of this member's pool money is unspent — the rest already paid for bookings`);

  const g = gw();
  const locked = await r.transitionContribution(c.id, ["VERIFIED"], { status: "REFUND_PENDING" });
  if (!locked) throw new HttpError(409, "A refund is already in progress");
  let refund;
  try {
    refund = await g.refundPayment(paymentId, { amountPaise: amount, notes: { tripId: c.tripId, contributionId: c.id } });
  } catch {
    await r.transitionContribution(c.id, ["REFUND_PENDING"], { status: "VERIFIED" });
    throw new HttpError(502, "Razorpay could not process the refund — nothing changed");
  }
  await r.transitionContribution(c.id, ["REFUND_PENDING"], { refundId: refund.id });
  if (refund.status === "processed") await finaliseRefund({ ...locked, refundId: refund.id }, refund.id, refund.amount);
  return { refundId: refund.id, refundStatus: refund.status, pool: await poolView(c.tripId, userId) };
}

/** Records a completed refund once: contribution REFUNDED + one ledger withdrawal. */
async function finaliseRefund(c: Contribution, refundId: string, amountPaise: number) {
  const r = await repo();
  const done = await r.transitionContribution(c.id, ["REFUND_PENDING", "VERIFIED"], { status: "REFUNDED", refundId, refundedPaise: Math.min(c.amountPaise, c.refundedPaise + amountPaise) });
  const current = done ?? (await r.getContribution(c.id));
  if (!current || current.status !== "REFUNDED" || current.refundId !== refundId) return false;
  const dataId = ledgerRefundId(refundId);
  const wrote = await appendLedger(current.tripId, await memberRowFor(current), (events) => {
    if (hasLedgerContribution(events, dataId)) return null;
    const contribution: ContributionData = {
      id: dataId,
      participantId: current.participantId,
      amountPaise: amountPaise,
      direction: "out",
      method: "razorpay",
      reference: `Refund ${refundId} of ${current.paymentId}`,
      ts: Date.now(),
    };
    return [{ id: `ev_rf_${refundId}`, ts: Date.now(), actor: current.participantId, type: "CONTRIBUTION_RECORDED", contribution }];
  });
  return wrote;
}

// ---------------------------------------------------------------- read models

const STATUS_LABEL: Record<PaymentStatus, string> = { PENDING: "Pending", VERIFIED: "Paid", FAILED: "Failed", REFUND_PENDING: "Refund pending", REFUNDED: "Refunded" };

export async function poolView(tripId: string, userId: string) {
  const { trip, events } = await loadTripForUser(tripId, userId);
  const state = stateOf(events);
  const funding = poolFunding(state);
  const name = (id: string) => state.participants.find((p) => p.id === id)?.name ?? "Former member";
  const contributions = (await (await repo()).listContributions(tripId)).filter((c) => (c.purpose ?? "pool") === "pool").map((c) => ({
    contributionId: c.id,
    memberId: c.participantId,
    memberName: name(c.participantId),
    amountPaise: c.amountPaise,
    refundedPaise: c.refundedPaise,
    currency: c.currency,
    provider: c.provider,
    status: c.status,
    statusLabel: STATUS_LABEL[c.status],
    orderId: c.orderId ?? null,
    paymentId: c.paymentId ?? null,
    failureReason: c.failureReason ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
  return {
    tripId,
    poolId: `pool_${trip.id}`,
    currency: "INR" as const,
    kind: "simulated-escrow" as const,
    targetAmountPaise: funding.targetPaise,
    collectedAmountPaise: funding.collectedPaise,
    reservedAmountPaise: funding.reservedPaise,
    refundedAmountPaise: funding.refundedPaise,
    availableAmountPaise: funding.availablePaise,
    remainingAmountPaise: funding.remainingPaise,
    fundingPercentage: funding.fundingPercent,
    status: funding.status,
    contributions,
  };
}

export async function transactions(tripId: string, userId: string) {
  const { events } = await loadTripForUser(tripId, userId);
  const state = stateOf(events);
  const name = (id: string) => state.participants.find((p) => p.id === id)?.name ?? "Former member";
  const payments = await (await repo()).listContributions(tripId);
  const recordedByPayment = new Set(payments.map((p) => ledgerContributionId(p.id)));
  const rows: {
    id: string;
    kind: "contribution" | "refund" | "withdrawal" | "vendor_payment";
    memberId: string | null;
    memberName: string | null;
    amountPaise: number;
    status: string;
    provider: "razorpay" | "upi" | "cash" | "pool";
    at: number;
    paymentId: string | null;
    contributionId: string | null;
    tripId: string;
    purpose: string;
  }[] = [];
  for (const p of payments) {
    rows.push({
      id: p.id,
      kind: p.purpose === "vendor" ? "vendor_payment" : "contribution",
      memberId: p.participantId,
      memberName: name(p.participantId),
      amountPaise: p.amountPaise,
      status: STATUS_LABEL[p.status],
      provider: "razorpay",
      at: p.updatedAt,
      paymentId: p.paymentId ?? null,
      contributionId: p.id,
      tripId,
      purpose: p.purpose === "vendor" ? `Vendor payment${p.methodLabel ? ` · ${p.methodLabel}` : ""}` : "Contribution to the trip pool",
    });
  }
  for (const c of state.contributions) {
    if (recordedByPayment.has(c.id)) continue; // already listed above from the payment record
    const isRefund = c.id.startsWith("ct_rf_");
    rows.push({
      id: c.id,
      kind: isRefund ? "refund" : c.direction === "out" ? "withdrawal" : "contribution",
      memberId: c.participantId,
      memberName: name(c.participantId),
      amountPaise: c.amountPaise,
      status: isRefund ? "Refunded" : "Recorded",
      provider: c.method === "razorpay" ? "razorpay" : c.method,
      at: c.ts,
      paymentId: null,
      contributionId: null,
      tripId,
      purpose: isRefund ? (c.reference ?? "Refund") : c.direction === "out" ? "Unspent money taken back from the pool" : "Contribution recorded manually",
    });
  }
  for (const e of state.expenses) {
    if (!e.fundedFromPool) continue;
    rows.push({
      id: e.id,
      kind: "vendor_payment",
      memberId: null,
      memberName: null,
      amountPaise: e.amountPaise,
      status: e.status === "cancelled" ? "Cancelled" : "Paid",
      provider: "pool",
      at: Date.parse(`${e.date}T12:00:00`) || 0,
      paymentId: null,
      contributionId: null,
      tripId,
      purpose: `Paid from the pool: ${e.title}${e.vendor ? ` · ${e.vendor}` : ""}`,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return { tripId, transactions: rows };
}

// ---------------------------------------------------------------- demo checkout (no keys configured)

/** Completes a DEMO checkout for the caller's own pending order and returns the signed Checkout response. */
export async function completeDemoCheckout(userId: string, input: { contributionId?: unknown; outcome?: unknown }) {
  const g = gw();
  if (!(g instanceof DemoGateway)) throw new HttpError(409, "Demo checkout is only available when Razorpay keys are not configured");
  if (typeof input.contributionId !== "string") throw new HttpError(400, "contributionId is required");
  const c = await (await repo()).getContribution(input.contributionId);
  if (!c || c.userId !== userId) throw new HttpError(404, "Contribution not found");
  if (!c.orderId) throw new HttpError(409, "This contribution has no order");
  return g.complete(c.orderId, c.amountPaise, input.outcome === "fail" ? "fail" : "success");
}

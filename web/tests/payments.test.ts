import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { addParticipant, createTrip } from "@/lib/ledger/commands";
import { computeLedger } from "@/lib/ledger/engine";
import { payVendorFromPool, poolFunding, setPoolTarget } from "@/lib/ledger/pool";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { FileRepo } from "@/lib/server/file-repo";
import { createPaymentOrder, handleWebhook, poolView, refundContribution, transactions, verifyPayment } from "@/lib/server/payments";
import { setGatewayForTests, type GatewayPayment, type PaymentGateway } from "@/lib/server/razorpay";
import { setRepoForTests } from "@/lib/server/repo";
import { HttpError } from "@/lib/server/trips";

/**
 * Trip Pool payments end to end against a fake Razorpay (test mode) and an
 * isolated file store. The fake signs exactly like Razorpay: payment
 * signature = HMAC_SHA256(order_id|payment_id, key_secret), webhook
 * signature = HMAC_SHA256(raw_body, webhook_secret).
 */

const KEY_SECRET = "test_key_secret";
const WEBHOOK_SECRET = "test_webhook_secret";
const hmac = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("hex");

class FakeRazorpay implements PaymentGateway {
  readonly keyId = "rzp_test_FAKE";
  readonly mode = "test" as const;
  orders = new Map<string, { id: string; amount: number; currency: string }>();
  payments = new Map<string, GatewayPayment>();
  refunds: { id: string; payment_id: string; amount: number }[] = [];
  refundStatus: "processed" | "pending" = "processed";
  private n = 0;

  async createOrder(input: { amountPaise: number; currency: string }) {
    const o = { id: `order_${++this.n}`, amount: input.amountPaise, currency: input.currency, status: "created" };
    this.orders.set(o.id, o);
    return o;
  }
  async fetchPayment(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new Error("no such payment");
    return { ...p };
  }
  async capturePayment(id: string) {
    const p = this.payments.get(id)!;
    p.status = "captured";
    return { ...p };
  }
  async refundPayment(paymentId: string, input: { amountPaise: number }) {
    const r = { id: `rfnd_${++this.n}`, payment_id: paymentId, amount: input.amountPaise, status: this.refundStatus };
    this.refunds.push(r);
    return r;
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return hmac(`${orderId}|${paymentId}`, KEY_SECRET) === signature;
  }
  verifyWebhookSignature(rawBody: string, signature: string) {
    return hmac(rawBody, WEBHOOK_SECRET) === signature;
  }
  /** Simulates the customer completing Test Checkout; returns what Checkout hands the browser. */
  pay(orderId: string, status: "captured" | "failed" | "authorized" = "captured", amount?: number) {
    const o = this.orders.get(orderId)!;
    const id = `pay_${++this.n}`;
    this.payments.set(id, { id, order_id: orderId, amount: amount ?? o.amount, currency: o.currency, status, error_description: status === "failed" ? "Card declined (test)" : null });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: hmac(`${orderId}|${id}`, KEY_SECRET) };
  }
}

const TRIP = "trip_manali_test";
let dir: string;
let rp: FakeRazorpay;
let repoInstance: FileRepo;
const ids: Record<string, string> = {};
const users = { A: "user_A", B: "user_B", C: "user_C", X: "user_outsider" };

async function seed() {
  const events: LedgerEvent[] = [];
  const ctx = () => ({ actor: "system" as const, now: Date.now() });
  events.push(...createTrip({ name: "Manali Group Trip", destination: "Manali", startDate: "2026-10-10", endDate: "2026-10-14" }, ctx()).events);
  for (const n of ["A", "B", "C"]) {
    const e = addParticipant(reduceEvents(events)!, { name: `Member ${n}` }, ctx());
    events.push(e);
    if (e.type === "PARTICIPANT_ADDED") ids[n] = e.participant.id;
  }
  events.push(setPoolTarget(reduceEvents(events)!, 30_000_00, ctx()));
  // Keep the trip id stable for the test.
  events[0] = { ...events[0], trip: { ...(events[0] as Extract<LedgerEvent, { type: "TRIP_CREATED" }>).trip, id: TRIP } } as LedgerEvent;
  const now = Date.now();
  await repoInstance.createTrip(
    { id: TRIP, ownerId: users.A, name: "Manali Group Trip", destination: "Manali", startDate: "2026-10-10", endDate: "2026-10-14", status: "active", joinCode: "MNL123", createdAt: now, updatedAt: now },
    { tripId: TRIP, userId: users.A, participantId: ids.A, role: "owner", joinedAt: now },
    events,
  );
  await repoInstance.addMember({ tripId: TRIP, userId: users.B, participantId: ids.B, role: "member", joinedAt: now });
  await repoInstance.addMember({ tripId: TRIP, userId: users.C, participantId: ids.C, role: "member", joinedAt: now });
}

const ledger = async () => reduceEvents(await repoInstance.getEvents(TRIP))!;
const ledgerContributions = async () => (await repoInstance.getEvents(TRIP)).filter((e) => e.type === "CONTRIBUTION_RECORDED");

async function contribute(user: keyof typeof users, amountPaise: number) {
  const order = await createPaymentOrder(users[user], { tripId: TRIP, amountPaise });
  const checkout = rp.pay(order.orderId);
  const res = await verifyPayment(users[user], { contributionId: order.contributionId, ...checkout });
  return { order, checkout, res };
}

function webhook(event: string, payload: object, eventId: string, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify({ event, created_at: 1_790_000_000, payload });
  return handleWebhook(body, hmac(body, secret), eventId);
}

async function expectHttp(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(HttpError);
  await p.catch((e: HttpError) => expect(e.status).toBe(status));
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gtl-pay-"));
  repoInstance = new FileRepo(path.join(dir, "db.json"));
  setRepoForTests(repoInstance);
  rp = new FakeRazorpay();
  setGatewayForTests(rp);
  await seed();
});
afterEach(() => {
  setRepoForTests(null);
  setGatewayForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("create order", () => {
  it("creates a PENDING contribution and a Razorpay order — nothing is collected yet", async () => {
    const order = await createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 5_000_00 });
    expect(order).toMatchObject({ amountPaise: 5_000_00, currency: "INR", keyId: "rzp_test_FAKE" });
    expect(order).not.toHaveProperty("keySecret");
    const c = await repoInstance.getContribution(order.contributionId);
    expect(c).toMatchObject({ status: "PENDING", orderId: order.orderId, participantId: ids.A });
    expect((await poolView(TRIP, users.A)).collectedAmountPaise).toBe(0);
    expect(await ledgerContributions()).toHaveLength(0);
  });

  it("rejects non-members, contributing for someone else, and bad amounts", async () => {
    await expectHttp(createPaymentOrder(users.X, { tripId: TRIP, amountPaise: 1_000_00 }), 403);
    await expectHttp(createPaymentOrder(users.A, { tripId: TRIP, memberId: ids.B, amountPaise: 1_000_00 }), 403);
    await expectHttp(createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 12.5 }), 400);
    await expectHttp(createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 0 }), 400);
    await expectHttp(createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 1_000_00, currency: "USD" }), 400);
  });
});

describe("verification", () => {
  it("demo: ₹5,000 contribution → verified → pool ₹5,000 / ₹30,000, remaining ₹25,000, one ledger entry", async () => {
    expect((await poolView(TRIP, users.A)).collectedAmountPaise).toBe(0);
    const { res } = await contribute("A", 5_000_00);
    expect(res.status).toBe("VERIFIED");
    const pool = await poolView(TRIP, users.A);
    expect(pool).toMatchObject({ targetAmountPaise: 30_000_00, collectedAmountPaise: 5_000_00, remainingAmountPaise: 25_000_00, fundingPercentage: 16, status: "open" });
    const entries = await ledgerContributions();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: ids.A, contribution: { participantId: ids.A, amountPaise: 5_000_00, method: "razorpay", direction: "in" } });
  });

  it("duplicate verification never adds money twice", async () => {
    const { order, checkout } = await contribute("A", 5_000_00);
    const again = await verifyPayment(users.A, { contributionId: order.contributionId, ...checkout });
    expect(again.alreadyVerified).toBe(true);
    expect(await ledgerContributions()).toHaveLength(1);
    expect((await poolView(TRIP, users.A)).collectedAmountPaise).toBe(5_000_00);
  });

  it("an invalid signature changes nothing", async () => {
    const order = await createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 5_000_00 });
    const checkout = rp.pay(order.orderId);
    await expectHttp(verifyPayment(users.A, { contributionId: order.contributionId, ...checkout, razorpay_signature: "forged" }), 400);
    expect((await repoInstance.getContribution(order.contributionId))!.status).toBe("PENDING");
    expect(await ledgerContributions()).toHaveLength(0);
  });

  it("never trusts the browser's amount: a payment for a different amount is rejected", async () => {
    const order = await createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 5_000_00 });
    const checkout = rp.pay(order.orderId, "captured", 50_00);
    await expectHttp(verifyPayment(users.A, { contributionId: order.contributionId, ...checkout }), 400);
    expect(await ledgerContributions()).toHaveLength(0);
  });

  it("only the contributor can verify their contribution", async () => {
    const order = await createPaymentOrder(users.A, { tripId: TRIP, amountPaise: 5_000_00 });
    const checkout = rp.pay(order.orderId);
    await expectHttp(verifyPayment(users.B, { contributionId: order.contributionId, ...checkout }), 403);
  });

  it("an authorised-but-uncaptured payment is captured server-side before recording", async () => {
    const order = await createPaymentOrder(users.B, { tripId: TRIP, amountPaise: 2_000_00 });
    const checkout = rp.pay(order.orderId, "authorized");
    expect((await verifyPayment(users.B, { contributionId: order.contributionId, ...checkout })).status).toBe("VERIFIED");
    expect(rp.payments.get(checkout.razorpay_payment_id)!.status).toBe("captured");
  });
});

describe("failed payments", () => {
  it("PENDING → FAILED, pool unchanged, no ledger entry; a retry on the same order records exactly once", async () => {
    const order = await createPaymentOrder(users.C, { tripId: TRIP, amountPaise: 2_500_00 });
    const failed = rp.pay(order.orderId, "failed");
    const res = await verifyPayment(users.C, { contributionId: order.contributionId, ...failed });
    expect(res.status).toBe("FAILED");
    expect((await poolView(TRIP, users.C)).collectedAmountPaise).toBe(0);
    expect(await ledgerContributions()).toHaveLength(0);

    const retry = rp.pay(order.orderId); // Checkout lets the customer retry on the same order
    expect((await verifyPayment(users.C, { contributionId: order.contributionId, ...retry })).status).toBe("VERIFIED");
    expect(await ledgerContributions()).toHaveLength(1);
    expect((await poolView(TRIP, users.C)).collectedAmountPaise).toBe(2_500_00);
  });

  it("payment.failed webhook marks the contribution failed without touching the pool", async () => {
    const order = await createPaymentOrder(users.C, { tripId: TRIP, amountPaise: 2_500_00 });
    const failed = rp.pay(order.orderId, "failed");
    const r = await webhook("payment.failed", { payment: { entity: rp.payments.get(failed.razorpay_payment_id) } }, "evt_f1");
    expect(r.outcome).toBe("marked-failed");
    expect((await repoInstance.getContribution(order.contributionId))!.status).toBe("FAILED");
    expect((await poolView(TRIP, users.C)).collectedAmountPaise).toBe(0);
  });
});

describe("webhooks", () => {
  it("payment.captured records the contribution even if the browser never called verify; duplicates don't double count", async () => {
    const order = await createPaymentOrder(users.B, { tripId: TRIP, amountPaise: 7_500_00 });
    const checkout = rp.pay(order.orderId);
    const payload = { payment: { entity: rp.payments.get(checkout.razorpay_payment_id) } };
    const first = await webhook("payment.captured", payload, "evt_1");
    expect(first).toMatchObject({ outcome: "recorded", duplicate: false });
    const dup = await webhook("payment.captured", payload, "evt_1");
    expect(dup.duplicate).toBe(true);
    const orderPaid = await webhook("order.paid", payload, "evt_2"); // Razorpay sends both events for one payment
    expect(orderPaid.outcome).toBe("already-recorded");
    // The browser's verify arriving late is also a no-op.
    await verifyPayment(users.B, { contributionId: order.contributionId, ...checkout });
    expect(await ledgerContributions()).toHaveLength(1);
    expect((await poolView(TRIP, users.B)).collectedAmountPaise).toBe(7_500_00);
  });

  it("rejects a bad webhook signature with no financial mutation", async () => {
    const order = await createPaymentOrder(users.B, { tripId: TRIP, amountPaise: 7_500_00 });
    const checkout = rp.pay(order.orderId);
    await expectHttp(webhook("payment.captured", { payment: { entity: rp.payments.get(checkout.razorpay_payment_id) } }, "evt_x", "wrong_secret"), 400);
    expect((await repoInstance.getContribution(order.contributionId))!.status).toBe("PENDING");
    expect(await ledgerContributions()).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("refund propagates: contribution REFUNDED, pool refunded, available = collected − reserved − refunded, ledger withdrawal once", async () => {
    await contribute("A", 5_000_00);
    const { res } = await contribute("B", 7_500_00);
    const paymentId = res.contribution.paymentId!;
    const out = await refundContribution(users.B, paymentId, {});
    expect(out.refundStatus).toBe("processed");
    const pool = await poolView(TRIP, users.A);
    expect(pool).toMatchObject({ collectedAmountPaise: 12_500_00, refundedAmountPaise: 7_500_00, availableAmountPaise: 5_000_00 });
    expect(pool.availableAmountPaise).toBe(pool.collectedAmountPaise - pool.reservedAmountPaise - pool.refundedAmountPaise);
    // The refund.processed webhook arriving afterwards is a no-op.
    const r = rp.refunds[0];
    await webhook("refund.processed", { refund: { entity: { ...r, status: "processed" } } }, "evt_r1");
    const entries = await ledgerContributions();
    expect(entries.filter((e) => e.type === "CONTRIBUTION_RECORDED" && e.contribution.direction === "out")).toHaveLength(1);
    await expectHttp(refundContribution(users.B, paymentId, {}), 409); // no double refund
    expect(computeLedger(await ledger()).reconciliationPaise).toBe(0);
  });

  it("a pending refund is finalised by the refund.processed webhook", async () => {
    const { res } = await contribute("C", 2_500_00);
    rp.refundStatus = "pending";
    await refundContribution(users.C, res.contribution.paymentId!, {});
    expect((await repoInstance.getContribution(res.contribution.id))!.status).toBe("REFUND_PENDING");
    await webhook("refund.processed", { refund: { entity: { ...rp.refunds[0], status: "processed" } } }, "evt_r2");
    expect((await poolView(TRIP, users.C)).refundedAmountPaise).toBe(2_500_00);
  });

  it("only the contributor or the organiser may refund, and money already spent can't be refunded", async () => {
    const { res } = await contribute("B", 6_000_00);
    await expectHttp(refundContribution(users.C, res.contribution.paymentId!, {}), 403);
    // Spend ₹6,000 of the pool on a vendor: B's money is committed.
    const state = await ledger();
    const spend = payVendorFromPool(
      state,
      { title: "Homestay advance", amountPaise: 6_000_00, date: "2026-10-10", category: "Stay", participants: Object.values(ids).map((participantId) => ({ participantId, weight: 1 })), splitMode: "equal" },
      { actor: ids.A },
    );
    await repoInstance.appendEvents(TRIP, (await repoInstance.getEvents(TRIP)).length, [spend]);
    await expectHttp(refundContribution(users.A, res.contribution.paymentId!, {}), 409);
  });
});

describe("pool, ledger and settlement integrity", () => {
  it("brief example: A ₹5,000 + B ₹7,500 + C ₹2,500 → ₹15,000 collected, ₹15,000 remaining", async () => {
    await contribute("A", 5_000_00);
    await contribute("B", 7_500_00);
    await contribute("C", 2_500_00);
    const pool = await poolView(TRIP, users.C);
    expect(pool).toMatchObject({ collectedAmountPaise: 15_000_00, remainingAmountPaise: 15_000_00, fundingPercentage: 50, reservedAmountPaise: 0, refundedAmountPaise: 0, availableAmountPaise: 15_000_00 });
    expect(pool.contributions.every((c) => c.statusLabel === "Paid")).toBe(true);
    const tx = await transactions(TRIP, users.A);
    expect(tx.transactions.filter((t) => t.kind === "contribution")).toHaveLength(3);
  });

  it("the ledger replays to the same pool, stays zero-sum, and settlement is unchanged by deposits", async () => {
    const before = computeLedger(await ledger());
    await contribute("A", 5_000_00);
    await contribute("B", 7_500_00);
    const replayed = reduceEvents(await repoInstance.getEvents(TRIP))!;
    const after = computeLedger(replayed);
    expect(poolFunding(replayed).collectedPaise).toBe(12_500_00);
    expect(after.reconciliationPaise).toBe(0);
    // Money parked in the pool isn't spent yet, so nobody owes anybody more.
    expect(after.transfers).toEqual(before.transfers);
    expect(after.balances[ids.A].contributedPaise).toBe(5_000_00);
  });

  it("once the pool pays a vendor, balances and settlement move through the normal ledger", async () => {
    await contribute("A", 9_000_00);
    const state = await ledger();
    const spend = payVendorFromPool(
      state,
      { title: "Cab", amountPaise: 9_000_00, date: "2026-10-11", category: "Local travel", participants: Object.values(ids).map((participantId) => ({ participantId, weight: 1 })), splitMode: "equal" },
      { actor: ids.A },
    );
    await repoInstance.appendEvents(TRIP, (await repoInstance.getEvents(TRIP)).length, [spend]);
    const l = computeLedger(await ledger());
    expect(l.balances[ids.A].netPaise).toBe(6_000_00); // funded ₹9,000, bears ₹3,000
    expect(l.balances[ids.B].netPaise).toBe(-3_000_00);
    expect(l.reconciliationPaise).toBe(0);
    const pool = await poolView(TRIP, users.A);
    expect(pool.reservedAmountPaise).toBe(9_000_00);
    expect(pool.availableAmountPaise).toBe(0);
  });
});

describe("vendor payments from the itinerary", () => {
  it("a verified vendor payment becomes exactly one expense paid by me, shared by the item's members", async () => {
    // Add a plan item for everyone, then pay its vendor through checkout.
    const { addItineraryItem } = await import("@/lib/ledger/commands");
    const state = await ledger();
    const item = addItineraryItem(
      state,
      { title: "Riverside camp", category: "Stay", date: "2026-10-10", estimatedPaise: 9_000_00, participantIds: Object.values(ids), vendor: "Beas Camps" },
      { actor: ids.A },
    );
    await repoInstance.appendEvents(TRIP, (await repoInstance.getEvents(TRIP)).length, [item]);
    const itemId = item.type === "ITINERARY_ITEM_ADDED" ? item.item.id : "";
    const order = await createPaymentOrder(users.A, { tripId: TRIP, purpose: "vendor", itemId, amountPaise: 9_000_00, methodLabel: "HDFC Regalia" });
    const checkout = rp.pay(order.orderId);
    await verifyPayment(users.A, { contributionId: order.contributionId, ...checkout });
    await verifyPayment(users.A, { contributionId: order.contributionId, ...checkout }); // replay
    const l = computeLedger(await ledger());
    const paid = l.expenses.filter((e) => e.expense.itineraryItemId === itemId);
    expect(paid).toHaveLength(1);
    expect(paid[0].expense.payers).toEqual([{ participantId: ids.A, amountPaise: 9_000_00 }]);
    expect(l.balances[ids.A].netPaise).toBe(6_000_00);
    expect(l.balances[ids.B].netPaise).toBe(-3_000_00);
    expect((await ledger()).itinerary.find((i) => i.id === itemId)!.status).toBe("booked");
    // Pool untouched; vendor payments can't be refunded through the pool.
    expect((await poolView(TRIP, users.A)).collectedAmountPaise).toBe(0);
    await expectHttp(refundContribution(users.A, checkout.razorpay_payment_id, {}), 409);
  });
});

describe("demo checkout (no Razorpay keys)", () => {
  it("runs the same verification pipeline and records once", async () => {
    const { DemoGateway } = await import("@/lib/server/razorpay");
    const { completeDemoCheckout } = await import("@/lib/server/payments");
    setGatewayForTests(new DemoGateway());
    const order = await createPaymentOrder(users.C, { tripId: TRIP, amountPaise: 2_500_00 });
    expect(order.mode).toBe("demo");
    const signed = await completeDemoCheckout(users.C, { contributionId: order.contributionId });
    await expectHttp(verifyPayment(users.C, { contributionId: order.contributionId, ...signed, razorpay_signature: "x" }), 400);
    expect((await verifyPayment(users.C, { contributionId: order.contributionId, ...signed })).status).toBe("VERIFIED");
    expect((await poolView(TRIP, users.C)).collectedAmountPaise).toBe(2_500_00);
    await expectHttp(completeDemoCheckout(users.A, { contributionId: order.contributionId }), 404); // not your order
  });

  it("needs no server memory: a fresh instance verifies the payment", async () => {
    const { DemoGateway } = await import("@/lib/server/razorpay");
    const { completeDemoCheckout } = await import("@/lib/server/payments");
    setGatewayForTests(new DemoGateway());
    const order = await createPaymentOrder(users.C, { tripId: TRIP, amountPaise: 1_200_00 });
    const signed = await completeDemoCheckout(users.C, { contributionId: order.contributionId });
    setGatewayForTests(new DemoGateway()); // e.g. verify lands on another serverless instance
    const tampered = signed.razorpay_payment_id.replace("_120000_", "_999900_");
    await expectHttp(verifyPayment(users.C, { contributionId: order.contributionId, ...signed, razorpay_payment_id: tampered }), 400);
    expect((await verifyPayment(users.C, { contributionId: order.contributionId, ...signed })).status).toBe("VERIFIED");
  });
});

describe("contribution wording", () => {
  it("labels demo-checkout payments as simulated and hides their internal ids", async () => {
    const { describeContributionMethod } = await import("@/lib/ledger/describe");
    const demo = describeContributionMethod("razorpay", "pay_demo_abc_def_100000_ok");
    expect(demo).toBe("Demo checkout (simulated) · verified by the server");
    expect(demo).not.toMatch(/pay_demo|Razorpay/);
    expect(describeContributionMethod("razorpay", "pay_R2x9")).toBe("Razorpay (test mode) · verified by the server · pay_R2x9");
    expect(describeContributionMethod("upi", "UPI UTR 123")).toBe("UPI · UPI UTR 123");
    expect(describeContributionMethod("cash")).toBe("Cash");
  });
});

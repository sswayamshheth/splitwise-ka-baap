import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { addExpense, addParticipant, createTrip } from "@/lib/ledger/commands";
import { computeLedger } from "@/lib/ledger/engine";
import { poolSummary } from "@/lib/ledger/pool";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";
import { FileRepo } from "@/lib/server/file-repo";
import { createPaymentOrder, createPaymentRequest, syncPaymentRequests, verifyPayment } from "@/lib/server/payments";
import { setGatewayForTests, type GatewayLink, type GatewayPayment, type PaymentGateway } from "@/lib/server/razorpay";
import { setRepoForTests } from "@/lib/server/repo";

/**
 * "Auto" money: settle-ups paid through Razorpay checkout, and payment links
 * (pool share / what someone owes me) that record themselves once Razorpay
 * reports them paid — nobody marks anything as paid.
 */
const SECRET = "test_key_secret";
const hmac = (d: string) => createHmac("sha256", SECRET).update(d).digest("hex");

class FakeRazorpay implements PaymentGateway {
  readonly keyId = "rzp_test_FAKE";
  readonly mode = "test" as const;
  private n = 0;
  orders = new Map<string, { id: string; amount: number; currency: string; status: string }>();
  payments = new Map<string, GatewayPayment>();
  links = new Map<string, GatewayLink>();
  async createOrder(i: { amountPaise: number; currency: string }) {
    const o = { id: `order_${++this.n}`, amount: i.amountPaise, currency: i.currency, status: "created" };
    this.orders.set(o.id, o);
    return o;
  }
  async fetchPayment(id: string) {
    return { ...this.payments.get(id)! };
  }
  async capturePayment(id: string) {
    return { ...this.payments.get(id)! };
  }
  async refundPayment(paymentId: string, i: { amountPaise: number }) {
    return { id: `rfnd_${++this.n}`, payment_id: paymentId, amount: i.amountPaise, status: "processed" };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return hmac(`${orderId}|${paymentId}`) === signature;
  }
  verifyWebhookSignature() {
    return false;
  }
  async createPaymentLink(i: { amountPaise: number }) {
    const l: GatewayLink = { id: `plink_${++this.n}`, short_url: `https://rzp.io/test/${this.n}`, status: "created", amount: i.amountPaise, payments: [] };
    this.links.set(l.id, l);
    return l;
  }
  async fetchPaymentLink(id: string) {
    return structuredClone(this.links.get(id)!);
  }
  /** The payer completes the hosted page. */
  payLink(id: string) {
    const l = this.links.get(id)!;
    const pid = `pay_${++this.n}`;
    this.payments.set(pid, { id: pid, order_id: `order_link_${this.n}`, amount: l.amount, currency: "INR", status: "captured" });
    l.status = "paid";
    l.payments.push({ payment_id: pid, status: "captured" });
  }
  payOrder(orderId: string) {
    const o = this.orders.get(orderId)!;
    const id = `pay_${++this.n}`;
    this.payments.set(id, { id, order_id: orderId, amount: o.amount, currency: "INR", status: "captured" });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: hmac(`${orderId}|${id}`) };
  }
}

const TRIP = "trip_auto_money";
const users = { A: "user_A", B: "user_B", C: "user_C" };
const ids: Record<string, string> = {};
let dir: string;
let r: FileRepo;
let rp: FakeRazorpay;
const state = async () => reduceEvents(await r.getEvents(TRIP))!;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gtl-auto-"));
  r = new FileRepo(path.join(dir, "db.json"));
  setRepoForTests(r);
  rp = new FakeRazorpay();
  setGatewayForTests(rp);
  const ctx = () => ({ actor: "system" as const, now: Date.now() });
  const events: LedgerEvent[] = [...createTrip({ name: "Auto Trip", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-14" }, ctx()).events];
  for (const n of ["A", "B", "C"]) {
    const e = addParticipant(reduceEvents(events)!, { name: `Member ${n}` }, ctx());
    events.push(e);
    if (e.type === "PARTICIPANT_ADDED") ids[n] = e.participant.id;
  }
  // A paid ₹3,000 for everyone → B and C each owe A ₹1,000.
  events.push(addExpense(reduceEvents(events)!, { title: "Villa", amountPaise: 3_000_00, date: "2026-10-10", category: "Stay", payers: [{ participantId: ids.A, amountPaise: 3_000_00 }], participants: ["A", "B", "C"].map((k) => ({ participantId: ids[k], weight: 1 })), splitMode: "equal" }, ctx()));
  events[0] = { ...events[0], trip: { ...(events[0] as Extract<LedgerEvent, { type: "TRIP_CREATED" }>).trip, id: TRIP } } as LedgerEvent;
  const now = Date.now();
  await r.createTrip({ id: TRIP, ownerId: users.A, name: "Auto Trip", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-14", status: "active", joinCode: "AUT123", createdAt: now, updatedAt: now }, { tripId: TRIP, userId: users.A, participantId: ids.A, role: "owner", joinedAt: now }, events);
  await r.addMember({ tripId: TRIP, userId: users.B, participantId: ids.B, role: "member", joinedAt: now });
  await r.addMember({ tripId: TRIP, userId: users.C, participantId: ids.C, role: "member", joinedAt: now });
});
afterEach(() => {
  setRepoForTests(null);
  setGatewayForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("settle up through Razorpay checkout", () => {
  it("B pays A what they owe: the settlement is recorded AND confirmed with no manual step", async () => {
    const order = await createPaymentOrder(users.B, { tripId: TRIP, amountPaise: 1_000_00, purpose: "settle", toId: ids.A });
    const res = await verifyPayment(users.B, { contributionId: order.contributionId, ...rp.payOrder(order.orderId) });
    expect(res.status).toBe("VERIFIED");
    const s = await state();
    expect(s.settlements).toHaveLength(1);
    expect(s.settlements[0]).toMatchObject({ from: ids.B, to: ids.A, amountPaise: 1_000_00, method: "razorpay", status: "confirmed" });
    const bal = computeLedger(s).balances;
    expect(bal[ids.B].netPaise).toBe(0);
    expect(bal[ids.A].netPaise).toBe(1_000_00);
    expect(computeLedger(s).reconciliationPaise).toBe(0);
  });

  it("refuses to pay someone more than you owe them", async () => {
    await expect(createPaymentOrder(users.B, { tripId: TRIP, amountPaise: 2_000_00, purpose: "settle", toId: ids.A })).rejects.toMatchObject({ status: 409 });
  });
});

describe("payment requests (Razorpay payment links)", () => {
  it("A asks C to settle up; when C pays the link, the next poll settles it automatically", async () => {
    const req = await createPaymentRequest(users.A, { tripId: TRIP, fromId: ids.C, amountPaise: 1_000_00, purpose: "settle" });
    expect(req.url).toMatch(/^https:\/\/rzp\.io\//);
    expect((await syncPaymentRequests(TRIP, users.A)).requests[0]).toMatchObject({ status: "PENDING" });
    expect((await state()).settlements).toHaveLength(0);

    rp.payLink(req.linkId);
    const after = await syncPaymentRequests(TRIP, users.A);
    expect(after.requests[0]).toMatchObject({ status: "VERIFIED" });
    const s = await state();
    expect(s.settlements[0]).toMatchObject({ from: ids.C, to: ids.A, amountPaise: 1_000_00, status: "confirmed" });
    // Polling again (or from another member's screen) never records it twice.
    await syncPaymentRequests(TRIP, users.B);
    expect((await state()).settlements).toHaveLength(1);
  });

  it("a pool request adds the payer's share to the pool once paid", async () => {
    const req = await createPaymentRequest(users.A, { tripId: TRIP, fromId: ids.B, amountPaise: 500_00, purpose: "pool" });
    expect(poolSummary(await state()).depositedPaise).toBe(0);
    rp.payLink(req.linkId);
    await syncPaymentRequests(TRIP, users.C);
    const pool = poolSummary(await state());
    expect(pool.depositedPaise).toBe(500_00);
    expect(pool.members[ids.B].depositedPaise).toBe(500_00);
  });

  it("you can't request a settle-up from yourself or for more than they owe", async () => {
    await expect(createPaymentRequest(users.A, { tripId: TRIP, fromId: ids.A, amountPaise: 100_00, purpose: "settle" })).rejects.toMatchObject({ status: 400 });
    await expect(createPaymentRequest(users.A, { tripId: TRIP, fromId: ids.B, amountPaise: 5_000_00, purpose: "settle" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("real UPI between members", () => {
  it("the receiver can record and confirm a UPI settle-up in one step; the debt clears", async () => {
    const { initiateSettlement, confirmSettlement } = await import("@/lib/ledger/commands");
    const s = await state();
    const sent = initiateSettlement(s, { from: ids.B, to: ids.A, amountPaise: 1_000_00, method: "upi", reference: "UPI · confirmed by the receiver" }, { actor: ids.A, now: Date.now() });
    expect(sent.type).toBe("SETTLEMENT_INITIATED");
    if (sent.type !== "SETTLEMENT_INITIATED") return;
    const after = { ...s, settlements: [...s.settlements, sent.settlement] };
    const ok = confirmSettlement(after, sent.settlement.id, { actor: ids.A, now: Date.now() + 1 });
    const final = reduceEvents([...(await r.getEvents(TRIP)), sent, ok])!;
    expect(final.settlements[0]).toMatchObject({ from: ids.B, to: ids.A, status: "confirmed", method: "upi" });
    expect(computeLedger(final).balances[ids.B].netPaise).toBe(0);
    expect(computeLedger(final).reconciliationPaise).toBe(0);
  });
});

import "server-only";

import { createHmac } from "node:crypto";
import Razorpay from "razorpay";
import { validatePaymentVerification, validateWebhookSignature } from "razorpay/dist/utils/razorpay-utils";

/**
 * Razorpay (TEST MODE) behind a small interface, so the payment service can
 * be tested with a fake gateway. Server-only: the key secret and webhook
 * secret are read from the environment here and never leave this module —
 * they are not returned by any API, logged, or bundled for the browser.
 */

export type GatewayOrder = { id: string; amount: number; currency: string; status: string; receipt?: string };
export type GatewayPayment = { id: string; order_id: string | null; amount: number; currency: string; status: string; error_description?: string | null };
export type GatewayRefund = { id: string; payment_id: string; amount: number; status: string };

export interface PaymentGateway {
  /** Public key id — safe to send to the browser for Checkout. */
  readonly keyId: string;
  readonly mode: "test" | "live" | "demo";
  createOrder(input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  capturePayment(paymentId: string, amountPaise: number, currency: string): Promise<GatewayPayment>;
  refundPayment(paymentId: string, input: { amountPaise: number; notes: Record<string, string> }): Promise<GatewayRefund>;
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export class GatewayUnavailable extends Error {
  constructor(public missing: string[]) {
    super(`Razorpay is not configured. Add ${missing.join(", ")} to final/web/.env.local`);
  }
}

class RazorpayGateway implements PaymentGateway {
  readonly mode: "test" | "live";
  private client: Razorpay;

  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.mode = keyId.startsWith("rzp_live_") ? "live" : "test";
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  async createOrder(input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }) {
    const o = await this.client.orders.create({ amount: input.amountPaise, currency: input.currency, receipt: input.receipt, notes: input.notes });
    return { id: o.id, amount: Number(o.amount), currency: o.currency, status: o.status, receipt: o.receipt ?? undefined };
  }
  async fetchPayment(paymentId: string) {
    const p = await this.client.payments.fetch(paymentId);
    return { id: p.id, order_id: p.order_id ?? null, amount: Number(p.amount), currency: p.currency, status: p.status, error_description: p.error_description ?? null };
  }
  async capturePayment(paymentId: string, amountPaise: number, currency: string) {
    const p = await this.client.payments.capture(paymentId, amountPaise, currency);
    return { id: p.id, order_id: p.order_id ?? null, amount: Number(p.amount), currency: p.currency, status: p.status, error_description: p.error_description ?? null };
  }
  async refundPayment(paymentId: string, input: { amountPaise: number; notes: Record<string, string> }) {
    const r = await this.client.payments.refund(paymentId, { amount: input.amountPaise, notes: input.notes });
    return { id: r.id, payment_id: r.payment_id, amount: Number(r.amount), status: r.status };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    try {
      return validatePaymentVerification({ order_id: orderId, payment_id: paymentId }, signature, this.keySecret);
    } catch {
      return false;
    }
  }
  verifyWebhookSignature(rawBody: string, signature: string) {
    if (!this.webhookSecret) return false;
    try {
      return validateWebhookSignature(rawBody, signature, this.webhookSecret);
    } catch {
      return false;
    }
  }
}

/**
 * DEMO checkout, used only when no Razorpay keys are configured (so the
 * presentation flow still works end to end). It is NOT Razorpay and moves no
 * money: orders and payments live in this server's memory, and "payments" are
 * signed with a per-process secret so the normal verification path — signature
 * check, trusted fetch, amount check, idempotent recognition — runs unchanged.
 * The UI labels it "Demo checkout (simulated)".
 */
type DemoStore = { secret: string; orders: Map<string, GatewayOrder>; payments: Map<string, GatewayPayment>; n: number };
const g = globalThis as unknown as { __gtlDemoPay?: DemoStore };
function demoStore(): DemoStore {
  if (!g.__gtlDemoPay) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    g.__gtlDemoPay = { secret: Buffer.from(bytes).toString("hex"), orders: new Map(), payments: new Map(), n: 0 };
  }
  return g.__gtlDemoPay;
}
const demoSign = (data: string) => createHmac("sha256", demoStore().secret).update(data).digest("hex");

export class DemoGateway implements PaymentGateway {
  readonly keyId = "demo_checkout";
  readonly mode = "demo" as const;
  async createOrder(input: { amountPaise: number; currency: string; receipt: string }) {
    const s = demoStore();
    const o = { id: `order_demo_${Date.now().toString(36)}${++s.n}`, amount: input.amountPaise, currency: input.currency, status: "created", receipt: input.receipt };
    s.orders.set(o.id, o);
    return o;
  }
  async fetchPayment(paymentId: string) {
    const p = demoStore().payments.get(paymentId);
    if (!p) throw new Error("Unknown demo payment");
    return { ...p };
  }
  async capturePayment(paymentId: string) {
    const p = demoStore().payments.get(paymentId);
    if (!p) throw new Error("Unknown demo payment");
    p.status = "captured";
    return { ...p };
  }
  async refundPayment(paymentId: string, input: { amountPaise: number }) {
    return { id: `rfnd_demo_${Date.now().toString(36)}`, payment_id: paymentId, amount: input.amountPaise, status: "processed" };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return demoSign(`${orderId}|${paymentId}`) === signature;
  }
  verifyWebhookSignature() {
    return false; // no webhooks in demo mode
  }
  /** Simulates the customer finishing checkout; returns what Checkout would hand the browser. */
  complete(orderId: string, outcome: "success" | "fail") {
    const s = demoStore();
    const o = s.orders.get(orderId);
    if (!o) throw new Error("Unknown demo order");
    const id = `pay_demo_${Date.now().toString(36)}${++s.n}`;
    s.payments.set(id, { id, order_id: orderId, amount: o.amount, currency: o.currency, status: outcome === "success" ? "captured" : "failed", error_description: outcome === "fail" ? "Declined in demo checkout" : null });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: demoSign(`${orderId}|${id}`) };
  }
}

let override: PaymentGateway | null = null;
/** Tests inject a fake gateway here. */
export function setGatewayForTests(g: PaymentGateway | null) {
  override = g;
}

let cached: PaymentGateway | null = null;
export function gateway(): PaymentGateway {
  if (override) return override;
  if (cached) return cached;
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  const missing = [!keyId && "RAZORPAY_KEY_ID", !keySecret && "RAZORPAY_KEY_SECRET"].filter(Boolean) as string[];
  if (missing.length) {
    // No keys: fall back to the labelled demo checkout unless explicitly disabled.
    if (process.env.DEMO_PAYMENTS === "off") throw new GatewayUnavailable(missing);
    cached = new DemoGateway();
    return cached;
  }
  cached = new RazorpayGateway(keyId!, keySecret!, process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined);
  return cached;
}

/** Safe, public configuration for the client. */
export function gatewayStatus() {
  try {
    const g = gateway();
    return { enabled: true, keyId: g.keyId, mode: g.mode, webhooks: g.mode !== "demo" && !!process.env.RAZORPAY_WEBHOOK_SECRET };
  } catch (e) {
    return { enabled: false, keyId: null, mode: null, webhooks: false, missing: e instanceof GatewayUnavailable ? e.missing : [] };
  }
}

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
/** A Razorpay Payment Link: a hosted page (UPI / cards / netbanking) the payer opens from a URL or QR. */
export type GatewayLink = { id: string; short_url: string; status: string; amount: number; payments: { payment_id: string; status: string }[] };

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
  /** Payment links (Razorpay only): create one, and read its status + payments. */
  createPaymentLink?(input: { amountPaise: number; currency: string; description: string; referenceId: string; notes: Record<string, string> }): Promise<GatewayLink>;
  fetchPaymentLink?(linkId: string): Promise<GatewayLink>;
}

export class GatewayUnavailable extends Error {
  constructor(public missing: string[]) {
    super("Payments are not set up on this server");
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
  async createPaymentLink(input: { amountPaise: number; currency: string; description: string; referenceId: string; notes: Record<string, string> }) {
    const l = await this.client.paymentLink.create({
      amount: input.amountPaise,
      currency: input.currency,
      description: input.description.slice(0, 2048),
      reference_id: input.referenceId,
      notes: input.notes,
      notify: { sms: false, email: false },
      reminder_enable: false,
      // The SDK's types demand fields the API doesn't (checked against the live test API).
    } as unknown as Parameters<Razorpay["paymentLink"]["create"]>[0]);
    return linkOf(l);
  }
  async fetchPaymentLink(linkId: string) {
    return linkOf(await this.client.paymentLink.fetch(linkId));
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

function linkOf(l: unknown): GatewayLink {
  const x = l as { id: string; short_url: string; status: string; amount: number | string; payments?: { payment_id: string; status: string }[] | null };
  return { id: x.id, short_url: x.short_url, status: x.status, amount: Number(x.amount), payments: (x.payments ?? []).map((p) => ({ payment_id: p.payment_id, status: p.status })) };
}

/**
 * DEMO checkout, used only when no Razorpay keys are configured (so the
 * presentation flow still works end to end). It is NOT Razorpay and moves no
 * money. It keeps no server memory, so it works when the create, complete and
 * verify requests land on different serverless instances: the payment id
 * carries its order, amount and outcome, and the Checkout-style signature over
 * "order|payment" (checked before the payment is read) makes it tamper-proof.
 * The signing key is derived from an existing server secret, so it is stable
 * across instances without a new environment variable.
 * The UI labels it "Demo checkout (simulated)".
 */
let demoKey: string | undefined;
function demoSecret(): string {
  if (demoKey) return demoKey;
  const base = process.env.SUPABASE_SECRET_KEY || process.env.CLERK_SECRET_KEY;
  if (base) demoKey = createHmac("sha256", base).update("grouptrip-demo-checkout-v1").digest("hex");
  else {
    // Local dev / tests without secrets: per-process key.
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    demoKey = Buffer.from(bytes).toString("hex");
  }
  return demoKey;
}
const demoSign = (data: string) => createHmac("sha256", demoSecret()).update(data).digest("hex");
const demoNonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// pay_demo_<order nonce>_<payment nonce>_<amount in paise>_<ok|fail>
const DEMO_PAYMENT = /^pay_demo_([a-z0-9]+)_([a-z0-9]+)_(\d+)_(ok|fail)$/;

export class DemoGateway implements PaymentGateway {
  readonly keyId = "demo_checkout";
  readonly mode = "demo" as const;
  async createOrder(input: { amountPaise: number; currency: string; receipt: string }) {
    return { id: `order_demo_${demoNonce()}`, amount: input.amountPaise, currency: input.currency, status: "created", receipt: input.receipt };
  }
  async fetchPayment(paymentId: string) {
    const m = DEMO_PAYMENT.exec(paymentId);
    if (!m) throw new Error("Unknown demo payment");
    const ok = m[4] === "ok";
    return { id: paymentId, order_id: `order_demo_${m[1]}`, amount: Number(m[3]), currency: "INR", status: ok ? "captured" : "failed", error_description: ok ? null : "Declined in demo checkout" };
  }
  async capturePayment(paymentId: string) {
    return { ...(await this.fetchPayment(paymentId)), status: "captured" };
  }
  async refundPayment(paymentId: string, input: { amountPaise: number }) {
    return { id: `rfnd_demo_${demoNonce()}`, payment_id: paymentId, amount: input.amountPaise, status: "processed" };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return demoSign(`${orderId}|${paymentId}`) === signature;
  }
  verifyWebhookSignature() {
    return false; // no webhooks in demo mode
  }
  /** Simulates the customer finishing checkout; returns what Checkout would hand the browser. */
  complete(orderId: string, amountPaise: number, outcome: "success" | "fail") {
    const m = /^order_demo_([a-z0-9]+)$/.exec(orderId);
    if (!m) throw new Error("Unknown demo order");
    const id = `pay_demo_${m[1]}_${demoNonce()}_${Math.round(amountPaise)}_${outcome === "success" ? "ok" : "fail"}`;
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

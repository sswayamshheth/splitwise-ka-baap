import { NextResponse } from "next/server";

import { handleWebhook } from "@/lib/server/payments";
import { route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";

/**
 * Razorpay webhooks (public route; authenticated by the HMAC signature over
 * the raw body with RAZORPAY_WEBHOOK_SECRET). Handles payment.captured,
 * order.paid, payment.failed, refund.processed and refund.failed — idempotently.
 */
export const POST = route(async (req: Request) => {
  const raw = await req.text();
  const result = await handleWebhook(raw, req.headers.get("x-razorpay-signature"), req.headers.get("x-razorpay-event-id"));
  return NextResponse.json(result);
});

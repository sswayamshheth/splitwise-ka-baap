import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { createPaymentOrder } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** Creates a PENDING pool contribution and its Razorpay (test mode) order. Nothing is collected yet. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await createPaymentOrder(userId, body), { status: 201 });
});

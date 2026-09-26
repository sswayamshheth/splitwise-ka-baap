import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { verifyPayment } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** Checkout's success handler posts here. The server re-verifies with Razorpay before recording anything. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await verifyPayment(userId, body));
});

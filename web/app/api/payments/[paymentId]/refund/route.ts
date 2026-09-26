import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { refundContribution } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** Refund a verified pool contribution through Razorpay (test mode). Contributor or organiser only. */
export const POST = route(async (req: Request, { params }: { params: { paymentId: string } }) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => ({}))) as { amountPaise?: unknown };
  return NextResponse.json(await refundContribution(userId, params.paymentId, body));
});

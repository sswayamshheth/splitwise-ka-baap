import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { completeDemoCheckout } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** DEMO checkout only (no Razorpay keys set): simulates the customer finishing checkout. Not Razorpay; moves no money. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await completeDemoCheckout(userId, body));
});

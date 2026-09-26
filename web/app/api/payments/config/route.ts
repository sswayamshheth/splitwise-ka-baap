import { NextResponse } from "next/server";

import { gatewayStatus } from "@/lib/server/razorpay";
import { requireUserId, route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";

/** Public Razorpay config for Checkout: key id and mode only — never a secret. */
export const GET = route(async () => {
  await requireUserId();
  return NextResponse.json(gatewayStatus());
});

import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { transactions } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** Pool money history: Razorpay contributions (all statuses), manual deposits, refunds and vendor payments from the pool. */
export const GET = route(async (_req: Request, { params }: { params: { id: string } }) => {
  const userId = await requireUserId();
  return NextResponse.json(await transactions(params.id, userId));
});

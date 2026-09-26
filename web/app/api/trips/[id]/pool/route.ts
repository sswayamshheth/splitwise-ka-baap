import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { poolView } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

/** The Trip Pool (simulated escrow): target, collected, reserved, refunded, available — derived from the ledger. */
export const GET = route(async (_req: Request, { params }: { params: { id: string } }) => {
  const userId = await requireUserId();
  return NextResponse.json(await poolView(params.id, userId));
});

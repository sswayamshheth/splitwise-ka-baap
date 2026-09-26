import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { captureBooking, requireExtensionUser } from "@/lib/server/ext";
import { route } from "@/lib/server/trips";

/** Adds a booking the user just made on a merchant site to the trip ledger. */
export const POST = route(async (req: Request) => {
  const userId = await requireExtensionUser(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await captureBooking(userId, body));
});

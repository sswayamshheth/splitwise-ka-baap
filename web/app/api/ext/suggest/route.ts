import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { requireExtensionUser, suggestForCheckout } from "@/lib/server/ext";
import { route } from "@/lib/server/trips";

/** Best card in the group for the checkout the extension is looking at. */
export const POST = route(async (req: Request) => {
  const userId = await requireExtensionUser(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await suggestForCheckout(userId, body));
});

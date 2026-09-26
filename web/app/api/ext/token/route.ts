import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { issueExtensionToken } from "@/lib/server/ext";
import { requireUserId, route } from "@/lib/server/trips";

/** Signed-in user creates a pairing token for the browser extension. Shown once. */
export const POST = route(async () => {
  const userId = await requireUserId();
  return NextResponse.json({ token: await issueExtensionToken(userId) });
});

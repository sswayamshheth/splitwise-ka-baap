import { NextResponse } from "next/server";

import { repo } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

/** Public: which store and auth the backend is running with. No secrets. */
export async function GET() {
  const r = await repo();
  return NextResponse.json({
    ok: true,
    store: r.kind,
    auth: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "clerk" : "missing",
    ai: process.env.ANTHROPIC_API_KEY ? "claude" : "offline",
  });
}

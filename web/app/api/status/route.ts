import { NextResponse } from "next/server";

import { chainConfigured } from "@/lib/server/chain";
import { gatewayStatus } from "@/lib/server/razorpay";
import { nugenConfigured } from "@/lib/server/nugen";
import { repo } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

/** Public: which store and auth the backend is running with, and whether the database answers. No secrets. */
export async function GET() {
  const r = await repo();
  let database: "connected" | "unreachable" | "local" = "local";
  if (r.ping) {
    try {
      database = (await r.ping()) ? "connected" : "unreachable";
    } catch {
      database = "unreachable";
    }
  }
  return NextResponse.json({
    ok: true,
    store: r.kind,
    database,
    payments: gatewayStatus().mode ?? "off",
    auth: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "clerk" : "missing",
    ai: nugenConfigured() ? "nugen" : process.env.ANTHROPIC_API_KEY ? "claude" : "offline",
    chain: chainConfigured(),
  });
}

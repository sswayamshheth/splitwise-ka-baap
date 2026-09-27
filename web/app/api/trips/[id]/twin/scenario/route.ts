import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { scenarioFromText } from "@/lib/nugen/intelligence";
import { loadTripContext } from "@/lib/server/twin-service";
import { HttpError, route } from "@/lib/server/trips";

/** What-If in plain language → a validated structured scenario (GroupTrip Intelligence, deterministic fallback). */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = (body.text ?? "").trim().slice(0, 400);
  if (!text) throw new HttpError(400, "Describe the What-If");
  const { state } = await loadTripContext(params.id);
  const { scenario, understood, meta } = await scenarioFromText(text, state);
  return NextResponse.json({ scenario, understood, meta });
});

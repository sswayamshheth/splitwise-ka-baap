import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { validateScenario } from "@/lib/twin/scenario";
import { twinWithIntelligence, worldFor, loadTripContext, type WorldMode } from "@/lib/server/twin-service";
import { HttpError, route } from "@/lib/server/trips";

/**
 * The trip's Digital Twin.
 *  GET  ?mode=live|replay[&refresh=1]  → real inputs + the REAL twin (live forecast, no scenario)
 *  POST { scenario, mode }             → a SIMULATED twin for a What-If scenario
 * Both only read the trip's event log; nothing is written.
 */

const modeOf = (v: unknown): WorldMode => (v === "replay" ? "replay" : "live");

export const GET = route(async (req: Request, { params }: { params: { id: string } }) => {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const { events, state } = await loadTripContext(params.id);
  const world = await worldFor(params.id, state, modeOf(url.searchParams.get("mode")), url.searchParams.get("refresh") === "1");
  const { twin, adaptation } = await twinWithIntelligence(state, events, world, null, startedAt);
  return NextResponse.json({ world, twin, adaptation });
});

export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const startedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as { scenario?: unknown; mode?: string };
  const { events, state } = await loadTripContext(params.id);
  if (!body.scenario) throw new HttpError(400, "Send a scenario");
  const { scenario, warnings } = validateScenario(body.scenario, state);
  const world = await worldFor(params.id, state, modeOf(body.mode));
  const { twin, adaptation } = await twinWithIntelligence(state, events, world, scenario, startedAt);
  return NextResponse.json({ twin, adaptation, warnings });
});

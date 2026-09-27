import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { explain } from "@/lib/nugen/intelligence";
import { factsFor } from "@/lib/twin/explain";
import { validateScenario } from "@/lib/twin/scenario";
import { buildTwin } from "@/lib/twin/twin";
import { loadTripContext, remaining, worldFor } from "@/lib/server/twin-service";
import { HttpError, route } from "@/lib/server/trips";

/**
 * "Why did you recommend this?" — the twin (real or simulated) is rebuilt on
 * the server, its facts (weather, scores, evidence, ledger results) are
 * collected, and GroupTrip Intelligence answers from those facts only.
 */
export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const startedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as { question?: string; scenario?: unknown; itemId?: string; mode?: string };
  const question = (body.question ?? "").trim().slice(0, 300);
  if (!question) throw new HttpError(400, "Ask a question");
  const { events, state } = await loadTripContext(params.id);
  const scenario = body.scenario ? validateScenario(body.scenario, state).scenario : null;
  const world = await worldFor(params.id, state, body.mode === "replay" ? "replay" : "live");
  // One model call per request: the explanation is grounded on the deterministic twin.
  const twin = buildTwin(state, events, world, scenario, { now: Date.now() });
  const facts = factsFor(twin, typeof body.itemId === "string" ? body.itemId : undefined);
  const result = await explain(question, facts, undefined, Math.min(25_000, remaining(startedAt) - 2_000));
  return NextResponse.json({ ...result, facts });
});

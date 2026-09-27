import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { NUGEN_API, nugenConfig } from "@/lib/nugen/client";
import { requireUserId, route } from "@/lib/server/trips";

/**
 * Judge-facing proof of the Nugen pipeline state. Reports only what is true:
 * whether a key is configured, which base model, whether an aligned model id
 * exists, and (when a key and alignment id exist) the live alignment status
 * straight from Nugen's API.
 */
export const GET = route(async () => {
  await requireUserId();
  const cfg = nugenConfig();
  let alignment: Record<string, unknown> | null = null;
  if (cfg?.alignmentId) {
    try {
      const res = await fetch(`${NUGEN_API}/api/v3/alignment-projects/${encodeURIComponent(cfg.alignmentId)}/status`, { headers: { authorization: `Bearer ${cfg.apiKey}` }, cache: "no-store" });
      alignment = res.ok ? ((await res.json()) as Record<string, unknown>) : { error: `HTTP ${res.status}` };
    } catch (e) {
      alignment = { error: (e as Error).message };
    }
  }
  const nugenOn = cfg?.provider !== "gemini" && !!cfg;
  return NextResponse.json({
    configured: nugenOn,
    provider: cfg?.provider ?? null,
    standIn: cfg?.provider === "gemini" ? { model: cfg.model, note: "Gemini runs in the GroupTrip Intelligence slot while Nugen access is waitlisted" } : null,
    api: NUGEN_API,
    baseModel: nugenOn ? cfg!.baseModel : (process.env.NUGEN_BASE_MODEL ?? "qwen-v2p5-0p5b-instruct"),
    alignedModelId: nugenOn && cfg!.aligned ? cfg!.model : null,
    alignmentId: nugenOn ? (cfg!.alignmentId ?? null) : null,
    alignment,
    inferenceModel: cfg ? cfg.model : null,
    stage: !cfg ? "not-configured" : cfg.provider === "gemini" ? "stand-in" : cfg.aligned ? "aligned-model-in-use" : "base-model-only",
  });
});

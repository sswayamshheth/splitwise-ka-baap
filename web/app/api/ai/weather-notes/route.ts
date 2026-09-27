import { NextResponse } from "next/server";

import { parseJsonObject, sanitizeWeatherNotes, type WeatherNoteInput } from "@/lib/ai/nugenGuards";
import { nugenConfigured, nugenTry } from "@/lib/server/nugen";
import { requireUserId, route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Accepts only the shape the Plan page sends, capped in size. */
function readInput(raw: unknown): WeatherNoteInput {
  const days = Array.isArray((raw as { days?: unknown })?.days) ? ((raw as { days: unknown[] }).days as Record<string, unknown>[]) : [];
  return {
    days: days.slice(0, 16).map((d) => ({
      date: str(d.date, 10),
      alerts: (Array.isArray(d.alerts) ? d.alerts : []).slice(0, 4).map((a: Record<string, unknown>) => ({ label: str(a.label, 40), reason: str(a.reason, 120) })),
      atRisk: (Array.isArray(d.atRisk) ? d.atRisk : []).slice(0, 10).map((a: Record<string, unknown>) => ({
        itemId: str(a.itemId, 80),
        title: str(a.title, 120),
        reasons: (Array.isArray(a.reasons) ? a.reasons : []).slice(0, 4).map((r: unknown) => str(r, 160)),
      })),
      alternatives: (Array.isArray(d.alternatives) ? d.alternatives : []).slice(0, 6).map((t: unknown) => str(t, 120)),
    })),
  };
}

/**
 * Friendly one-line explanations for weather alerts the code already decided,
 * and an ordering of the code's own indoor ideas. NuGen can't add alerts,
 * items, ideas or numbers — anything like that is dropped. { notes: {}, order: {} }
 * whenever NuGen is off or fails.
 */
export const POST = route(async (req: Request) => {
  await requireUserId();
  const input = readInput(await req.json().catch(() => null));
  const empty = { notes: {}, order: {} };
  if (!nugenConfigured() || !input.days.some((d) => d.atRisk.length)) return NextResponse.json(empty);
  const reply = await nugenTry(
    [
      {
        role: "system",
        content:
          'You help a travel group read weather alerts that were already decided by code. For each at-risk item write ONE short, friendly sentence explaining the alert, using only the reasons given (no new numbers, no new alerts). For each date, order the given indoor alternatives from most to least suitable, using only the given titles. Reply with JSON only: {"notes": {"<itemId>": "<sentence>"}, "order": {"<date>": ["<title>", ...]}}',
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    { maxTokens: 500, temperature: 0.3 },
    "nugen-weather",
  );
  if (!reply) return NextResponse.json(empty);
  return NextResponse.json(sanitizeWeatherNotes(parseJsonObject(reply), input));
});

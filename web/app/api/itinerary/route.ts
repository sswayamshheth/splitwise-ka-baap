import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { parseItineraryText, type DraftItem } from "@/lib/itinerary/parse";
import { suggestItinerary } from "@/lib/itinerary/suggest";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/ledger/types";
import { HttpError, requireUserId, route } from "@/lib/server/trips";

/**
 * Itinerary assistant for trip creation. Four inputs, one output shape
 * (DraftItem[] the user reviews before anything is saved):
 *   suggest — from the group's preferences (Claude if configured, else the curated library)
 *   refine  — a rough typed plan (Claude if configured, else the rule-based parser)
 *   pdf     — text extracted from a PDF in the browser (same as refine)
 *   photo   — an image of an itinerary (needs Claude: vision)
 * The model only proposes items; estimates are labelled estimates, nothing is booked.
 */

const MODEL = "claude-opus-5";
let client: Anthropic | null = null;
const ai = () => (process.env.ANTHROPIC_API_KEY ? (client ??= new Anthropic()) : null);

type Body = {
  mode?: "suggest" | "refine" | "pdf" | "photo";
  destination?: string;
  startDate?: string;
  endDate?: string;
  travellers?: number;
  interests?: Record<string, number>;
  diets?: string[];
  text?: string;
  image?: { mediaType?: string; data?: string };
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const TOOL = {
  name: "propose_itinerary",
  description: "Return the itinerary as structured items for the travellers to review.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            category: { type: "string", enum: EXPENSE_CATEGORIES },
            date: { type: "string", description: "YYYY-MM-DD within the trip dates" },
            endDate: { type: "string", description: "YYYY-MM-DD, for multi-night stays" },
            vendor: { type: "string" },
            estimateRupees: { type: "number", description: "Total estimate for the whole group in INR" },
            note: { type: "string", description: "One short line: why this item / source line" },
          },
          required: ["title", "category", "date", "estimateRupees"],
        },
      },
    },
    required: ["items"],
  },
};

function toDrafts(raw: unknown, start: string, end: string, source: string): DraftItem[] {
  const items = (raw as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 30).flatMap((x) => {
    const it = x as Record<string, unknown>;
    const title = typeof it.title === "string" ? it.title.trim().slice(0, 80) : "";
    const category = EXPENSE_CATEGORIES.includes(it.category as ExpenseCategory) ? (it.category as ExpenseCategory) : "Other";
    let date = typeof it.date === "string" && ISO.test(it.date) ? it.date : start;
    if (date < start || date > end) date = start;
    const endDate = typeof it.endDate === "string" && ISO.test(it.endDate) && it.endDate >= date && it.endDate <= end ? it.endDate : undefined;
    const rupees = typeof it.estimateRupees === "number" && Number.isFinite(it.estimateRupees) ? Math.max(0, Math.min(10_00_000, it.estimateRupees)) : 0;
    if (!title) return [];
    return [{ title, category, date, endDate, vendor: typeof it.vendor === "string" ? it.vendor.slice(0, 60) : undefined, estimatedPaise: Math.round(rupees * 100), evidence: `${source}${typeof it.note === "string" ? ` · ${it.note.slice(0, 120)}` : ""}`, confidence: "medium" as const }];
  });
}

async function askClaude(body: Body, start: string, end: string, travellers: number): Promise<DraftItem[]> {
  const c = ai()!;
  const context = `Trip: ${body.destination ?? "unknown destination"}, ${start} to ${end}, ${travellers} travellers. Group interests (count of people who like each): ${JSON.stringify(body.interests ?? {})}. Diets: ${(body.diets ?? []).join(", ") || "not given"}. Currency INR. Estimates are totals for the whole group.`;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (body.mode === "photo") {
    const media = body.image?.mediaType;
    if (!body.image?.data || !media || !/^image\/(png|jpeg|webp|gif)$/.test(media)) throw new HttpError(400, "Upload a PNG, JPG or WebP image");
    if (body.image.data.length > 7_000_000) throw new HttpError(413, "Image is too large (max ~5 MB)");
    content.push({ type: "image", source: { type: "base64", media_type: media as "image/png", data: body.image.data } });
    content.push({ type: "text", text: `${context}\nRead this itinerary image and return every item you can see. Keep the traveller's wording for titles. If a price is shown use it, otherwise give a sensible estimate and say so in note.` });
  } else if (body.mode === "suggest") {
    content.push({ type: "text", text: `${context}\nSuggest a realistic itinerary: one stay for the whole trip plus ~2 experiences per day that most of the group will enjoy, respecting diets for food items. Short, specific titles (real places when you know them).` });
  } else {
    content.push({ type: "text", text: `${context}\nThis is the travellers' rough plan. Turn it into clean itinerary items, keeping their intent; fill obvious gaps (a stay, transfers) only if clearly implied:\n\n${(body.text ?? "").slice(0, 12_000)}` });
  }
  const msg = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: "low" },
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content }],
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
  const use = (msg.content as { type: string; input?: unknown }[]).find((b) => b.type === "tool_use");
  const label = body.mode === "suggest" ? "AI suggestion" : body.mode === "photo" ? "Read from your photo by AI" : "Refined by AI";
  return toDrafts(use?.input, start, end, label);
}

export const POST = route(async (req: Request) => {
  await requireUserId();
  const body = (await req.json().catch(() => ({}))) as Body;
  const mode = body.mode ?? "suggest";
  const start = body.startDate && ISO.test(body.startDate) ? body.startDate : "";
  const end = body.endDate && ISO.test(body.endDate) && body.endDate >= start ? body.endDate : start;
  if (!start) throw new HttpError(400, "Trip dates are required");
  const travellers = Math.max(1, Math.min(50, Math.floor(body.travellers ?? 1)));
  const hasAI = !!ai();

  if (hasAI) {
    try {
      const items = await askClaude({ ...body, mode }, start, end, travellers);
      if (items.length) return NextResponse.json({ items, source: "ai", note: "Proposed by Claude — review every item and estimate before saving." });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("[itinerary] AI failed, falling back", e);
    }
  }
  if (mode === "photo") {
    throw new HttpError(501, hasAI ? "Couldn't read that photo — try a clearer image, or paste the text instead" : "Reading photos needs the AI assistant (set ANTHROPIC_API_KEY). You can paste the text or upload a PDF instead.");
  }
  if (mode === "suggest") {
    const items = suggestItinerary({ destination: body.destination ?? "", startDate: start, endDate: end, travellers, interests: body.interests ?? {} });
    return NextResponse.json({ items, source: "library", note: "Suggested from our curated activity library and your group's interests (AI suggestions need ANTHROPIC_API_KEY)." });
  }
  const parsed = parseItineraryText(body.text ?? "", { fallbackYear: Number(start.slice(0, 4)) });
  const items = parsed.items.map((i) => ({ ...i, date: i.date && i.date >= start && i.date <= end ? i.date : start }));
  return NextResponse.json({ items, source: "rules", note: items.length ? "Read by our rule-based parser — check each line against the source text shown." : "Couldn't find itinerary lines — add one item per line, e.g. '12 Oct · Villa check-in · ₹18,000'." });
});

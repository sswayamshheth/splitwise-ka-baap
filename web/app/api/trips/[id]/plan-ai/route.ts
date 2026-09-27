import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { extractCommand } from "@/lib/ai/nugenGuards";
import { planOffline, validateOps, type PlanOp } from "@/lib/itinerary/planner";
import { nugenConfig, providerLabel } from "@/lib/nugen/client";
import { importItineraryDoc, planWithNugen } from "@/lib/nugen/intelligence";
import { parseItineraryText } from "@/lib/itinerary/parse";
import { addDaysIso } from "@/lib/dates";
import { reduceEvents } from "@/lib/ledger/reduce";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/ledger/types";
import { nugenConfigured, nugenTry } from "@/lib/server/nugen";
import { HttpError, loadTripForUser, requireUserId, route } from "@/lib/server/trips";

/**
 * Plan assistant for an existing trip. Returns PROPOSED itinerary changes
 * (add / remove / update) for the user to review and apply — it never writes.
 * Claude handles free-form instructions when ANTHROPIC_API_KEY is set; the
 * built-in planner handles common ones otherwise. Output is validated against
 * the trip either way (dates inside the trip, paid bookings untouchable).
 */

const MODEL = "claude-opus-5";
let client: Anthropic | null = null;
const ai = () => (process.env.ANTHROPIC_API_KEY ? (client ??= new Anthropic()) : null);

const TOOL = {
  name: "propose_plan_changes",
  description: "Propose changes to the trip itinerary. Only unpaid items may be removed or updated.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "One or two sentences on what you changed and why" },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "remove", "update"] },
            itemId: { type: "string", description: "Existing item id (remove/update)" },
            title: { type: "string" },
            category: { type: "string", enum: EXPENSE_CATEGORIES },
            date: { type: "string", description: "YYYY-MM-DD inside the trip" },
            estimateRupees: { type: "number", description: "Total for the whole group, INR" },
            vendor: { type: "string" },
            reason: { type: "string" },
          },
          required: ["op", "reason"],
        },
      },
    },
    required: ["summary", "ops"],
  },
};

export const POST = route(async (req: Request, { params }: { params: { id: string } }) => {
  const userId = await requireUserId();
  const { events } = await loadTripForUser(params.id, userId);
  const state = reduceEvents(events);
  if (!state) throw new HttpError(500, "Trip ledger is unreadable");
  if (state.trip.status === "closed") throw new HttpError(409, "This trip is closed");
  const body = (await req.json().catch(() => ({}))) as { instruction?: string; document?: { name?: string; text?: string; image?: { mediaType?: string; data?: string } } };

  // An uploaded itinerary (PDF / text read in the browser, or a photo): the AI maps it onto the trip's days.
  if (body.document) {
    const d = body.document;
    const text = typeof d.text === "string" ? d.text.slice(0, 20_000) : undefined;
    const img = d.image && typeof d.image.data === "string" && /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/.test(d.image.mediaType ?? "") ? { mediaType: d.image.mediaType!, data: d.image.data } : undefined;
    if (img && img.data.length > 8_500_000) throw new HttpError(413, "That file is too large — try one under ~6 MB");
    if (!text?.trim() && !img) throw new HttpError(400, "Couldn't read anything from that file");
    const name = typeof d.name === "string" ? d.name.slice(0, 80) : undefined;
    const gti = nugenConfig();
    if (gti) {
      const r = await importItineraryDoc(state, { text, image: img, name }, gti);
      if (r.proposal && r.proposal.ops.length) return NextResponse.json({ ...r.proposal, source: "ai", model: providerLabel(gti) });
    }
    if (!text) throw new HttpError(503, img?.mediaType === "application/pdf" ? "This PDF has no readable text (it looks scanned) and the AI model that reads it isn't available right now — try again in a moment" : "Reading a photo needs the AI model, which isn't available right now — upload a PDF or text file instead");
    // Built-in parser fallback for text: "Day N" lines land on the trip's own days.
    const parsed = parseItineraryText(text);
    const ops: PlanOp[] = parsed.items.map((it) => ({
      op: "add" as const,
      item: { title: it.title, category: it.category, date: it.day ? addDaysIso(state.trip.startDate, it.day - 1) : (it.date ?? state.trip.startDate), vendor: it.vendor, estimatedPaise: it.estimatedPaise },
      reason: it.evidence,
    }));
    const valid = validateOps(state, ops);
    return NextResponse.json({ ops: valid, summary: valid.length ? `Read ${valid.length} item${valid.length === 1 ? "" : "s"} from ${name ?? "the file"} with the built-in parser` : "Couldn't find plan items in that file", understood: valid.length > 0, source: "builtin" });
  }

  const instruction = (body.instruction ?? "").trim().slice(0, 600);
  if (!instruction) throw new HttpError(400, "Tell the planner what you want");

  const c = ai();
  if (c) {
    try {
      const members = state.participants.filter((p) => !p.leftOn);
      const plan = state.itinerary
        .filter((i) => i.status !== "cancelled")
        .map((i) => ({ id: i.id, title: i.title, category: i.category, date: i.date, estimateRupees: i.estimatedPaise / 100, paid: i.expenseIds.length > 0, people: i.participantIds.length }));
      const prompt = [
        `Trip: ${state.trip.name}, ${state.trip.destination}, ${state.trip.startDate} to ${state.trip.endDate}, ${members.length} travellers.`,
        state.trip.budgetPaise ? `Budget: ₹${state.trip.budgetPaise / 100} total.` : "",
        `Travellers' preferences: ${JSON.stringify(members.map((m) => ({ name: m.name.split(" ")[0], ...m.interests })))}`,
        `Current itinerary (items with paid:true are booked and must NOT be removed or changed): ${JSON.stringify(plan)}`,
        `Instruction: ${instruction}`,
        "Propose concrete, realistic changes for this destination (real places where you know them). Estimates are totals for the whole group in INR. Keep changes minimal unless asked to replan.",
      ]
        .filter(Boolean)
        .join("\n");
      const msg = await c.beta.messages.create({
        model: MODEL,
        max_tokens: 3000,
        output_config: { effort: "low" },
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: prompt }],
      } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
      const use = (msg.content as { type: string; input?: { summary?: string; ops?: Record<string, unknown>[] } }[]).find((b) => b.type === "tool_use");
      const raw = use?.input?.ops ?? [];
      const ops: PlanOp[] = raw.flatMap((o): PlanOp[] => {
        const reason = typeof o.reason === "string" ? o.reason : "";
        if (o.op === "add") {
          return [{ op: "add", item: { title: String(o.title ?? ""), category: (EXPENSE_CATEGORIES as string[]).includes(String(o.category)) ? (o.category as ExpenseCategory) : "Activity", date: String(o.date ?? ""), estimatedPaise: Math.round(Number(o.estimateRupees ?? 0) * 100), vendor: typeof o.vendor === "string" ? o.vendor : undefined }, reason }];
        }
        if ((o.op === "remove" || o.op === "update") && typeof o.itemId === "string") {
          if (o.op === "remove") return [{ op: "remove", itemId: o.itemId, title: "", reason }];
          return [{ op: "update", itemId: o.itemId, title: "", changes: { date: typeof o.date === "string" ? o.date : undefined, title: typeof o.title === "string" ? o.title : undefined, estimatedPaise: typeof o.estimateRupees === "number" ? Math.round(o.estimateRupees * 100) : undefined }, reason }];
        }
        return [];
      });
      const valid = validateOps(state, ops);
      if (valid.length || raw.length === 0) {
        return NextResponse.json({ ops: valid, summary: use?.input?.summary ?? "", understood: true, source: "ai" });
      }
    } catch (e) {
      console.error("[plan-ai] Claude failed, using the built-in planner", e);
    }
  }
  // GroupTrip Intelligence (Nugen, or the Gemini stand-in while Nugen access is pending) — validated the same way.
  const gti = nugenConfig();
  if (gti) {
    const r = await planWithNugen(state, instruction, gti);
    if (r.proposal && r.proposal.ops.length) return NextResponse.json({ ...r.proposal, source: "ai", model: providerLabel(gti) });
  }
  const builtin = planOffline(state, instruction);
  // NuGen only rewrites a free-form request into a command the built-in planner understands;
  // the planner (code) still builds every proposal, and the user still applies it.
  if (!builtin.understood && nugenConfigured()) {
    const reply = await nugenTry(
      [
        {
          role: "system",
          content:
            "Rewrite a travel group's request as ONE short command for a trip planner. The planner understands only: add <activity type> (water sports, trek, nightlife, culture, food, spa, games, shopping…) optionally \"on day N\" or \"N options\"; remove <item>; move <item> to day N; make it cheaper; make a new plan. Reply with the command only. If none fits, reply NONE.",
        },
        { role: "user", content: instruction },
      ],
      { maxTokens: 40, temperature: 0 },
      "nugen-plan",
    );
    const command = reply ? extractCommand(reply) : "";
    if (command && !/^none$/i.test(command)) {
      const retried = planOffline(state, command);
      if (retried.understood) return NextResponse.json({ ...retried, source: "builtin", readAs: command });
    }
  }
  return NextResponse.json({ ...builtin, source: "builtin" });
});

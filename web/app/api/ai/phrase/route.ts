import { NextResponse } from "next/server";

import { cleanReply } from "@/lib/ai/nugenGuards";
import { nugenConfigured, nugenTry } from "@/lib/server/nugen";
import { requireUserId, route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rewords an answer the ledger engine already produced (offline assistant) so it
 * reads naturally. NuGen never computes anything here: the browser checks that
 * the reworded text keeps every figure and adds none, and otherwise keeps the
 * original. Returns { text: null } whenever NuGen is off or fails.
 */
export const POST = route(async (req: Request) => {
  await requireUserId();
  if (!nugenConfigured()) return NextResponse.json({ text: null });
  const body = (await req.json().catch(() => ({}))) as { question?: unknown; answer?: unknown };
  const question = typeof body.question === "string" ? body.question.slice(0, 300) : "";
  const answer = typeof body.answer === "string" ? body.answer.slice(0, 1500) : "";
  if (!answer.trim()) return NextResponse.json({ text: null });
  const reply = await nugenTry(
    [
      {
        role: "system",
        content:
          "You reword answers from a group-trip expense ledger so they read naturally. Keep every ₹ amount, number, name and fact exactly as given. Do not add amounts, numbers, facts, advice or opinions, and do not drop any figure. Plain text only, at most 4 short sentences or bullet lines.",
      },
      { role: "user", content: `Question: ${question}\n\nAnswer to reword:\n${answer}` },
    ],
    { maxTokens: 300, temperature: 0.2 },
    "nugen-phrase",
  );
  return NextResponse.json({ text: reply ? cleanReply(reply) : null });
});

import "server-only";
export const dynamic = "force-dynamic";

import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Relays one Messages API call for the in-app ledger assistant. The browser
 * runs the tool loop against the trip's own ledger; this route only adds the
 * API key and pins the model and request options, so a page can never choose
 * a different model, raise max_tokens or send arbitrary parameters.
 *
 * Model: claude-opus-5 with effort "low" — short Q&A turns over
 * pre-computed tool data (the model is never asked to do arithmetic).
 */
const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;
const MAX_MESSAGES = 80;
const MAX_TOOLS = 16;
const MAX_SYSTEM_CHARS = 20000;
const MAX_BODY_BYTES = 1_000_000;

export const runtime = "nodejs";

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
type Msg = { role: "user" | "assistant"; content: unknown };

function validate(body: unknown): { ok: true; params: { system: string; messages: Msg[]; tools: Tool[] } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object" };
  const { system, messages, tools } = body as { system?: unknown; messages?: unknown; tools?: unknown };
  if (typeof system !== "string" || system.length > MAX_SYSTEM_CHARS) return { ok: false, error: "system must be a string" };
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return { ok: false, error: "messages must be a non-empty array" };
  for (const m of messages as Msg[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return { ok: false, error: "each message needs role user or assistant" };
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return { ok: false, error: "message content must be a string or array" };
  }
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) return { ok: false, error: "tools must be an array" };
  for (const t of tools as Tool[]) {
    if (!t || typeof t.name !== "string" || typeof t.description !== "string" || typeof t.input_schema !== "object") return { ok: false, error: "each tool needs name, description, input_schema" };
  }
  return {
    ok: true,
    params: {
      system,
      messages: (messages as Msg[]).map((m) => ({ role: m.role, content: m.content })),
      tools: (tools as Tool[]).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    },
  };
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set. The assistant runs in offline mode." }, { status: 503 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const checked = validate(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  try {
    const message = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...checked.params,
    } as unknown as Parameters<ReturnType<typeof getClient>["beta"]["messages"]["create"]>[0]);
    const m = message as unknown as { id: string; model: string; content: unknown; stop_reason: string | null; usage: unknown };
    return NextResponse.json({ id: m.id, model: m.model, content: m.content, stop_reason: m.stop_reason, usage: m.usage });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return NextResponse.json({ error: "The API key was rejected." }, { status: 401 });
    if (error instanceof Anthropic.RateLimitError) return NextResponse.json({ error: "Rate limited — try again in a moment." }, { status: 429 });
    if (error instanceof Anthropic.BadRequestError) return NextResponse.json({ error: `Bad request: ${error.message}` }, { status: 400 });
    if (error instanceof Anthropic.APIConnectionError) return NextResponse.json({ error: "Could not reach the Claude API." }, { status: 502 });
    if (error instanceof Anthropic.APIError) return NextResponse.json({ error: `Claude API error ${error.status ?? ""}` }, { status: (error.status ?? 500) >= 500 ? 502 : (error.status ?? 500) });
    return NextResponse.json({ error: "Unexpected AI error." }, { status: 500 });
  }
}

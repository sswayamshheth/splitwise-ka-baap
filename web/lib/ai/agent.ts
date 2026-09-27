import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { runTool, TOOL_DEFINITIONS, type ToolContext, type ToolResult } from "./tools";
import { verifyAnswer, type Verification } from "./verify";

/**
 * Client-side agent loop.
 *
 *   question → proxy → Claude picks a tool → the tool runs HERE, in the
 *   browser, against the same event log the app renders → tool_result →
 *   proxy → Claude explains → every ₹ figure is verified against the tool
 *   outputs.
 *
 * The proxy only relays the Messages API call and holds the API key; it
 * never sees the ledger except through tool results the browser chooses to
 * send. The model can read and simulate — it has no tool that writes.
 */

export const PROXY_URL = process.env.NEXT_PUBLIC_AI_PROXY_URL || "/api/ai";
/** GET /api/status reports whether the server has an Anthropic key (ai: "claude" | "offline"). */
export const HEALTH_URL = "/api/status";
const MAX_ROUNDS = 5;

export const SYSTEM_PROMPT = `You are the ledger assistant inside GroupTrip Ledger, a group-travel money app. You answer questions about ONE trip by calling tools that query a deterministic ledger engine.

Rules:
- Every number you state must come from a tool result in this conversation. Quote rupee amounts exactly as the tool returned them (e.g. "₹10,800", "−₹1,800"). Do not add, subtract, round or estimate amounts yourself; if a figure you need is not in a tool result, call a tool or say it isn't available.
- For budget questions ("can we stay under ₹X?"), call check_budget_target and quote its headroom / overBy figures.
- For "what if" questions, call simulate_change (price changes: kind reprice with change_by or new_amount in rupees). Say plainly that it is a simulation and nothing has changed; the organiser can press Apply under your answer (they must confirm) or open it in the simulator. Never claim to have applied, booked, cancelled, paid or changed anything — you have no tool that can.
- If a tool returns an error (unknown or ambiguous person or booking), ask the user to clarify using the candidates it lists. Do not guess.
- Explain the "why": name the bookings, the policy percentages and the people involved, as the tool results describe them.
- Be concise: a short direct answer first, then at most a few bullet points. Plain text, no tables, no headings.`;

export type ToolCallRecord = { id: string; name: string; input: unknown; result: ToolResult };

export type AgentTurn = {
  text: string;
  calls: ToolCallRecord[];
  verification: Verification;
  stopReason: string | null;
  model?: string;
};

export type AgentState = { messages: BetaMessageParam[] };

export class ProxyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProxyError";
    this.status = status;
  }
}

export async function proxyHealth(signal?: AbortSignal): Promise<{ ok: boolean; hasKey: boolean; nugen: boolean; aiName?: string; model?: string }> {
  try {
    const res = await fetch(HEALTH_URL, { signal });
    if (!res.ok) return { ok: false, hasKey: false, nugen: false };
    const body = (await res.json()) as { ok?: boolean; ai?: string; aiName?: string; hasKey?: boolean; model?: string };
    // hasKey = Claude drives the tools itself; nugen = the rule-based answers are reworded by a model (NuGen, or the Gemini stand-in).
    return { ok: !!body.ok, hasKey: body.ai === "claude" || !!body.hasKey, nugen: body.ai === "nugen" || body.ai === "gemini", aiName: body.aiName, model: body.model };
  } catch {
    return { ok: false, hasKey: false, nugen: false };
  }
}

type Post = (body: unknown) => Promise<BetaMessage>;

const defaultPost: Post = async (body) => {
  const res = await fetch(PROXY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as (BetaMessage & { error?: string }) | null;
  if (!res.ok || !json) throw new ProxyError(json?.error ?? `AI proxy returned ${res.status}`, res.status);
  return json;
};

/**
 * Runs one user question to completion. `state.messages` is the running
 * conversation (append-only: assistant turns are echoed back unchanged,
 * including any thinking blocks, as the API requires).
 */
export async function askClaude(state: AgentState, question: string, ctx: ToolContext, post: Post = defaultPost): Promise<{ turn: AgentTurn; state: AgentState }> {
  const messages: BetaMessageParam[] = [...state.messages, { role: "user", content: question }];
  const calls: ToolCallRecord[] = [];
  let final: BetaMessage | null = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await post({ system: SYSTEM_PROMPT, tools: TOOL_DEFINITIONS, messages: [...messages] });
    messages.push({ role: "assistant", content: response.content as BetaContentBlockParam[] });
    final = response;
    if (response.stop_reason !== "tool_use") break;

    const results: BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = runTool(block.name, block.input, ctx);
      calls.push({ id: block.id, name: block.name, input: block.input, result });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error, candidates: result.candidates }),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (round === MAX_ROUNDS - 1) final = null;
  }

  let text = "";
  let stopReason: string | null = null;
  if (!final) {
    text = "I couldn't finish within the tool-call limit. Try a more specific question.";
  } else {
    stopReason = final.stop_reason;
    if (final.stop_reason === "refusal") text = "The model declined to answer this one.";
    else text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (final.stop_reason === "max_tokens") text += "\n\n(Answer cut off.)";
  }
  const verification = verifyAnswer(text, calls.filter((c) => c.result.ok).map((c) => (c.result as { data: unknown }).data));
  return { turn: { text, calls, verification, stopReason, model: final?.model }, state: { messages } };
}

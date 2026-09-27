/**
 * Nugen inference client (https://docs.nugen.in — "Nugen Intelligence API").
 *
 *   POST https://api.nugen.in/api/v3/inference/chat/completions
 *   Authorization: Bearer $NUGEN_API_KEY
 *   { model, messages, max_tokens, temperature }
 *   → { choices: [{ message: { content } }], usage, confidence_score }
 *
 * `model` is the ALIGNED GroupTrip Intelligence model id produced by the
 * alignment pipeline (scripts/nugen/align.ts → NUGEN_MODEL_ID). Until that
 * exists, NUGEN_BASE_MODEL can be used for inference but is reported as a base
 * (unaligned) model everywhere — the app never claims alignment it doesn't have.
 * `confidence_score` (0–100) is only returned by aligned models.
 */

export const NUGEN_API = process.env.NUGEN_API_BASE || "https://api.nugen.in";
export const DEFAULT_BASE_MODEL = "qwen-v2p5-0p5b-instruct";

export type NugenConfig = { apiKey: string; model: string; aligned: boolean; baseModel: string; alignmentId?: string };

export function nugenConfig(env: Record<string, string | undefined> = process.env): NugenConfig | null {
  const apiKey = env.NUGEN_API_KEY?.trim();
  if (!apiKey) return null;
  const aligned = env.NUGEN_MODEL_ID?.trim();
  const baseModel = env.NUGEN_BASE_MODEL?.trim() || DEFAULT_BASE_MODEL;
  return { apiKey, model: aligned || baseModel, aligned: !!aligned, baseModel, alignmentId: env.NUGEN_ALIGNMENT_ID?.trim() || undefined };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; model: string; confidenceScore: number | null; latencyMs: number; usage?: unknown };

export class NugenError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function nugenChat(cfg: NugenConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ChatResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${NUGEN_API}/api/v3/inference/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.2 }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new NugenError(`Nugen HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
    let json: { choices?: { message?: { content?: unknown }; text?: unknown }[]; model?: string; confidence_score?: unknown; usage?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new NugenError("Nugen returned non-JSON");
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content !== "string" || !content.trim()) throw new NugenError("Nugen returned no content");
    return { text: content, model: json.model ?? cfg.model, confidenceScore: typeof json.confidence_score === "number" ? json.confidence_score : null, latencyMs: Date.now() - started, usage: json.usage };
  } catch (e) {
    if (e instanceof NugenError) throw e;
    throw new NugenError((e as Error).name === "AbortError" ? "Nugen timed out" : `Nugen unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

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
/** Gemini's OpenAI-compatible endpoint — used only as a clearly-labelled stand-in while Nugen access is pending. */
export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"; // fast (~1–2 s) and reliable at peak times

/**
 * provider "nugen": the real Nugen API (aligned GroupTrip model when NUGEN_MODEL_ID is set).
 * provider "gemini": a STAND-IN (GEMINI_API_KEY) running in the same slot while Nugen access is waitlisted.
 * It is never reported as Nugen — every label and the proof panel say "Gemini stand-in".
 */
export type NugenConfig = { provider?: "nugen" | "gemini"; apiKey: string; model: string; aligned: boolean; baseModel: string; alignmentId?: string };

export function nugenConfig(env: Record<string, string | undefined> = process.env): NugenConfig | null {
  const apiKey = env.NUGEN_API_KEY?.trim();
  if (apiKey) {
    const aligned = env.NUGEN_MODEL_ID?.trim();
    const baseModel = env.NUGEN_BASE_MODEL?.trim() || DEFAULT_BASE_MODEL;
    return { provider: "nugen", apiKey, model: aligned || baseModel, aligned: !!aligned, baseModel, alignmentId: env.NUGEN_ALIGNMENT_ID?.trim() || undefined };
  }
  const gemini = env.GEMINI_API_KEY?.trim();
  if (gemini) {
    const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    return { provider: "gemini", apiKey: gemini, model, aligned: false, baseModel: model };
  }
  return null;
}

/** How a model is named on screen — a stand-in is always called what it is. */
export const providerLabel = (cfg: Pick<NugenConfig, "provider" | "model" | "aligned">) =>
  cfg.provider === "gemini" ? `Gemini ${cfg.model} (stand-in — Nugen access waitlisted)` : `Nugen ${cfg.model}${cfg.aligned ? " (aligned)" : " (base)"}`;

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** Text for every provider; image parts only for the Gemini stand-in (vision). */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };
export type ChatResult = { text: string; model: string; confidenceScore: number | null; latencyMs: number; usage?: unknown };

export class NugenError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Gemini models to try in turn when one is overloaded (HTTP 503/429) — busy models are common at peak times. */
const GEMINI_FALLBACKS = ["gemini-3.5-flash", "gemini-3.8-flash"];

export async function nugenChat(cfg: NugenConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ChatResult> {
  if (cfg.provider !== "gemini") return chatOnce(cfg, messages, opts);
  const started = Date.now();
  const budget = opts.timeoutMs ?? 25_000;
  const models = [cfg.model, ...GEMINI_FALLBACKS.filter((m) => m !== cfg.model)];
  let last: unknown;
  for (const model of models) {
    const left = budget - (Date.now() - started);
    if (left < 3_000) break;
    try {
      return await chatOnce({ ...cfg, model }, messages, { ...opts, timeoutMs: left });
    } catch (e) {
      last = e;
      if (!(e instanceof NugenError) || (e.status !== 503 && e.status !== 429)) throw e;
    }
  }
  throw last instanceof Error ? last : new NugenError("Gemini is busy — try again in a moment");
}

async function chatOnce(cfg: NugenConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ChatResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
  try {
    const gemini = cfg.provider === "gemini";
    const who = gemini ? "Gemini" : "Nugen";
    const res = await (opts.fetchImpl ?? fetch)(gemini ? `${GEMINI_API}/chat/completions` : `${NUGEN_API}/api/v3/inference/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(
        gemini
          ? // JSON mode (Gemini's OpenAI-compatible endpoint).
            { model: cfg.model, messages, max_tokens: Math.max(opts.maxTokens ?? 700, 2048), temperature: opts.temperature ?? 0.2, response_format: { type: "json_object" } }
          : { model: cfg.model, messages, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.2 },
      ),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new NugenError(`${who} HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
    let json: { choices?: { message?: { content?: unknown }; text?: unknown }[]; model?: string; confidence_score?: unknown; usage?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new NugenError(`${who} returned non-JSON`);
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content !== "string" || !content.trim()) throw new NugenError(`${who} returned no content`);
    return { text: content, model: json.model ?? cfg.model, confidenceScore: typeof json.confidence_score === "number" ? json.confidence_score : null, latencyMs: Date.now() - started, usage: json.usage };
  } catch (e) {
    if (e instanceof NugenError) throw e;
    const who = cfg.provider === "gemini" ? "Gemini" : "Nugen";
    throw new NugenError((e as Error).name === "AbortError" ? `${who} timed out` : `${who} unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

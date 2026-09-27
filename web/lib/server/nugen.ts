import "server-only";

/**
 * NuGen (https://docs.nugen.in) chat completions, server-side only.
 *
 * Used when NUGEN_API_KEY is set. NuGen only phrases, summarises and suggests:
 * every number and every decision comes from code, and every caller has a
 * code-only fallback, so a missing key, a timeout or an error never shows up
 * as an error to users. The key never leaves this module: it isn't returned,
 * logged or bundled for the browser, and failures are logged by code only.
 */

export const NUGEN_URL = "https://api.nugen.in/api/v3/inference/chat/completions";
export const DEFAULT_NUGEN_MODEL = "nugen-flash-instruct";
export const NUGEN_TIMEOUT_MS = 15_000;

export type NugenMessage = { role: "system" | "user" | "assistant"; content: string };

export class NugenError extends Error {
  /** "not-configured" | "timeout" | "http-<status>" | "network" | "bad-response" */
  constructor(public code: string) {
    super(`NuGen request failed (${code})`);
  }
}

export const nugenConfigured = () => !!process.env.NUGEN_API_KEY?.trim();
export const nugenModel = () => process.env.NUGEN_MODEL?.trim() || DEFAULT_NUGEN_MODEL;

type Fetch = typeof fetch;

/** One chat completion; resolves to the assistant's text. Throws NugenError (never with the key or the response body). */
export async function nugenChat(
  messages: NugenMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; fetchImpl?: Fetch } = {},
): Promise<string> {
  const key = process.env.NUGEN_API_KEY?.trim();
  if (!key) throw new NugenError("not-configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? NUGEN_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(NUGEN_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: nugenModel(), messages, max_tokens: opts.maxTokens ?? 300, temperature: opts.temperature ?? 0.3, stream: false }),
        signal: ctrl.signal,
      });
    } catch {
      throw new NugenError(ctrl.signal.aborted ? "timeout" : "network");
    }
    if (!res.ok) throw new NugenError(`http-${res.status}`);
    const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new NugenError("bad-response");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `nugenChat`, returning null (and logging only the error code) on any failure. */
export async function nugenTry(messages: NugenMessage[], opts: Parameters<typeof nugenChat>[1] = {}, label = "nugen"): Promise<string | null> {
  try {
    return await nugenChat(messages, opts);
  } catch (e) {
    console.error(`[${label}] failed:`, e instanceof NugenError ? e.code : "unexpected");
    return null;
  }
}

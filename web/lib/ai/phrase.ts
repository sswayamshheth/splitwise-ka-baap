import type { AgentTurn } from "./agent";
import { cleanReply, introducesNoNumbers, keepsAllNumbers } from "./nugenGuards";
import { verifyAnswer } from "./verify";

/**
 * Optional NuGen rewording of an offline (rule-based) answer. The ledger engine
 * has already computed every figure; NuGen only changes the wording. The new
 * text is used only if it keeps every number, adds none, and every ₹ figure
 * still matches the tool outputs — otherwise the original answer stands.
 */

export type PhrasePost = (body: { question: string; answer: string }) => Promise<{ text: string | null }>;

const PHRASE_TIMEOUT_MS = 16_000;

export const defaultPhrasePost: PhrasePost = async (body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PHRASE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ai/phrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) return { text: null };
    return ((await res.json().catch(() => null)) as { text: string | null } | null) ?? { text: null };
  } catch {
    return { text: null };
  } finally {
    clearTimeout(timer);
  }
};

export async function phraseTurn(question: string, turn: AgentTurn, post: PhrasePost = defaultPhrasePost): Promise<{ turn: AgentTurn; phrased: boolean }> {
  // Only answers that came from the engine and verified cleanly are worth rewording.
  if (!turn.calls.length || turn.verification.unverified.length) return { turn, phrased: false };
  let text: string | null = null;
  try {
    text = (await post({ question, answer: turn.text })).text;
  } catch {
    text = null;
  }
  if (!text) return { turn, phrased: false };
  const candidate = cleanReply(text);
  if (!candidate || !introducesNoNumbers(candidate, turn.text) || !keepsAllNumbers(candidate, turn.text)) return { turn, phrased: false };
  const outputs = turn.calls.filter((c) => c.result.ok).map((c) => (c.result as { data: unknown }).data);
  const verification = verifyAnswer(candidate, outputs);
  if (verification.unverified.length) return { turn, phrased: false };
  return { turn: { ...turn, text: candidate, verification }, phrased: true };
}

import { applyEvent } from "@/lib/ledger/reduce";
import { buildChangeEvents, type Change } from "@/lib/ledger/simulate";
import type { LedgerEvent, TripState } from "@/lib/ledger/types";

/** Builds every change in order, each on the state the previous ones produced — what Apply writes. */
export function buildAll(state: TripState, changes: Change[], ctx: { actor: string; now?: number }): LedgerEvent[] {
  let working = state;
  let now = ctx.now ?? Date.now();
  const out: LedgerEvent[] = [];
  for (const change of changes) {
    const built = buildChangeEvents(working, change, { actor: ctx.actor, now });
    now += built.length + 1;
    for (const e of built) {
      out.push(e);
      working = applyEvent(working, e) ?? working;
    }
  }
  return out;
}

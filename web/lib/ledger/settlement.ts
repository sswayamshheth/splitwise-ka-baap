import type { Paise } from "@/lib/money";
import type { ParticipantId } from "./types";

export type Transfer = { from: ParticipantId; to: ParticipantId; amountPaise: Paise };

type Entry = { id: ParticipantId; net: Paise };

/**
 * Settlement minimisation.
 *
 * Input: each participant's net balance in paise (positive = is owed money,
 * negative = owes money). Balances must sum to zero — the engine guarantees
 * that because every share is allocated with exact integer arithmetic.
 *
 * Strategy:
 *  1. Partition the non-zero balances into the maximum number of disjoint
 *     zero-sum groups (bitmask DP, exact for groups up to MAX_EXACT people).
 *     A group of k people can always be settled with k − 1 transfers, so
 *     more groups means fewer transfers. This is what turns A→B→C→A cycles
 *     into direct payments and finds "these two exactly cancel" pairs.
 *  2. Inside each group, greedily match the largest debtor with the largest
 *     creditor. Within a zero-sum group this yields exactly k − 1 transfers.
 *
 * Deterministic: ties are broken by participant order, so the same balances
 * always produce the same recommended transfers.
 */
export const MAX_EXACT = 16;

export function minimiseSettlement(balances: Record<ParticipantId, Paise>, order?: ParticipantId[]): Transfer[] {
  const ids = order ?? Object.keys(balances);
  const entries: Entry[] = ids.filter((id) => (balances[id] ?? 0) !== 0).map((id) => ({ id, net: balances[id] }));
  const total = entries.reduce((sum, e) => sum + e.net, 0);
  if (total !== 0) {
    throw new Error(`minimiseSettlement: balances must sum to zero (got ${total} paise)`);
  }
  if (entries.length === 0) return [];

  const groups = entries.length <= MAX_EXACT ? partitionZeroSum(entries) : [entries];
  const transfers: Transfer[] = [];
  for (const group of groups) transfers.push(...greedy(group));
  return transfers;
}

/** Bitmask DP: maximise the number of disjoint zero-sum subsets covering all entries. */
function partitionZeroSum(entries: Entry[]): Entry[][] {
  const n = entries.length;
  const full = (1 << n) - 1;
  const sums = new Int32Array(1 << n);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    const idx = 31 - Math.clz32(low);
    sums[mask] = sums[mask ^ low] + entries[idx].net;
  }
  // best[mask] = max number of zero-sum groups that exactly tile `mask`.
  // Only masks with sums[mask] === 0 can be tiled at all.
  const best = new Int8Array(1 << n).fill(-1);
  const choice = new Int32Array(1 << n); // the submask chosen as one group for reconstruction
  best[0] = 0;
  for (let mask = 1; mask <= full; mask++) {
    if (sums[mask] !== 0) continue;
    // The group containing the lowest set bit is some submask `sub` of mask containing that bit.
    const low = mask & -mask;
    const rest = mask ^ low;
    let bestHere = -1;
    let bestSub = 0;
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const group = sub | low;
      if (sums[group] === 0) {
        const remaining = mask ^ group;
        const b = best[remaining];
        if (b >= 0 && b + 1 > bestHere) {
          bestHere = b + 1;
          bestSub = group;
        }
      }
      if (sub === 0) break;
    }
    best[mask] = bestHere;
    choice[mask] = bestSub;
  }
  const groups: Entry[][] = [];
  let mask = full;
  while (mask) {
    const group = choice[mask];
    groups.push(entries.filter((_, i) => group & (1 << i)));
    mask ^= group;
  }
  return groups;
}

function greedy(group: Entry[]): Transfer[] {
  const debtors = group.filter((e) => e.net < 0).map((e) => ({ id: e.id, amount: -e.net }));
  const creditors = group.filter((e) => e.net > 0).map((e) => ({ id: e.id, amount: e.net }));
  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    // Always pair the current largest debtor with the current largest creditor.
    let di = i;
    for (let k = i + 1; k < debtors.length; k++) if (debtors[k].amount > debtors[di].amount) di = k;
    let cj = j;
    for (let k = j + 1; k < creditors.length; k++) if (creditors[k].amount > creditors[cj].amount) cj = k;
    [debtors[i], debtors[di]] = [debtors[di], debtors[i]];
    [creditors[j], creditors[cj]] = [creditors[cj], creditors[j]];

    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, amountPaise: amount });
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return transfers;
}

/** Number of transfers a naive "everyone pays everyone they owe" approach would need — for the "saved" stat. */
export function naiveTransferCount(pairwiseDebts: Record<string, Paise>): number {
  return Object.values(pairwiseDebts).filter((v) => v > 0).length;
}

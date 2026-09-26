import { formatDate } from "@/lib/dates";
import { allocate, type Paise } from "@/lib/money";
import type { CancellationPolicy, ExpenseCategory, ExpenseData, ItineraryItem, ParticipantId, Pricing } from "./types";

/**
 * Vendor cancellation policies and booking pricing. Pure helpers: the
 * refundable percentage on a given date is a lookup, never a guess.
 */

/** Tiers sorted by date, earliest first. */
export function sortedTiers(policy: CancellationPolicy) {
  return [...(policy.tiers ?? [])].sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
}

/**
 * The percentage a vendor refunds when cancelling on `date` (ISO). The first
 * tier whose `until` is on or after the date applies; after the last tier the
 * policy's base percentage applies. No policy means nothing is refundable.
 */
export function refundPercentOn(policy: CancellationPolicy | undefined, date: string): number {
  if (!policy) return 0;
  for (const tier of sortedTiers(policy)) {
    if (date <= tier.until) return clampPercent(tier.refundPercent);
  }
  return clampPercent(policy.refundPercent);
}

function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Which tier applied on a date, for explanations: "50% (until 8 Oct)". */
export function describeRefundOn(policy: CancellationPolicy | undefined, date: string): string {
  if (!policy) return "no cancellation policy recorded — nothing refundable";
  for (const tier of sortedTiers(policy)) {
    if (date <= tier.until) return `${tier.refundPercent}% refundable (cancelling on or before ${formatDate(tier.until)})`;
  }
  const tiers = sortedTiers(policy);
  if (tiers.length) return `${policy.refundPercent}% refundable (after ${formatDate(tiers[tiers.length - 1].until)})`;
  return `${policy.refundPercent}% refundable`;
}

/** "100% until 1 Oct · 50% until 8 Oct · then 0%". */
export function describePolicy(policy: CancellationPolicy | undefined): string {
  if (!policy) return "No cancellation policy";
  const tiers = sortedTiers(policy);
  if (!tiers.length) return `${policy.refundPercent}% refundable`;
  return [...tiers.map((t) => `${t.refundPercent}% until ${formatDate(t.until)}`), `then ${policy.refundPercent}%`].join(" · ");
}

const PER_HEAD_CATEGORIES: ExpenseCategory[] = ["Transport", "Activity"];

/** Per-head for tickets and activities, fixed for stays, cabs, meals unless stated. */
export function pricingOf(expense: Pick<ExpenseData, "pricing" | "category">): Pricing {
  return expense.pricing ?? (PER_HEAD_CATEGORIES.includes(expense.category) ? "per-head" : "fixed");
}

/** Plan items whose cost scales with headcount: tickets, activities, meals. A villa or a cab doesn't. */
export function planScalesWithHeadcount(item: Pick<ItineraryItem, "category">): boolean {
  return item.category === "Food" || pricingOf({ category: item.category }) === "per-head";
}

/**
 * Removes one person from a plan item. When the item is priced per head, their
 * part of the estimate leaves with them; otherwise the same estimate is
 * re-split among the rest.
 */
export function withoutPlanParticipant(item: ItineraryItem, pid: ParticipantId, perHead: boolean): ItineraryItem {
  const index = item.participantIds.indexOf(pid);
  if (index < 0) return item;
  const weights = item.participantIds.map((_, i) => Math.max(0, item.weights?.[i] ?? 1));
  const theirs: Paise = perHead ? allocate(item.estimatedPaise, weights)[index] : 0;
  return {
    ...item,
    estimatedPaise: item.estimatedPaise - theirs,
    participantIds: item.participantIds.filter((id) => id !== pid),
    weights: item.weights ? item.weights.filter((_, i) => i !== index) : undefined,
  };
}

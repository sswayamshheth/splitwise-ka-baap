import { sumPaise, type Paise } from "@/lib/money";
import type { ExpenseCategory, ExpenseView, ParticipantData, ParticipantId, PaymentMethod, PaymentMethodId, TripState } from "./types";

/**
 * Card-aware payment optimiser.
 *
 * A curated offer dataset (no scraping, no live API) plus a deterministic
 * constraint solve: for a given bill we filter offers by bank, network,
 * card kind, category and merchant, check minimum spend and the payer's
 * remaining credit headroom, cap the discount, and rank by rupees saved.
 * The same inputs always produce the same recommendation.
 */

export type BankOffer = {
  id: string;
  bank: string;
  /** Restrict to a card kind; absent = any card from that bank. */
  kind?: "credit-card" | "debit-card";
  network?: PaymentMethod["network"];
  /** Restrict to a named card, e.g. "HDFC Regalia". */
  cardLabel?: string;
  title: string;
  categories: ExpenseCategory[];
  /** Merchant keywords the vendor name must contain (case-insensitive). Empty = any. */
  merchants?: string[];
  percentOff: number;
  minSpendPaise: Paise;
  maxDiscountPaise: Paise;
  /** Human note shown alongside the recommendation. */
  terms: string;
};

/** Curated dataset for the prototype — 10 offers across 8 popular Indian cards. */
export const BANK_OFFERS: BankOffer[] = [
  {
    id: "of_hdfc_regalia_hotel",
    bank: "HDFC Bank",
    cardLabel: "HDFC Regalia",
    kind: "credit-card",
    title: "12% off on hotels & homestays",
    categories: ["Stay"],
    percentOff: 12,
    minSpendPaise: 25_000_00,
    maxDiscountPaise: 10_000_00,
    terms: "Min spend ₹25,000 · capped at ₹10,000 · hotels and homestays",
  },
  {
    id: "of_hdfc_millennia_food",
    bank: "HDFC Bank",
    cardLabel: "HDFC Millennia",
    kind: "credit-card",
    title: "5% cashback on dining",
    categories: ["Food"],
    percentOff: 5,
    minSpendPaise: 1_500_00,
    maxDiscountPaise: 1_000_00,
    terms: "Min spend ₹1,500 · capped at ₹1,000 per statement",
  },
  {
    id: "of_icici_amazonpay_any",
    bank: "ICICI Bank",
    cardLabel: "ICICI Amazon Pay",
    kind: "credit-card",
    title: "5% back on travel bookings",
    categories: ["Stay", "Transport", "Activity"],
    percentOff: 5,
    minSpendPaise: 5_000_00,
    maxDiscountPaise: 3_000_00,
    terms: "Min spend ₹5,000 · capped at ₹3,000",
  },
  {
    id: "of_axis_atlas_travel",
    bank: "Axis Bank",
    cardLabel: "Axis Atlas",
    kind: "credit-card",
    title: "10% off on flights & buses",
    categories: ["Transport"],
    percentOff: 10,
    minSpendPaise: 8_000_00,
    maxDiscountPaise: 4_000_00,
    terms: "Min spend ₹8,000 · capped at ₹4,000 · transport operators",
  },
  {
    id: "of_sbi_simplyclick_activity",
    bank: "SBI",
    cardLabel: "SBI SimplyCLICK",
    kind: "credit-card",
    title: "8% off on experiences & activities",
    categories: ["Activity"],
    percentOff: 8,
    minSpendPaise: 3_000_00,
    maxDiscountPaise: 2_500_00,
    terms: "Min spend ₹3,000 · capped at ₹2,500",
  },
  {
    id: "of_amex_platinum_stay",
    bank: "American Express",
    network: "Amex",
    kind: "credit-card",
    title: "8% off on stays over ₹40,000",
    categories: ["Stay"],
    percentOff: 8,
    minSpendPaise: 40_000_00,
    maxDiscountPaise: 8_000_00,
    terms: "Min spend ₹40,000 · capped at ₹8,000",
  },
  {
    id: "of_kotak_myntra_shopping",
    bank: "Kotak",
    cardLabel: "Kotak League",
    kind: "credit-card",
    title: "7.5% off on shopping",
    categories: ["Shopping"],
    percentOff: 7.5,
    minSpendPaise: 2_000_00,
    maxDiscountPaise: 1_500_00,
    terms: "Min spend ₹2,000 · capped at ₹1,500",
  },
  {
    id: "of_idfc_first_local",
    bank: "IDFC FIRST",
    cardLabel: "IDFC FIRST Select",
    kind: "credit-card",
    title: "6% off on cabs & local travel",
    categories: ["Local travel", "Transport"],
    percentOff: 6,
    minSpendPaise: 1_000_00,
    maxDiscountPaise: 1_200_00,
    terms: "Min spend ₹1,000 · capped at ₹1,200",
  },
  {
    id: "of_rupay_upi_any",
    bank: "Any",
    kind: "credit-card",
    network: "RuPay",
    title: "2% back on RuPay credit-card UPI",
    categories: ["Stay", "Transport", "Activity", "Food", "Local travel", "Shopping", "Other"],
    percentOff: 2,
    minSpendPaise: 500_00,
    maxDiscountPaise: 500_00,
    terms: "Any spend over ₹500 · capped at ₹500",
  },
  {
    id: "of_hdfc_any_weekend",
    bank: "HDFC Bank",
    kind: "credit-card",
    title: "3% weekend dining & travel offer",
    categories: ["Food", "Local travel", "Other"],
    percentOff: 3,
    minSpendPaise: 2_000_00,
    maxDiscountPaise: 800_00,
    terms: "Min spend ₹2,000 · capped at ₹800",
  },
];

export type OfferOption = {
  participantId: ParticipantId;
  participantName: string;
  method: PaymentMethod;
  offer?: BankOffer;
  discountPaise: Paise;
  /** Why this option is or isn't usable. */
  blocked?: string;
  /** True when the card has enough remaining limit for the bill. */
  affordable: boolean;
};

export type OptimiserInput = {
  amountPaise: Paise;
  category: ExpenseCategory;
  vendor?: string;
  /** Restrict the candidate payers (e.g. only people on this booking). */
  participantIds?: ParticipantId[];
};

export type OptimiserResult = {
  input: OptimiserInput;
  /** Every candidate, best first. */
  options: OfferOption[];
  best?: OfferOption;
  runnerUp?: OfferOption;
  /** best − runnerUp, i.e. what the recommendation is worth over the next option. */
  edgePaise: Paise;
};

function offerApplies(offer: BankOffer, method: PaymentMethod, input: OptimiserInput): boolean {
  if (offer.bank !== "Any" && offer.bank.toLowerCase() !== method.bank.toLowerCase()) return false;
  if (offer.kind && offer.kind !== method.kind) return false;
  if (offer.network && offer.network !== method.network) return false;
  if (offer.cardLabel && offer.cardLabel.toLowerCase() !== method.label.toLowerCase()) return false;
  if (!offer.categories.includes(input.category)) return false;
  if (offer.merchants?.length) {
    const vendor = (input.vendor ?? "").toLowerCase();
    if (!offer.merchants.some((m) => vendor.includes(m.toLowerCase()))) return false;
  }
  if (input.amountPaise < offer.minSpendPaise) return false;
  return true;
}

export function discountFor(offer: BankOffer, amountPaise: Paise): Paise {
  return Math.min(offer.maxDiscountPaise, Math.floor((amountPaise * offer.percentOff) / 100));
}

/** Best offer for one specific card, ignoring headroom. */
export function bestOfferForMethod(method: PaymentMethod, input: OptimiserInput): { offer?: BankOffer; discountPaise: Paise } {
  let best: BankOffer | undefined;
  let bestDiscount = 0;
  for (const offer of BANK_OFFERS) {
    if (!offerApplies(offer, method, input)) continue;
    const d = discountFor(offer, input.amountPaise);
    if (d > bestDiscount || (d === bestDiscount && best && offer.id < best.id)) {
      best = offer;
      bestDiscount = d;
    }
  }
  return { offer: best, discountPaise: bestDiscount };
}

/**
 * Ranks every member's cards for a bill. Deterministic: ties break on
 * headroom, then participant id, then method id.
 */
export function optimisePayment(participants: ParticipantData[], input: OptimiserInput): OptimiserResult {
  const eligible = input.participantIds?.length ? participants.filter((p) => input.participantIds!.includes(p.id)) : participants;
  const options: OfferOption[] = [];
  for (const p of eligible) {
    for (const method of p.paymentMethods ?? []) {
      if (method.kind === "netbanking") continue;
      const { offer, discountPaise } = bestOfferForMethod(method, input);
      const headroom = method.headroomPaise;
      const affordable = method.kind !== "credit-card" || headroom === undefined || headroom >= input.amountPaise;
      options.push({
        participantId: p.id,
        participantName: p.name,
        method,
        offer,
        discountPaise: affordable ? discountPaise : 0,
        affordable,
        blocked: affordable ? undefined : `Only ${headroom !== undefined ? headroom : 0} paise of limit left`,
      });
    }
  }
  options.sort((a, b) => {
    if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
    if (b.discountPaise !== a.discountPaise) return b.discountPaise - a.discountPaise;
    const ah = a.method.headroomPaise ?? Number.MAX_SAFE_INTEGER;
    const bh = b.method.headroomPaise ?? Number.MAX_SAFE_INTEGER;
    if (bh !== ah) return bh - ah;
    if (a.participantId !== b.participantId) return a.participantId < b.participantId ? -1 : 1;
    return a.method.id < b.method.id ? -1 : 1;
  });
  const usable = options.filter((o) => o.affordable);
  const best = usable[0];
  const runnerUp = usable.find((o) => o.participantId !== best?.participantId || o.method.id !== best?.method.id);
  return { input, options, best, runnerUp, edgePaise: Math.max(0, (best?.discountPaise ?? 0) - (runnerUp?.discountPaise ?? 0)) };
}

// ---------------------------------------------------------------- analyser

export type AnalysedPayment = {
  expense: ExpenseView;
  payerId: ParticipantId;
  payerName: string;
  method?: PaymentMethod;
  /** Discount actually recorded on the expense. */
  capturedPaise: Paise;
  /** What the best available card would have saved. */
  bestPossiblePaise: Paise;
  bestOption?: OfferOption;
  /** bestPossible − captured. Positive = money left on the table. */
  missedPaise: Paise;
  offer?: BankOffer;
};

export type Analysis = {
  payments: AnalysedPayment[];
  capturedPaise: Paise;
  missedPaise: Paise;
  potentialPaise: Paise;
  /** Savings grouped by the member who paid. */
  byMember: { participantId: ParticipantId; name: string; capturedPaise: Paise; count: number }[];
  /** Savings grouped by card label. */
  byCard: { label: string; bank: string; capturedPaise: Paise; count: number }[];
};

export function analysePayments(state: TripState): Analysis {
  const byId = new Map(state.participants.map((p) => [p.id, p]));
  const payments: AnalysedPayment[] = [];

  for (const expense of state.expenses) {
    if (expense.status === "cancelled") continue;
    const payer = [...expense.payers].sort((a, b) => b.amountPaise - a.amountPaise)[0];
    if (!payer) continue;
    const person = byId.get(payer.participantId);
    const method = person?.paymentMethods?.find((m) => m.id === expense.paymentMethodId);
    const captured = expense.discountPaise ?? 0;
    // Compare against the bill before any discount, otherwise a captured offer
    // shrinks the very amount the alternatives are measured on.
    const grossPaise = expense.amountPaise + captured;
    const input: OptimiserInput = { amountPaise: grossPaise, category: expense.category, vendor: expense.vendor };
    const result = optimisePayment(state.participants, input);
    const bestPossible = result.best?.discountPaise ?? 0;
    payments.push({
      expense,
      payerId: payer.participantId,
      payerName: person?.name ?? "Former member",
      method,
      capturedPaise: captured,
      bestPossiblePaise: bestPossible,
      bestOption: result.best,
      missedPaise: Math.max(0, bestPossible - captured),
      offer: method ? bestOfferForMethod(method, input).offer : undefined,
    });
  }

  const byMemberMap = new Map<ParticipantId, { participantId: ParticipantId; name: string; capturedPaise: Paise; count: number }>();
  const byCardMap = new Map<string, { label: string; bank: string; capturedPaise: Paise; count: number }>();
  for (const p of payments) {
    if (p.capturedPaise <= 0) continue;
    const m = byMemberMap.get(p.payerId) ?? { participantId: p.payerId, name: p.payerName, capturedPaise: 0, count: 0 };
    m.capturedPaise += p.capturedPaise;
    m.count += 1;
    byMemberMap.set(p.payerId, m);
    if (p.method) {
      const key = p.method.label;
      const c = byCardMap.get(key) ?? { label: p.method.label, bank: p.method.bank, capturedPaise: 0, count: 0 };
      c.capturedPaise += p.capturedPaise;
      c.count += 1;
      byCardMap.set(key, c);
    }
  }

  return {
    payments: payments.sort((a, b) => b.capturedPaise - a.capturedPaise || b.expense.amountPaise - a.expense.amountPaise),
    capturedPaise: sumPaise(payments.map((p) => p.capturedPaise)),
    missedPaise: sumPaise(payments.map((p) => p.missedPaise)),
    potentialPaise: sumPaise(payments.map((p) => p.bestPossiblePaise)),
    byMember: [...byMemberMap.values()].sort((a, b) => b.capturedPaise - a.capturedPaise),
    byCard: [...byCardMap.values()].sort((a, b) => b.capturedPaise - a.capturedPaise),
  };
}

/** Every offer a given member could use somewhere on this trip — for the methods screen. */
export function offersForMethod(method: PaymentMethod): BankOffer[] {
  return BANK_OFFERS.filter(
    (o) =>
      (o.bank === "Any" || o.bank.toLowerCase() === method.bank.toLowerCase()) &&
      (!o.kind || o.kind === method.kind) &&
      (!o.network || o.network === method.network) &&
      (!o.cardLabel || o.cardLabel.toLowerCase() === method.label.toLowerCase()),
  );
}

export const KNOWN_CARDS: { label: string; bank: string; network: PaymentMethod["network"]; kind: PaymentMethodKindLiteral }[] = [
  { label: "HDFC Regalia", bank: "HDFC Bank", network: "Visa", kind: "credit-card" },
  { label: "HDFC Millennia", bank: "HDFC Bank", network: "Mastercard", kind: "credit-card" },
  { label: "ICICI Amazon Pay", bank: "ICICI Bank", network: "Visa", kind: "credit-card" },
  { label: "Axis Atlas", bank: "Axis Bank", network: "Mastercard", kind: "credit-card" },
  { label: "SBI SimplyCLICK", bank: "SBI", network: "Visa", kind: "credit-card" },
  { label: "Amex Platinum Travel", bank: "American Express", network: "Amex", kind: "credit-card" },
  { label: "Kotak League", bank: "Kotak", network: "Visa", kind: "credit-card" },
  { label: "IDFC FIRST Select", bank: "IDFC FIRST", network: "RuPay", kind: "credit-card" },
];
type PaymentMethodKindLiteral = "credit-card" | "debit-card";

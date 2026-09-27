import type { Interests } from "@/lib/interests";
import type { Paise } from "@/lib/money";

/**
 * The ledger is an append-only log of events per trip. Every screen derives
 * what it shows by replaying that log (see reduce.ts) and then computing
 * budget, shares, balances and settlements from the derived state
 * (see budget.ts / engine.ts). Nothing stores a running total.
 *
 * The itinerary is the ledger:
 *   ItineraryItem (planned, estimated)
 *     → booked (actual price agreed with a vendor)
 *       → Expense (money actually moved to the vendor)
 *         → shares derived from participation
 *           → balances → refunds → settlement
 */

export type ParticipantId = string;
export type ExpenseId = string;
export type RefundId = string;
export type SettlementId = string;
export type ItineraryItemId = string;
export type PaymentMethodId = string;

export type ExpenseCategory = "Stay" | "Transport" | "Activity" | "Food" | "Local travel" | "Shopping" | "Other";
export const EXPENSE_CATEGORIES: ExpenseCategory[] = ["Stay", "Transport", "Activity", "Food", "Local travel", "Shopping", "Other"];

export type SplitMode = "equal" | "weighted" | "exact";

export type Participation = {
  participantId: ParticipantId;
  /**
   * Weight used to derive this person's share. Equal split: 1 for everyone.
   * Weighted: e.g. rooms or beds. Exact: the rupee amount entered, in paise,
   * used as a proportional weight so refunds and removals still reconcile.
   */
  weight: number;
};

export type Payer = { participantId: ParticipantId; amountPaise: Paise };

export type PolicyTier = {
  /** Last ISO date (inclusive) on which this tier applies. */
  until: string;
  /** Percentage refunded when cancelling on or before `until`, 0–100. */
  refundPercent: number;
};

export type CancellationPolicy = {
  /**
   * Percentage refunded when no tier applies (i.e. after the last tier's date),
   * 0–100. A policy with no tiers is a flat percentage.
   */
  refundPercent: number;
  /** Date-tiered refunds, e.g. 100% until 1 Oct, 50% until 8 Oct. Sorted by `until`. */
  tiers?: PolicyTier[];
  note?: string;
};

/**
 * How a booking's price responds to headcount.
 *  - per-head: every person is a seat (flights, scuba). Dropping a seat can
 *    earn a vendor refund; the price for everyone else is unchanged.
 *  - fixed: one price for the whole unit (a villa, a cab). Headcount does not
 *    change what the vendor charges, so someone leaving moves cost onto others
 *    unless the leaver agrees to keep paying.
 */
export type Pricing = "per-head" | "fixed";

/** What happens to a fixed-price booking's cost when someone leaves it. */
export type FixedLeaveRule = "redistribute" | "leaver-pays";

/**
 * A participant who dropped out of a booking after it was paid. Their share is
 * replaced by a fixed liability: whatever the vendor would not give back.
 */
export type Withdrawal = {
  participantId: ParticipantId;
  /** ISO date they dropped out — decides which policy tier applied. */
  date: string;
  pricing: Pricing;
  rule?: FixedLeaveRule;
  /** Their share of the booking just before withdrawing. */
  seatPaise: Paise;
  /** Percentage the vendor refunded for their seat (per-head only). */
  refundPercent: number;
  /** Vendor refund for their seat. Credited through the normal refund path. */
  refundPaise: Paise;
  /** What they still bear: seat − refund (per-head), 0 or seat (fixed). */
  retainedPaise: Paise;
  ts: number;
};

// ---------------------------------------------------------------- payment methods

export type PaymentMethodKind = "upi" | "credit-card" | "debit-card" | "netbanking";

/**
 * Card metadata only — never a card number. `label` is what the member calls
 * it ("HDFC Regalia"); `bank` and `network` drive offer eligibility.
 */
export type PaymentMethod = {
  id: PaymentMethodId;
  kind: PaymentMethodKind;
  label: string;
  bank: string;
  network?: "Visa" | "Mastercard" | "RuPay" | "Amex";
  /** Last four digits are safe to store and help a person recognise the card. */
  last4?: string;
  /** For credit cards: how much of the limit is still available, in paise. */
  headroomPaise?: Paise;
  upiId?: string;
  isDefault?: boolean;
};

export type ParticipantData = {
  id: ParticipantId;
  name: string;
  upiId?: string;
  phone?: string;
  paymentMethods?: PaymentMethod[];
  /** ISO date the member left the trip. They stay on the books until settled. */
  leftOn?: string;
  /** Travel preferences (optional) — drive the Harmony Score. */
  interests?: Interests;
};

// ---------------------------------------------------------------- itinerary

export type ItineraryStatus = "planned" | "booked" | "cancelled";

export type ItineraryItem = {
  id: ItineraryItemId;
  title: string;
  category: ExpenseCategory;
  /** ISO date the item starts. */
  date: string;
  /** ISO date it ends (stays spanning nights). Absent = single day. */
  endDate?: string;
  /** "09:30" — optional, only where it means something. */
  time?: string;
  location?: string;
  vendor?: string;
  /** The vendor's UPI ID (from their UPI QR or typed in) — used to pay them from a UPI app. */
  vendorUpi?: string;
  /** Payee name from the vendor's UPI QR, if it carried one. */
  vendorUpiName?: string;
  /** What we expect it to cost, in paise. Drives the budget. */
  estimatedPaise: Paise;
  /**
   * The price actually agreed with the vendor once booked. Absent while the
   * item is only planned. Vendor outstanding is computed from this.
   */
  actualPaise?: Paise;
  /** Who is planned to be part of it — drives per-person estimates. */
  participantIds: ParticipantId[];
  /** Weights matching participantIds for per-room / per-bed style items. */
  weights?: number[];
  status: ItineraryStatus;
  notes?: string;
  cancellationPolicy?: CancellationPolicy;
  /** Expenses recording money actually paid against this item. */
  expenseIds: ExpenseId[];
  /** Where the item came from, for the audit trail. */
  source?: "manual" | "imported" | "demo";
};

export type ExpenseData = {
  id: ExpenseId;
  title: string;
  vendor?: string;
  amountPaise: Paise;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  category: ExpenseCategory;
  payers: Payer[];
  participants: Participation[];
  splitMode: SplitMode;
  notes?: string;
  cancellationPolicy?: CancellationPolicy;
  /** Absent = inferred from the category (see pricingOf). */
  pricing?: Pricing;
  /** Paid to the vendor out of the trip pool; payers are the members whose deposits funded it. */
  fundedFromPool?: boolean;
  /** The itinerary item this expense pays for, when there is one. */
  itineraryItemId?: ItineraryItemId;
  /** Which payment method the (first) payer used — drives the analyser. */
  paymentMethodId?: PaymentMethodId;
  /** Bank/card discount actually captured on this payment, in paise. */
  discountPaise?: Paise;
  /** Free-text record of where the booking came from (deep link, receipt, manual). */
  capture?: { kind: "manual" | "receipt" | "deeplink"; reference?: string };
};

export type RefundData = {
  id: RefundId;
  expenseId: ExpenseId;
  amountPaise: Paise;
  /** Who actually received the money back from the vendor. */
  receivedBy: ParticipantId;
  date: string;
  reason?: string;
  source: "manual" | "cancellation" | "withdrawal";
};

export type SettlementMethod = "upi" | "cash" | "razorpay";
export type SettlementStatus = "initiated" | "confirmed" | "cancelled";

export type SettlementData = {
  id: SettlementId;
  from: ParticipantId;
  to: ParticipantId;
  amountPaise: Paise;
  method: SettlementMethod;
  /** UPI transaction reference or note supplied by the payer. */
  reference?: string;
  initiatedTs: number;
  confirmedTs?: number;
  cancelledTs?: number;
  status: SettlementStatus;
};

/**
 * Money a member moves into (or back out of) the trip pool. The pool is a
 * simulated escrow in this prototype: the ledger tracks it, no bank holds it.
 */
export type ContributionData = {
  id: string;
  participantId: ParticipantId;
  amountPaise: Paise;
  /** "in" = deposit (default), "out" = unspent money withdrawn back. */
  direction?: "in" | "out";
  method: SettlementMethod;
  reference?: string;
  ts: number;
};

export type TripStatus = "active" | "closed";

/** Where the trip is, as picked from the destination search (Open-Meteo geocoding): exact coordinates for weather and planning. */
export type TripPlace = { lat: number; lon: number; name: string; admin?: string; country?: string; source: "open-meteo-geocoding" };

export type TripMeta = {
  id: string;
  name: string;
  destination: string;
  /** Set when the destination was picked from the search list (always, for trips created in the app). */
  place?: TripPlace;
  startDate: string;
  endDate: string;
  currency: "INR";
  description?: string;
  status: TripStatus;
  /** Optional per-person target the organiser wants everyone to fund. */
  fundingTargetPaise?: Paise;
  /** Target for the whole trip pool (simulated escrow), in paise. */
  poolTargetPaise?: Paise;
  /** The group's total budget for the trip, in paise (set at creation, editable). */
  budgetPaise?: Paise;
  /** Optional split of the budget by category, in whole percentages summing to 100. */
  budgetSplit?: Partial<Record<ExpenseCategory, number>>;
};

type Base = { id: string; ts: number; actor: ParticipantId | "system" };

export type LedgerEvent =
  | (Base & { type: "TRIP_CREATED"; trip: TripMeta })
  | (Base & { type: "TRIP_UPDATED"; before: Partial<TripMeta>; after: Partial<TripMeta> })
  | (Base & { type: "TRIP_CLOSED"; summary: { plannedPaise: Paise; actualPaise: Paise; settledPaise: Paise; outstandingPaise: Paise } })
  | (Base & { type: "TRIP_REOPENED" })
  | (Base & { type: "PARTICIPANT_ADDED"; participant: ParticipantData })
  | (Base & { type: "PARTICIPANT_UPDATED"; participantId: ParticipantId; before: Partial<ParticipantData>; after: Partial<ParticipantData> })
  | (Base & { type: "PARTICIPANT_REMOVED"; participantId: ParticipantId; name: string; removedFromExpenses: ExpenseId[]; removedFromItinerary: ItineraryItemId[] })
  | (Base & { type: "PAYMENT_METHOD_ADDED"; participantId: ParticipantId; method: PaymentMethod })
  | (Base & { type: "PAYMENT_METHOD_REMOVED"; participantId: ParticipantId; methodId: PaymentMethodId; label: string })
  | (Base & { type: "ITINERARY_ITEM_ADDED"; item: ItineraryItem })
  | (Base & { type: "ITINERARY_ITEM_UPDATED"; itemId: ItineraryItemId; before: ItineraryItem; after: ItineraryItem })
  | (Base & { type: "ITINERARY_ITEM_REMOVED"; itemId: ItineraryItemId; item: ItineraryItem })
  | (Base & { type: "ITINERARY_IMPORTED"; items: ItineraryItem[]; sourceName: string })
  | (Base & { type: "EXPENSE_ADDED"; expense: ExpenseData })
  | (Base & { type: "EXPENSE_UPDATED"; expenseId: ExpenseId; before: ExpenseData; after: ExpenseData })
  | (Base & { type: "EXPENSE_DELETED"; expenseId: ExpenseId; expense: ExpenseData })
  | (Base & {
      type: "EXPENSE_CANCELLED";
      expenseId: ExpenseId;
      /** Refund created by applying the vendor's policy, if any money is recoverable. */
      refund?: RefundData;
      recoverablePaise: Paise;
      lossPaise: Paise;
      refundPercent: number;
    })
  | (Base & {
      type: "PARTICIPANT_WITHDRAWN";
      expenseId: ExpenseId;
      /** Denormalised so the audit line reads on its own. */
      expenseTitle: string;
      withdrawal: Withdrawal;
      /** Vendor refund for the withdrawn seat, when the policy returns anything. */
      refund?: RefundData;
    })
  | (Base & { type: "PARTICIPANT_LEFT"; participantId: ParticipantId; name: string; date: string })
  | (Base & { type: "REFUND_RECORDED"; refund: RefundData })
  | (Base & { type: "REFUND_DELETED"; refundId: RefundId; refund: RefundData })
  | (Base & { type: "SETTLEMENT_INITIATED"; settlement: SettlementData })
  | (Base & { type: "SETTLEMENT_CONFIRMED"; settlementId: SettlementId; confirmedTs: number })
  | (Base & { type: "SETTLEMENT_CANCELLED"; settlementId: SettlementId; reason?: string })
  | (Base & { type: "CONTRIBUTION_RECORDED"; contribution: ContributionData })
  | (Base & { type: "CONTRIBUTION_REMOVED"; contributionId: string; contribution: ContributionData });

export type LedgerEventType = LedgerEvent["type"];

/** Derived by replaying events. */
export type TripState = {
  trip: TripMeta;
  participants: ParticipantData[];
  itinerary: ItineraryItem[];
  expenses: ExpenseView[];
  refunds: RefundData[];
  settlements: SettlementData[];
  contributions: ContributionData[];
  closedAt?: number;
};

export type ExpenseView = ExpenseData & {
  status: "active" | "cancelled";
  /** People who dropped out after it was paid, with what they still bear. */
  withdrawals?: Withdrawal[];
  cancellation?: { recoverablePaise: Paise; lossPaise: Paise; refundPercent: number; ts: number };
};

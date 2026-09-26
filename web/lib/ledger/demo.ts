import type {
  ContributionData,
  ExpenseData,
  ItineraryItem,
  LedgerEvent,
  ParticipantData,
  PaymentMethod,
  RefundData,
  SettlementData,
  TripMeta,
} from "./types";

/**
 * The demo trip from the solution brief: six people, Manali, roughly ₹1.8
 * lakh of planned spend across several vendors. Built as an event log so the
 * audit trail is real history rather than decoration, and so every screen —
 * budget, ledger, optimiser, analyser, settlement — derives from the same
 * source. Every amount below is in paise.
 */
export const DEMO_TRIP_ID = "trip_demo_manali";

const P = {
  aisha: "p_aisha",
  rohit: "p_rohit",
  priya: "p_priya",
  amit: "p_amit",
  neha: "p_neha",
  karan: "p_karan",
} as const;

export const DEMO_VIEWER_ID = P.aisha;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<LedgerEvent, "id" | "ts" | "actor">;

const DAY = 24 * 3_600_000;

const card = (id: string, label: string, bank: string, network: PaymentMethod["network"], last4: string, headroomPaise: number): PaymentMethod => ({
  id,
  kind: "credit-card",
  label,
  bank,
  network,
  last4,
  headroomPaise,
});

export function buildDemoEvents(now = Date.now()): LedgerEvent[] {
  let seq = 0;
  const at = (daysAgo: number, hour = 10, minute = 0) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  const ev = (ts: number, actor: string, body: EventBody): LedgerEvent =>
    ({ id: `demo_ev_${String(++seq).padStart(3, "0")}`, ts, actor, ...body }) as LedgerEvent;
  const iso = (daysFromNow: number) => {
    const d = new Date(now + daysFromNow * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const trip: TripMeta = {
    id: DEMO_TRIP_ID,
    name: "Manali Long Weekend",
    destination: "Manali, Himachal Pradesh",
    startDate: iso(-5),
    endDate: iso(-1),
    currency: "INR",
    status: "active",
    description: "Six of us, four nights in Old Manali. Booked off one itinerary.",
    fundingTargetPaise: 20_000_00,
  };

  const people: ParticipantData[] = [
    {
      id: P.aisha,
      name: "Aisha Khan",
      upiId: "aisha.khan@okaxis",
      phone: "98200 11223",
      paymentMethods: [card("pm_aisha_atlas", "Axis Atlas", "Axis Bank", "Mastercard", "4417", 1_00_000_00)],
    },
    {
      id: P.rohit,
      name: "Rohit Mehra",
      upiId: "rohitmehra@ybl",
      phone: "98330 44556",
      paymentMethods: [
        card("pm_rohit_regalia", "HDFC Regalia", "HDFC Bank", "Visa", "8821", 2_50_000_00),
        card("pm_rohit_amazon", "ICICI Amazon Pay", "ICICI Bank", "Visa", "6310", 60_000_00),
      ],
    },
    {
      id: P.priya,
      name: "Priya Nair",
      upiId: "priya.nair@oksbi",
      paymentMethods: [card("pm_priya_idfc", "IDFC FIRST Select", "IDFC FIRST", "RuPay", "9042", 80_000_00)],
    },
    {
      id: P.amit,
      name: "Amit Shah",
      upiId: "amitshah@paytm",
      phone: "99870 77889",
      paymentMethods: [card("pm_amit_sbi", "SBI SimplyCLICK", "SBI", "Visa", "1177", 1_20_000_00)],
    },
    {
      id: P.neha,
      name: "Neha Verma",
      upiId: "nehav@okhdfcbank",
      paymentMethods: [card("pm_neha_amazon", "ICICI Amazon Pay", "ICICI Bank", "Visa", "5508", 45_000_00)],
    },
    { id: P.karan, name: "Karan Bose", paymentMethods: [card("pm_karan_millennia", "HDFC Millennia", "HDFC Bank", "Mastercard", "3390", 90_000_00)] },
  ];

  const everyone = Object.values(P);
  const eq = (ids: string[]) => ids.map((participantId) => ({ participantId, weight: 1 }));

  // ---------------------------------------------------------------- itinerary
  const item = (
    id: string,
    title: string,
    category: ItineraryItem["category"],
    dayOffset: number,
    estimatedPaise: number,
    participantIds: string[],
    extra: Partial<ItineraryItem> = {},
  ): ItineraryItem => ({
    id,
    title,
    category,
    date: iso(dayOffset),
    estimatedPaise,
    participantIds,
    status: "planned",
    expenseIds: [],
    source: "demo",
    ...extra,
  });

  const itinerary: ItineraryItem[] = [
    item("it_bus_out", "Volvo bus · Delhi → Manali", "Transport", -6, 21_600_00, everyone, { vendor: "HRTC Volvo", time: "21:00", location: "Kashmere Gate ISBT" }),
    item("it_homestay", "Homestay · Old Manali", "Stay", -5, 62_000_00, everyone, {
      vendor: "Himalayan Nest Homestay",
      endDate: iso(-1),
      location: "Old Manali",
      notes: "3 rooms, 4 nights.",
      cancellationPolicy: { refundPercent: 50, note: "50% refundable up to 48h before check-in" },
    }),
    item("it_upgrade", "Room upgrade · valley view", "Stay", -5, 4_500_00, [P.rohit, P.priya], { vendor: "Himalayan Nest Homestay", weights: [2, 1] }),
    item("it_meals", "Breakfast & dinner package", "Food", -4, 18_000_00, everyone, { vendor: "Himalayan Nest Homestay", notes: "Half board for four nights — still to be settled with the host." }),
    item("it_paragliding", "Paragliding at Solang", "Activity", -4, 18_000_00, [P.aisha, P.rohit, P.amit, P.karan], { vendor: "Solang Sky Sports", time: "09:30" }),
    item("it_cabs", "Local cabs · 3 days", "Local travel", -4, 15_000_00, everyone, { vendor: "Manali Taxi Union" }),
    item("it_rafting", "River rafting · Beas", "Activity", -3, 9_600_00, everyone, { vendor: "Beas Adventures", time: "11:00" }),
    item("it_permits", "Rohtang permits & entry", "Other", -3, 2_400_00, [P.aisha, P.rohit, P.amit, P.karan]),
    item("it_bus_back", "Volvo bus · Manali → Delhi", "Transport", -1, 21_600_00, everyone, { vendor: "HRTC Volvo", time: "17:30" }),
    item("it_souvenirs", "Mall Road shopping budget", "Shopping", -2, 6_000_00, everyone),
  ];

  // ---------------------------------------------------------------- expenses
  const expense = (
    id: string,
    title: string,
    category: ExpenseData["category"],
    dayOffset: number,
    amountPaise: number,
    payers: ExpenseData["payers"],
    participants: ExpenseData["participants"],
    extra: Partial<ExpenseData> = {},
  ): ExpenseData => ({
    id,
    title,
    amountPaise,
    date: iso(dayOffset),
    category,
    payers,
    participants,
    splitMode: "equal",
    ...extra,
  });

  const busOut = expense("x_bus_out", "Volvo bus · Delhi → Manali", "Transport", -6, 19_440_00, [{ participantId: P.aisha, amountPaise: 19_440_00 }], eq(everyone), {
    vendor: "HRTC Volvo",
    itineraryItemId: "it_bus_out",
    paymentMethodId: "pm_aisha_atlas",
    discountPaise: 2_160_00,
    capture: { kind: "deeplink", reference: "HRTC-4471902" },
    notes: "₹21,600 bill, 10% Axis Atlas travel offer applied at checkout.",
  });

  const homestay = expense("x_homestay", "Homestay · Old Manali", "Stay", -5, 54_560_00, [{ participantId: P.rohit, amountPaise: 54_560_00 }], eq(everyone), {
    vendor: "Himalayan Nest Homestay",
    itineraryItemId: "it_homestay",
    paymentMethodId: "pm_rohit_regalia",
    discountPaise: 7_440_00,
    cancellationPolicy: { refundPercent: 50, note: "50% refundable up to 48h before check-in" },
    capture: { kind: "manual" },
    notes: "₹62,000 bill. The optimiser picked Rohit's HDFC Regalia for the 12% stay offer — ₹7,440 off, capped at ₹10,000.",
  });

  const upgrade = expense("x_upgrade", "Room upgrade · valley view", "Stay", -5, 4_500_00, [{ participantId: P.rohit, amountPaise: 4_500_00 }], [
    { participantId: P.rohit, weight: 2 },
    { participantId: P.priya, weight: 1 },
  ], { vendor: "Himalayan Nest Homestay", itineraryItemId: "it_upgrade", splitMode: "weighted", paymentMethodId: "pm_rohit_regalia", notes: "Rohit took the bigger room — 2:1 weighted split." });

  const paragliding = expense("x_paragliding", "Paragliding at Solang", "Activity", -4, 16_560_00, [{ participantId: P.amit, amountPaise: 16_560_00 }], eq([P.aisha, P.rohit, P.amit, P.karan]), {
    vendor: "Solang Sky Sports",
    itineraryItemId: "it_paragliding",
    paymentMethodId: "pm_amit_sbi",
    discountPaise: 1_440_00,
    capture: { kind: "receipt", reference: "SSS-2291" },
    notes: "₹18,000 bill, 8% SBI SimplyCLICK experiences offer.",
  });

  const raftingWithPriya = expense("x_rafting", "River rafting · Beas", "Activity", -3, 8_832_00, [{ participantId: P.amit, amountPaise: 8_832_00 }], eq(everyone), {
    vendor: "Beas Adventures",
    itineraryItemId: "it_rafting",
    paymentMethodId: "pm_amit_sbi",
    discountPaise: 768_00,
  });
  const raftingWithoutPriya: ExpenseData = { ...raftingWithPriya, participants: eq(everyone.filter((id) => id !== P.priya)) };

  const cabs = expense("x_cabs", "Local cabs · day 1–2", "Local travel", -4, 7_200_00, [{ participantId: P.neha, amountPaise: 7_200_00 }], eq(everyone), {
    vendor: "Manali Taxi Union",
    itineraryItemId: "it_cabs",
    paymentMethodId: "pm_neha_amazon",
    notes: "Part payment — the remaining days are still on the meter.",
  });

  const permits = expense("x_permits", "Rohtang permits & entry", "Other", -3, 2_400_00, [
    { participantId: P.aisha, amountPaise: 1_400_00 },
    { participantId: P.rohit, amountPaise: 1_000_00 },
  ], eq([P.aisha, P.rohit, P.amit, P.karan]), { itineraryItemId: "it_permits", notes: "Aisha paid online, Rohit paid the cash top-up at the barrier." });

  const dinner = expense("x_dinner", "Dinner at Johnson's Cafe", "Food", -4, 7_980_00, [{ participantId: P.karan, amountPaise: 7_980_00 }], eq([P.aisha, P.rohit, P.priya, P.amit, P.karan]), {
    vendor: "Johnson's Cafe",
    paymentMethodId: "pm_karan_millennia",
    discountPaise: 420_00,
    notes: "Not on the itinerary — Neha skipped, early night before the trek.",
  });

  const lunch = expense("x_lunch", "Lunch at Cafe 1947", "Food", -3, 3_150_50, [{ participantId: P.priya, amountPaise: 3_150_50 }], eq([P.priya, P.neha, P.aisha]), {
    vendor: "Cafe 1947",
  });

  const paraglidingRefund: RefundData = {
    id: "rf_paragliding",
    expenseId: paragliding.id,
    amountPaise: 4_140_00,
    receivedBy: P.amit,
    date: iso(-3),
    reason: "Afternoon slot cancelled for wind — operator refunded one flight",
    source: "manual",
  };

  const nehaToRohit: SettlementData = {
    id: "st_neha_rohit",
    from: P.neha,
    to: P.rohit,
    amountPaise: 5_000_00,
    method: "upi",
    reference: "UPI 4267…931",
    initiatedTs: at(1, 19, 40),
    confirmedTs: at(1, 19, 52),
    status: "confirmed",
  };
  const karanToRohit: SettlementData = {
    id: "st_karan_rohit",
    from: P.karan,
    to: P.rohit,
    amountPaise: 3_000_00,
    method: "upi",
    reference: "UPI 8810…204",
    initiatedTs: at(0, 9, 12),
    status: "initiated",
  };

  const contribution = (id: string, participantId: string, amountPaise: number, daysAgo: number): ContributionData => ({
    id,
    participantId,
    amountPaise,
    method: "upi",
    reference: "Trip kitty",
    ts: at(daysAgo, 12, 0),
  });

  return [
    ev(at(12, 21, 5), P.aisha, { type: "TRIP_CREATED", trip }),
    ...people.map((participant, i) => ev(at(12, 21, 6 + i), P.aisha, { type: "PARTICIPANT_ADDED", participant })),
    ev(at(11, 18, 0), P.aisha, { type: "ITINERARY_IMPORTED", items: itinerary, sourceName: "Manali-itinerary.pdf" }),
    ev(at(10, 10, 15), P.rohit, { type: "CONTRIBUTION_RECORDED", contribution: contribution("ct_rohit", P.rohit, 20_000_00, 10) }),
    ev(at(10, 10, 22), P.neha, { type: "CONTRIBUTION_RECORDED", contribution: contribution("ct_neha", P.neha, 20_000_00, 10) }),
    ev(at(10, 11, 4), P.priya, { type: "CONTRIBUTION_RECORDED", contribution: contribution("ct_priya", P.priya, 10_000_00, 10) }),
    ev(at(8, 11, 30), P.aisha, { type: "EXPENSE_ADDED", expense: busOut }),
    ev(at(7, 16, 10), P.rohit, { type: "EXPENSE_ADDED", expense: homestay }),
    ev(at(7, 16, 25), P.rohit, { type: "EXPENSE_ADDED", expense: upgrade }),
    ev(at(4, 9, 40), P.amit, { type: "EXPENSE_ADDED", expense: paragliding }),
    ev(at(4, 12, 5), P.neha, { type: "EXPENSE_ADDED", expense: cabs }),
    ev(at(4, 21, 15), P.karan, { type: "EXPENSE_ADDED", expense: dinner }),
    ev(at(3, 8, 50), P.amit, { type: "EXPENSE_ADDED", expense: raftingWithPriya }),
    ev(at(3, 9, 14), P.priya, { type: "EXPENSE_UPDATED", expenseId: raftingWithPriya.id, before: raftingWithPriya, after: raftingWithoutPriya }),
    ev(at(3, 13, 20), P.priya, { type: "EXPENSE_ADDED", expense: lunch }),
    ev(at(3, 15, 2), P.aisha, { type: "EXPENSE_ADDED", expense: permits }),
    ev(at(3, 17, 45), P.amit, { type: "REFUND_RECORDED", refund: paraglidingRefund }),
    ev(nehaToRohit.initiatedTs, P.neha, { type: "SETTLEMENT_INITIATED", settlement: { ...nehaToRohit, status: "initiated", confirmedTs: undefined } }),
    ev(nehaToRohit.confirmedTs!, P.rohit, { type: "SETTLEMENT_CONFIRMED", settlementId: nehaToRohit.id, confirmedTs: nehaToRohit.confirmedTs! }),
    ev(karanToRohit.initiatedTs, P.karan, { type: "SETTLEMENT_INITIATED", settlement: karanToRohit }),
  ];
}

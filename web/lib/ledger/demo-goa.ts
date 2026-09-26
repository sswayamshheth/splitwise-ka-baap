import type { ExpenseData, ItineraryItem, LedgerEvent, ParticipantData, PaymentMethod, SettlementData, TripMeta } from "./types";

/**
 * The judge demo: six friends, four nights in Goa, two weeks from today.
 * Built as an event log so the audit trail is real history, and designed so
 * every booking responds differently when the trip changes:
 *
 *  - Flights       per-head · 60% refundable until a week before · 5 flyers (Meera takes the train)
 *  - Villa         fixed price · 100% → 50% → 0% tiers · someone leaving moves cost onto the rest
 *  - Scuba         per-head · only 3 people · fully refundable until 5 days before
 *  - Insurance     exact per-person premiums · non-refundable
 *  - Jeep safari   already cancelled under its policy · 75% came back to the payer
 *  - Airport pickup fixed price · deliberately split 5 ways while the plan says 6 (an anomaly to catch)
 *  - Beach gear    bought already · consumed, so nobody's leaving changes it
 *
 * Every amount is in paise. Dates are relative to "now" so the policy tiers
 * always sit in the same place relative to the demo day.
 */
export const GOA_TRIP_ID = "trip_demo_goa";

export const GOA = {
  aarav: "p_aarav",
  rohan: "p_rohan",
  siya: "p_siya",
  kavya: "p_kavya",
  dev: "p_dev",
  meera: "p_meera",
} as const;

export const GOA_VIEWER_ID = GOA.aarav;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<LedgerEvent, "id" | "ts" | "actor">;

const DAY = 24 * 3_600_000;
/** Trip starts this many days after the demo is loaded. */
export const GOA_START_OFFSET = 14;

const card = (id: string, label: string, bank: string, network: PaymentMethod["network"], last4: string, headroomPaise: number): PaymentMethod => ({
  id,
  kind: "credit-card",
  label,
  bank,
  network,
  last4,
  headroomPaise,
});

export function buildGoaEvents(now = Date.now()): LedgerEvent[] {
  let seq = 0;
  const at = (daysAgo: number, hour = 10, minute = 0) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  const ev = (ts: number, actor: string, body: EventBody): LedgerEvent => ({ id: `goa_ev_${String(++seq).padStart(3, "0")}`, ts, actor, ...body }) as LedgerEvent;
  const iso = (daysFromNow: number) => {
    const d = new Date(now + daysFromNow * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const S = GOA_START_OFFSET;
  const P = GOA;

  const trip: TripMeta = {
    id: GOA_TRIP_ID,
    name: "Goa with the gang",
    destination: "Candolim, North Goa",
    startDate: iso(S),
    endDate: iso(S + 4),
    currency: "INR",
    status: "active",
    description: "Six of us, four nights, one villa. Flights, villa and scuba already paid.",
  };

  const people: ParticipantData[] = [
    { id: P.aarav, name: "Aarav Shah", upiId: "aarav.shah@okhdfcbank", phone: "98200 41122", paymentMethods: [card("pm_aarav_regalia", "HDFC Regalia", "HDFC Bank", "Visa", "4417", 2_00_000_00)] },
    { id: P.rohan, name: "Rohan Iyer", upiId: "rohan.iyer@okaxis", phone: "98330 56781", paymentMethods: [card("pm_rohan_atlas", "Axis Atlas", "Axis Bank", "Mastercard", "8821", 1_50_000_00)] },
    { id: P.siya, name: "Siya Kapoor", upiId: "siya.k@ybl", paymentMethods: [card("pm_siya_amazon", "ICICI Amazon Pay", "ICICI Bank", "Visa", "6310", 60_000_00)] },
    { id: P.kavya, name: "Kavya Menon", upiId: "kavyamenon@oksbi", paymentMethods: [card("pm_kavya_sbi", "SBI SimplyCLICK", "SBI", "Visa", "1177", 80_000_00)] },
    { id: P.dev, name: "Dev Malhotra", upiId: "devm@paytm", phone: "99870 12345", paymentMethods: [card("pm_dev_millennia", "HDFC Millennia", "HDFC Bank", "Mastercard", "3390", 90_000_00)] },
    { id: P.meera, name: "Meera Joshi", upiId: "meera.joshi@okicici", paymentMethods: [card("pm_meera_idfc", "IDFC FIRST Select", "IDFC FIRST", "RuPay", "9042", 70_000_00)] },
  ];

  const everyone = Object.values(P) as string[];
  const flyers = everyone.filter((id) => id !== P.meera);
  const divers = [P.aarav, P.siya, P.kavya];
  const safari = [P.rohan, P.kavya, P.dev, P.meera];
  const dinner = [P.aarav, P.rohan, P.siya, P.dev];
  const eq = (ids: string[]) => ids.map((participantId) => ({ participantId, weight: 1 }));

  // ---------------------------------------------------------------- itinerary
  const item = (id: string, title: string, category: ItineraryItem["category"], dayOffset: number, estimatedPaise: number, participantIds: string[], extra: Partial<ItineraryItem> = {}): ItineraryItem => ({
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

  const flightPolicy = { refundPercent: 0, tiers: [{ until: iso(S - 7), refundPercent: 60 }], note: "Airline: 60% back until 7 days before departure" };
  const villaPolicy = { refundPercent: 0, tiers: [{ until: iso(S - 21), refundPercent: 100 }, { until: iso(S - 7), refundPercent: 50 }], note: "Villa host: free cancellation to 3 weeks out, then 50% until a week out" };
  const scubaPolicy = { refundPercent: 25, tiers: [{ until: iso(S - 5), refundPercent: 100 }], note: "Dive centre: full refund until 5 days before, 25% after" };
  const safariPolicy = { refundPercent: 0, tiers: [{ until: iso(S - 7), refundPercent: 75 }], note: "Operator: 75% back until a week before" };
  const insurancePolicy = { refundPercent: 0, note: "Premiums are non-refundable once issued" };

  const itinerary: ItineraryItem[] = [
    item("it_flight_out", "IndiGo 6E-5312 · Mumbai → Goa", "Transport", S, 24_000_00, flyers, { vendor: "IndiGo", time: "07:10", location: "Mumbai T1", cancellationPolicy: flightPolicy, notes: "Meera comes down on the Konkan Kanya the night before." }),
    item("it_pickup", "Airport pickup · Innova", "Local travel", S, 3_000_00, everyone, { vendor: "Goa Cabs Co.", time: "09:00", location: "Mopa airport" }),
    item("it_villa", "Villa Azul · 4 nights", "Stay", S, 54_000_00, everyone, { vendor: "Villa Azul Candolim", endDate: iso(S + 4), location: "Candolim", cancellationPolicy: villaPolicy, notes: "3 bedrooms + pool. One price for the whole villa." }),
    item("it_scuba", "Scuba at Grande Island", "Activity", S + 1, 10_500_00, divers, { vendor: "Goa Dive Centre", time: "08:00", cancellationPolicy: scubaPolicy }),
    item("it_dinner", "Dinner at Thalassa", "Food", S + 1, 8_000_00, dinner, { vendor: "Thalassa", time: "20:30", notes: "Table for four — the others have a gig." }),
    item("it_safari", "Dudhsagar jeep safari", "Activity", S + 2, 7_200_00, safari, { vendor: "Dudhsagar Jeep Tours", cancellationPolicy: safariPolicy }),
    item("it_shacks", "Beach shack meals", "Food", S + 2, 12_000_00, everyone, { notes: "Rough budget, pay as we go." }),
    item("it_scooters", "Scooter rentals · 3 days", "Local travel", S + 1, 4_800_00, [P.rohan, P.dev, P.meera], { vendor: "Candolim Rentals" }),
  ];

  // ---------------------------------------------------------------- expenses (paid in advance)
  const expense = (id: string, title: string, category: ExpenseData["category"], dayOffset: number, amountPaise: number, payers: ExpenseData["payers"], participants: ExpenseData["participants"], extra: Partial<ExpenseData> = {}): ExpenseData => ({
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

  const flights = expense("x_flights", "IndiGo 6E-5312 · Mumbai → Goa", "Transport", -20, 24_000_00, [{ participantId: P.aarav, amountPaise: 24_000_00 }], eq(flyers), {
    vendor: "IndiGo",
    itineraryItemId: "it_flight_out",
    pricing: "per-head",
    cancellationPolicy: flightPolicy,
    paymentMethodId: "pm_aarav_regalia",
    capture: { kind: "deeplink", reference: "PNR K7Q2ZD" },
    notes: "5 seats × ₹4,800.",
  });
  const villa = expense("x_villa", "Villa Azul · 4 nights", "Stay", -18, 54_000_00, [{ participantId: P.rohan, amountPaise: 54_000_00 }], eq(everyone), {
    vendor: "Villa Azul Candolim",
    itineraryItemId: "it_villa",
    pricing: "fixed",
    cancellationPolicy: villaPolicy,
    paymentMethodId: "pm_rohan_atlas",
    capture: { kind: "manual", reference: "Booking VA-20931" },
  });
  const scuba = expense("x_scuba", "Scuba at Grande Island", "Activity", -10, 10_500_00, [{ participantId: P.siya, amountPaise: 10_500_00 }], eq(divers), {
    vendor: "Goa Dive Centre",
    itineraryItemId: "it_scuba",
    pricing: "per-head",
    cancellationPolicy: scubaPolicy,
    paymentMethodId: "pm_siya_amazon",
    notes: "3 divers × ₹3,500.",
  });
  const insurance = expense(
    "x_insurance",
    "Travel insurance",
    "Other",
    S,
    3_300_00,
    [{ participantId: P.dev, amountPaise: 3_300_00 }],
    [
      { participantId: P.aarav, weight: 450_00 },
      { participantId: P.rohan, weight: 450_00 },
      { participantId: P.siya, weight: 600_00 },
      { participantId: P.kavya, weight: 450_00 },
      { participantId: P.dev, weight: 900_00 },
      { participantId: P.meera, weight: 450_00 },
    ],
    { vendor: "Tata AIG", splitMode: "exact", pricing: "per-head", cancellationPolicy: insurancePolicy, notes: "Bought 9 days ago; cover starts on the travel date. Premiums differ by age and add-ons — exact amounts per person." },
  );
  const safariX = expense("x_safari", "Dudhsagar jeep safari", "Activity", -12, 7_200_00, [{ participantId: P.dev, amountPaise: 7_200_00 }], eq(safari), {
    vendor: "Dudhsagar Jeep Tours",
    itineraryItemId: "it_safari",
    pricing: "per-head",
    cancellationPolicy: safariPolicy,
    paymentMethodId: "pm_dev_millennia",
  });
  const pickup = expense("x_pickup", "Airport pickup · Innova", "Local travel", -6, 3_000_00, [{ participantId: P.kavya, amountPaise: 3_000_00 }], eq(everyone.filter((id) => id !== P.meera)), {
    vendor: "Goa Cabs Co.",
    itineraryItemId: "it_pickup",
    pricing: "fixed",
    notes: "Split among the five who fly in.",
  });
  const gear = expense("x_gear", "Beach gear · sunscreen, snorkels", "Shopping", -3, 2_400_00, [{ participantId: P.kavya, amountPaise: 2_400_00 }], eq(everyone), {
    vendor: "Decathlon Andheri",
    pricing: "fixed",
    capture: { kind: "receipt", reference: "Bill 88213" },
  });

  const meeraToRohan: SettlementData = {
    id: "st_meera_rohan",
    from: P.meera,
    to: P.rohan,
    amountPaise: 9_000_00,
    method: "upi",
    reference: "UPI 6120…448",
    initiatedTs: at(5, 20, 10),
    confirmedTs: at(5, 20, 31),
    status: "confirmed",
  };
  const kavyaToRohan: SettlementData = {
    id: "st_kavya_rohan",
    from: P.kavya,
    to: P.rohan,
    amountPaise: 4_000_00,
    method: "upi",
    reference: "UPI 7731…092",
    initiatedTs: at(0, 9, 5),
    status: "initiated",
  };

  return [
    ev(at(24, 21, 5), P.aarav, { type: "TRIP_CREATED", trip }),
    ...people.map((participant, i) => ev(at(24, 21, 6 + i), P.aarav, { type: "PARTICIPANT_ADDED", participant })),
    ev(at(23, 18, 0), P.aarav, { type: "ITINERARY_IMPORTED", items: itinerary, sourceName: "Goa-plan.pdf" }),
    ev(at(20, 11, 30), P.aarav, { type: "EXPENSE_ADDED", expense: flights }),
    ev(at(18, 16, 10), P.rohan, { type: "EXPENSE_ADDED", expense: villa }),
    ev(at(12, 13, 40), P.dev, { type: "EXPENSE_ADDED", expense: safariX }),
    ev(at(10, 9, 40), P.siya, { type: "EXPENSE_ADDED", expense: scuba }),
    ev(at(9, 12, 5), P.dev, { type: "EXPENSE_ADDED", expense: insurance }),
    ev(at(6, 19, 15), P.kavya, { type: "EXPENSE_ADDED", expense: pickup }),
    ev(at(5, 20, 10), P.meera, { type: "SETTLEMENT_INITIATED", settlement: { ...meeraToRohan, status: "initiated", confirmedTs: undefined } }),
    ev(at(5, 20, 31), P.rohan, { type: "SETTLEMENT_CONFIRMED", settlementId: meeraToRohan.id, confirmedTs: meeraToRohan.confirmedTs! }),
    ev(at(3, 18, 45), P.kavya, { type: "EXPENSE_ADDED", expense: gear }),
    ev(at(2, 10, 20), P.dev, {
      type: "EXPENSE_CANCELLED",
      expenseId: safariX.id,
      refund: { id: "rf_safari", expenseId: safariX.id, amountPaise: 5_400_00, receivedBy: P.dev, date: iso(-2), reason: "Falls closed after heavy rain · 75% refundable", source: "cancellation" },
      recoverablePaise: 5_400_00,
      lossPaise: 1_800_00,
      refundPercent: 75,
    }),
    ev(kavyaToRohan.initiatedTs, P.kavya, { type: "SETTLEMENT_INITIATED", settlement: kavyaToRohan }),
  ];
}

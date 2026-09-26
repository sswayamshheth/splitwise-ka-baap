import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { parseOfferText, pageOfferSaving, type PageOffer } from "@/lib/ext-offers";
import { bestOfferForMethod } from "@/lib/ledger/offers";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { ExpenseCategory, TripState } from "@/lib/ledger/types";
import { repo } from "./repo";
import { HttpError, loadTripForUser } from "./trips";

/**
 * GroupTrip browser extension (desktop proof of concept).
 * Auth: the user pairs the extension once from Profile; we store only the
 * SHA-256 of the token and resolve it on each call ("Authorization: Bearer …").
 * The extension reads the merchant's checkout page (total + the bank offers
 * the page itself lists) and asks which card in the group saves the most.
 */

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function issueExtensionToken(userId: string) {
  const token = `gtx_${randomBytes(24).toString("base64url")}`;
  await (await repo()).saveExtensionToken(hash(token), userId);
  return token;
}

export async function requireExtensionUser(req: Request): Promise<string> {
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(gtx_[A-Za-z0-9_-]{20,})$/.exec(header)?.[1];
  if (!token) throw new HttpError(401, "Pair the extension first (GroupTrip → Profile → Connect browser extension)");
  const userId = await (await repo()).userForExtensionToken(hash(token));
  if (!userId) throw new HttpError(401, "This extension token isn't valid any more — pair again from Profile");
  return userId;
}

export function siteName(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const known: [RegExp, string][] = [
    [/makemytrip/, "MakeMyTrip"],
    [/goibibo/, "Goibibo"],
    [/cleartrip/, "Cleartrip"],
    [/easemytrip/, "EaseMyTrip"],
    [/yatra/, "Yatra"],
    [/goindigo|indigo/, "IndiGo"],
    [/airindia/, "Air India"],
    [/akasaair/, "Akasa Air"],
    [/spicejet/, "SpiceJet"],
    [/booking\.com/, "Booking.com"],
    [/agoda/, "Agoda"],
    [/airbnb/, "Airbnb"],
    [/irctc/, "IRCTC"],
    [/redbus/, "redBus"],
    [/ixigo/, "ixigo"],
    [/oyo/, "OYO"],
    [/skyscanner/, "Skyscanner"],
  ];
  return known.find(([re]) => re.test(h))?.[1] ?? h.split(".").slice(-2, -1)[0]?.replace(/^\w/, (c) => c.toUpperCase()) ?? host;
}

export function guessCategory(host: string, title = ""): ExpenseCategory {
  const s = `${host} ${title}`.toLowerCase();
  if (/hotel|stay|resort|villa|homestay|booking\.com|agoda|airbnb|oyo/.test(s)) return "Stay";
  if (/flight|air|indigo|spicejet|akasa|irctc|train|bus|redbus/.test(s)) return "Transport";
  if (/cab|taxi|uber|ola|rental|zoomcar/.test(s)) return "Local travel";
  if (/activity|tour|experience|klook|thrillophilia/.test(s)) return "Activity";
  if (/zomato|swiggy|restaurant|food/.test(s)) return "Food";
  return "Other";
}

export type SuggestOption = {
  memberId: string;
  memberName: string;
  isMe: boolean;
  card: string;
  bank: string;
  savingPaise: number;
  source: "page" | "curated" | "none";
  offer: string | null;
  code: string | null;
};

/** Best card in the group for this checkout, from the page's own offers and our curated list. */
export async function suggestForCheckout(
  userId: string,
  input: { tripId?: unknown; host?: unknown; title?: unknown; amountPaise?: unknown; offerTexts?: unknown; participantIds?: unknown },
) {
  if (typeof input.tripId !== "string") throw new HttpError(400, "Pick a trip");
  const amount = typeof input.amountPaise === "number" && Number.isInteger(input.amountPaise) && input.amountPaise > 0 ? input.amountPaise : 0;
  if (!amount) throw new HttpError(400, "No amount found on this page — type the total in the extension");
  const host = typeof input.host === "string" ? input.host.slice(0, 120) : "";
  const title = typeof input.title === "string" ? input.title.slice(0, 200) : "";
  const { member, events } = await loadTripForUser(input.tripId, userId);
  const state = reduceEvents(events) as TripState;
  const merchant = siteName(host);
  const category = guessCategory(host, title);

  const texts = Array.isArray(input.offerTexts) ? input.offerTexts.filter((t): t is string => typeof t === "string").slice(0, 60) : [];
  const pageOffers = texts.map(parseOfferText).filter((o): o is PageOffer => !!o);

  const options: SuggestOption[] = [];
  let membersWithoutCards = 0;
  // Only the people this payment is for can be asked to pay for it.
  const chosen = Array.isArray(input.participantIds) ? new Set(input.participantIds.filter((x): x is string => typeof x === "string")) : null;
  for (const p of state.participants.filter((x) => !x.leftOn && (!chosen || chosen.size === 0 || chosen.has(x.id)))) {
    const cards = (p.paymentMethods ?? []).filter((m) => m.kind !== "netbanking");
    if (!cards.length) membersWithoutCards++;
    for (const m of cards) {
      let best: SuggestOption = { memberId: p.id, memberName: p.name, isMe: p.id === member.participantId, card: m.label, bank: m.bank, savingPaise: 0, source: "none", offer: null, code: null };
      for (const o of pageOffers) {
        const s = pageOfferSaving(o, { bank: m.bank, network: m.network, kind: m.kind }, amount);
        if (s > best.savingPaise) best = { ...best, savingPaise: s, source: "page", offer: o.text, code: o.code ?? null };
      }
      const curated = bestOfferForMethod(m, { amountPaise: amount, category, vendor: merchant });
      if (curated.discountPaise > best.savingPaise) {
        best = { ...best, savingPaise: curated.discountPaise, source: "curated", offer: curated.offer ? `${curated.offer.title} — ${curated.offer.terms}` : null, code: null };
      }
      options.push(best);
    }
  }
  options.sort((a, b) => b.savingPaise - a.savingPaise || Number(b.isMe) - Number(a.isMe));
  const mine = options.filter((o) => o.isMe);
  return {
    trip: { id: state.trip.id, name: state.trip.name },
    merchant,
    category,
    amountPaise: amount,
    pageOffersFound: pageOffers.length,
    pageOffers: pageOffers.slice(0, 8),
    best: options[0] && options[0].savingPaise > 0 ? options[0] : null,
    myBest: mine[0] ?? null,
    options: options.slice(0, 12),
    membersWithoutCards,
  };
}

/** Records a booking made on a merchant site as an expense in the trip (paid by me, shared by everyone active). */
export async function captureBooking(
  userId: string,
  input: { tripId?: unknown; host?: unknown; title?: unknown; amountPaise?: unknown; reference?: unknown; cardLabel?: unknown; category?: unknown; participantIds?: unknown; payerId?: unknown },
) {
  const { addExpense, CommandError } = await import("@/lib/ledger/commands");
  const { syncTripRow, validateAppend } = await import("./trips");
  if (typeof input.tripId !== "string") throw new HttpError(400, "Pick a trip");
  const amount = typeof input.amountPaise === "number" && Number.isInteger(input.amountPaise) && input.amountPaise > 0 ? input.amountPaise : 0;
  if (!amount) throw new HttpError(400, "Enter the amount you paid");
  const host = typeof input.host === "string" ? input.host : "";
  const merchant = siteName(host);
  const r = await repo();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { member, events } = await loadTripForUser(input.tripId, userId);
    const state = reduceEvents(events) as TripState;
    const active = state.participants.filter((p) => !p.leftOn);
    const chosenIds = Array.isArray(input.participantIds) ? input.participantIds.filter((x): x is string => typeof x === "string" && active.some((p) => p.id === x)) : [];
    const sharers = chosenIds.length ? chosenIds : active.map((p) => p.id);
    const payerId = typeof input.payerId === "string" && active.some((p) => p.id === input.payerId) ? input.payerId : member.participantId;
    const payer = state.participants.find((p) => p.id === payerId);
    const method = payer?.paymentMethods?.find((m) => typeof input.cardLabel === "string" && m.label.toLowerCase() === input.cardLabel.toLowerCase());
    const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : `${merchant} booking`).slice(0, 80);
    let event;
    try {
      event = addExpense(
        state,
        {
          title,
          vendor: merchant,
          amountPaise: amount,
          date: new Date().toISOString().slice(0, 10),
          category: typeof input.category === "string" ? (input.category as ExpenseCategory) : guessCategory(host, title),
          payers: [{ participantId: payerId, amountPaise: amount }],
          participants: sharers.map((participantId) => ({ participantId, weight: 1 })),
          splitMode: "equal",
          paymentMethodId: method?.id,
          capture: { kind: "deeplink", reference: `${merchant}${typeof input.reference === "string" && input.reference.trim() ? ` · ${input.reference.trim().slice(0, 40)}` : ""} · via browser extension` },
          notes: "Captured by the GroupTrip browser extension from the merchant's page.",
        },
        { actor: member.participantId },
      );
    } catch (e) {
      throw new HttpError(400, e instanceof CommandError ? e.message : "Couldn't record the booking");
    }
    const { events: stamped, state: next } = validateAppend(events, [event], member);
    const res = await r.appendEvents(input.tripId, events.length, stamped);
    if (res.ok) {
      await syncTripRow(input.tripId, next);
      return { ok: true, expenseId: event.type === "EXPENSE_ADDED" ? event.expense.id : null, merchant, amountPaise: amount, tripName: state.trip.name, sharedBy: sharers.length, paidBy: payer?.name ?? "" };
    }
  }
  throw new HttpError(409, "The trip is busy — try again");
}

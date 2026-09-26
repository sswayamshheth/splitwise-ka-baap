import type { Paise } from "@/lib/money";

/**
 * Reads bank/card offers from text the GroupTrip browser extension found on a
 * merchant's checkout page ("12% instant discount on HDFC credit cards, up to
 * ₹5,000, min ₹10,000"). The page is the source of truth for that merchant's
 * current offers; we only parse what it shows. Parsing is best-effort and the
 * UI says so.
 */

export type PageOffer = {
  text: string;
  bank?: string;
  network?: "Visa" | "Mastercard" | "RuPay" | "Amex";
  cardKind?: "credit-card" | "debit-card";
  percent?: number;
  flatPaise?: Paise;
  capPaise?: Paise;
  minPaise?: Paise;
  code?: string;
};

const BANKS: [RegExp, string][] = [
  [/\bhdfc\b/i, "HDFC Bank"],
  [/\bicici\b/i, "ICICI Bank"],
  [/\baxis\b/i, "Axis Bank"],
  [/\bsbi\b|state bank/i, "SBI"],
  [/\bkotak\b/i, "Kotak"],
  [/\bidfc\b/i, "IDFC FIRST"],
  [/\bamex\b|american express/i, "American Express"],
  [/\byes bank\b/i, "YES Bank"],
  [/\bindusind\b/i, "IndusInd Bank"],
  [/\bau (small finance )?bank\b/i, "AU Small Finance Bank"],
  [/\bbob\b|bank of baroda/i, "Bank of Baroda"],
  [/\bonecard\b/i, "OneCard"],
  [/\brbl\b/i, "RBL Bank"],
  [/\bfederal\b/i, "Federal Bank"],
];

const rupees = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

export function parseOfferText(raw: string): PageOffer | null {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!/(off|discount|cashback|save)/i.test(text)) return null;
  const bank = BANKS.find(([re]) => re.test(text))?.[1];
  const network = /\bvisa\b/i.test(text) ? "Visa" : /master ?card/i.test(text) ? "Mastercard" : /rupay/i.test(text) ? "RuPay" : /\bamex\b/i.test(text) ? "Amex" : undefined;
  if (!bank && !network) return null; // not a card offer (e.g. a coupon for everyone)
  const cardKind = /debit/i.test(text) && !/credit/i.test(text) ? "debit-card" : /credit/i.test(text) && !/debit/i.test(text) ? "credit-card" : undefined;
  const pct = /(\d{1,2}(?:\.\d)?)\s?%/.exec(text);
  const flat = /(?:flat|instant|get)?\s*(?:₹|rs\.?|inr)\s?([\d,]+)\s*(?:instant\s*)?(?:off|discount|cashback)/i.exec(text);
  const cap = /(?:up ?to|upto|max(?:imum)?(?: discount)?(?: of)?)\s*(?:₹|rs\.?|inr)\s?([\d,]+)/i.exec(text);
  const min = /(?:min(?:imum)?\.?\s*(?:txn|transaction|booking|order|spend|purchase)?\s*(?:value|amount)?(?:\s*of)?)\s*(?:₹|rs\.?|inr)\s?([\d,]+)/i.exec(text);
  const code = /\b(?:code|coupon)[:\s]+([A-Z0-9]{4,16})\b/.exec(text);
  const out: PageOffer = { text, bank, network, cardKind };
  if (pct) out.percent = Number(pct[1]);
  else if (flat) out.flatPaise = rupees(flat[1]);
  if (!out.percent && !out.flatPaise) return null;
  if (cap) out.capPaise = rupees(cap[1]);
  if (min) out.minPaise = rupees(min[1]);
  if (code) out.code = code[1];
  return out;
}

/** Saving a card gets from one page offer at this amount (0 if it doesn't qualify). */
export function pageOfferSaving(
  offer: PageOffer,
  card: { bank: string; network?: string; kind: string },
  amountPaise: Paise,
): Paise {
  if (offer.bank && offer.bank.toLowerCase() !== card.bank.toLowerCase()) return 0;
  if (!offer.bank && offer.network && offer.network !== card.network) return 0;
  if (offer.cardKind && offer.cardKind !== card.kind) return 0;
  if (offer.minPaise && amountPaise < offer.minPaise) return 0;
  let saving = offer.percent ? Math.floor((amountPaise * offer.percent) / 100) : (offer.flatPaise ?? 0);
  if (offer.capPaise) saving = Math.min(saving, offer.capPaise);
  return Math.max(0, Math.min(saving, amountPaise));
}

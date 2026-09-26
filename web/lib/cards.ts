import { KNOWN_CARDS } from "@/lib/ledger/offers";

/**
 * Cards and accounts are stored by NAME only ("HDFC Regalia Visa") — never a
 * number. From the name we infer the bank and network, which is all the card
 * optimiser needs to match offers.
 */

export type CardKind = "credit-card" | "debit-card" | "netbanking" | "upi";
export type Network = "Visa" | "Mastercard" | "RuPay" | "Amex";

const BANKS: [RegExp, string][] = [
  [/\bhdfc\b/i, "HDFC Bank"],
  [/\bicici\b/i, "ICICI Bank"],
  [/\baxis\b/i, "Axis Bank"],
  [/\bsbi\b|state bank/i, "SBI"],
  [/\bkotak\b/i, "Kotak"],
  [/\bidfc\b/i, "IDFC FIRST"],
  [/\bamex\b|american express/i, "American Express"],
  [/\byes\b/i, "YES Bank"],
  [/\bindusind\b/i, "IndusInd Bank"],
  [/\bau\b/i, "AU Small Finance Bank"],
  [/\bbob\b|bank of baroda/i, "Bank of Baroda"],
  [/\bpnb\b|punjab national/i, "PNB"],
];

export function inferCard(name: string): { label: string; bank: string; network?: Network; kind: CardKind } {
  const clean = name.replace(/\s+/g, " ").trim();
  const known = KNOWN_CARDS.find((k) => clean.toLowerCase().includes(k.label.toLowerCase()));
  const network: Network | undefined = /\bvisa\b/i.test(clean) ? "Visa" : /master ?card/i.test(clean) ? "Mastercard" : /rupay/i.test(clean) ? "RuPay" : /amex|american express/i.test(clean) ? "Amex" : known?.network;
  const kind: CardKind = /\bupi\b|@/i.test(clean) ? "upi" : /debit/i.test(clean) ? "debit-card" : /net ?banking|savings|account/i.test(clean) ? "netbanking" : "credit-card";
  const bank = known?.bank ?? BANKS.find(([re]) => re.test(clean))?.[1] ?? clean.split(" ")[0];
  // Offers match on the card's product name, so use it as the label when we recognise the card.
  return { label: known?.label ?? clean, bank, network, kind };
}

export const CARD_SUGGESTIONS = [...KNOWN_CARDS.map((k) => `${k.label} ${k.network ?? ""}`.trim()), "SBI Debit Card RuPay", "HDFC Savings Account"];

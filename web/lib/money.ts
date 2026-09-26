/**
 * Money is stored and computed in integer paise. Nothing in the ledger ever
 * does arithmetic on rupee floats; strings are parsed into paise at the edge
 * and formatted back at the edge.
 */
export type Paise = number;

export const MAX_AMOUNT_PAISE = 1_000_000_000 * 100; // ₹100 crore — sanity cap for input

export function isPaise(value: unknown): value is Paise {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Parses user input like "1,500.50", "₹ 1500", "12000" into paise.
 * Returns an error string for anything that is not a valid non-negative amount
 * with at most two decimal places.
 */
export function parseAmount(input: string): { paise: Paise; error?: undefined } | { paise?: undefined; error: string } {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (cleaned === "") return { error: "Enter an amount" };
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned)) {
    if (/^-/.test(cleaned)) return { error: "Amount can't be negative" };
    if (/\.\d{3,}/.test(cleaned)) return { error: "Use at most two decimal places" };
    return { error: "Enter a valid amount, e.g. 1500 or 1500.50" };
  }
  const [rupees = "0", fraction = ""] = cleaned.split(".");
  const paise = Number(rupees || "0") * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(paise)) return { error: "Amount is too large" };
  if (paise > MAX_AMOUNT_PAISE) return { error: "Amount is too large" };
  return { paise };
}

/** Formats an integer rupee count with Indian digit grouping (12,34,567). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

export type MoneyFormat = {
  /** "auto" hides .00, "always" shows paise, "never" rounds to rupees for display only. */
  paise?: "auto" | "always" | "never";
  /** Prefix a "+" for positive values (useful for balances). */
  signed?: boolean;
  /** Omit the ₹ symbol. */
  bare?: boolean;
};

export function formatMoney(paise: Paise, opts: MoneyFormat = {}): string {
  const mode = opts.paise ?? "auto";
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  let rupees = Math.floor(abs / 100);
  let fraction = abs % 100;
  if (mode === "never") {
    rupees = Math.round(abs / 100);
    fraction = 0;
  }
  const showFraction = mode === "always" || (mode === "auto" && fraction !== 0);
  const body = `${groupIndian(String(rupees))}${showFraction ? `.${String(fraction).padStart(2, "0")}` : ""}`;
  const symbol = opts.bare ? "" : "₹";
  const sign = negative ? "−" : opts.signed && paise > 0 ? "+" : "";
  return `${sign}${symbol}${body}`;
}

/** Compact form for tight spaces: ₹1.28L, ₹62K. Never used for ledger math. */
export function formatMoneyCompact(paise: Paise): string {
  const abs = Math.abs(paise) / 100;
  const sign = paise < 0 ? "−" : "";
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (abs >= 10_000) return `${sign}₹${(abs / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatMoney(paise);
}

/**
 * Splits `total` paise across `weights` using the largest-remainder method.
 * The returned parts always sum to exactly `total`. Zero or empty weights
 * produce zero parts; if every weight is zero the total is not distributed
 * (callers must handle that case explicitly).
 */
export function allocate(total: Paise, weights: number[]): Paise[] {
  if (!isPaise(total)) throw new Error("allocate: total must be integer paise");
  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (weights.length === 0 || sum <= 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (Math.max(0, w) * abs) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  // Hand leftover paise to the largest fractional parts; ties go to earlier entries for determinism.
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (weights[i] <= 0) continue;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors.map((f) => f * sign);
}

export function splitEqual(total: Paise, count: number): Paise[] {
  return allocate(total, Array.from({ length: Math.max(0, count) }, () => 1));
}

export function sumPaise(values: Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0);
}

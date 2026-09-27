/**
 * Deterministic text scoring for public signals: a fixed sentiment lexicon
 * and weather / travel keyword relevance. Transparent on purpose — every
 * number here can be explained from the words in the text.
 */

const POS = ["good", "great", "amazing", "awesome", "beautiful", "best", "clean", "enjoy", "enjoyed", "excellent", "fantastic", "friendly", "fun", "lovely", "loved", "love", "nice", "perfect", "recommend", "recommended", "safe", "wonderful", "worth", "helpful", "cozy", "calm", "stunning", "delicious", "open", "reopened", "resume", "resumed"];
const NEG = ["bad", "awful", "worst", "dirty", "crowded", "overpriced", "rude", "dangerous", "unsafe", "closed", "cancelled", "canceled", "flood", "flooded", "flooding", "landslide", "stranded", "disrupted", "disruption", "waterlogged", "damage", "damaged", "warning", "alert", "suspended", "shut", "poor", "disappointing", "scam", "delay", "delayed", "accident", "drown", "drowned", "death", "dead", "killed", "injured", "collapse", "collapsed", "evacuated", "rescue"];

export const WEATHER_TERMS = ["rain", "rainfall", "heavy rain", "downpour", "monsoon", "storm", "thunderstorm", "cyclone", "flood", "waterlogging", "landslide", "wind", "gale", "heatwave", "heat wave", "hail", "fog", "imd", "red alert", "orange alert", "yellow alert", "sea", "rough sea", "high tide", "पाऊस", "बारिश", "वादळ"];
const TRAVEL_TERMS = ["tourist", "tourists", "travel", "trip", "beach", "hotel", "flight", "airport", "road", "traffic", "ferry", "boat", "water sports", "scuba", "rafting", "trek", "safari", "falls", "waterfall", "shack", "restaurant", "museum", "closed", "open", "ban", "banned"];

const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** −1 … 1. Zero when the text carries no lexicon words. */
export function sentimentOf(text: string): number {
  const w = words(text);
  let p = 0;
  let n = 0;
  for (let i = 0; i < w.length; i++) {
    const negated = i > 0 && /^(not|no|never|isn|wasn|didn)$/.test(w[i - 1]);
    if (POS.includes(w[i])) negated ? n++ : p++;
    else if (NEG.includes(w[i])) negated ? p++ : n++;
  }
  if (p + n === 0) return 0;
  return Math.round(((p - n) / (p + n)) * 100) / 100;
}

export function weatherTermsIn(text: string): string[] {
  const t = text.toLowerCase();
  return WEATHER_TERMS.filter((k) => t.includes(k));
}

/**
 * How relevant a text is to this trip right now: mentions the place (needed),
 * mentions weather, mentions travel. Recency multiplies it down.
 */
export function relevanceOf(text: string, placeNames: string[], timestamp: number | null, now = Date.now()): number {
  const t = text.toLowerCase();
  const place = placeNames.some((p) => p && t.includes(p.toLowerCase()));
  if (!place) return 0;
  const weather = weatherTermsIn(t).length > 0;
  const travel = TRAVEL_TERMS.some((k) => t.includes(k));
  let r = 0.35 + (weather ? 0.4 : 0) + (travel ? 0.25 : 0);
  if (timestamp !== null) {
    const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
    r *= ageDays <= 2 ? 1 : ageDays <= 7 ? 0.8 : ageDays <= 30 ? 0.5 : 0.25;
  }
  return Math.round(Math.min(1, r) * 100) / 100;
}

/** Strips HTML tags and entities from social post content. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bayesian-averaged rating on 0…1: a 4.8 from 6 reviews is not better than a
 * 4.6 from 2,000. Prior: 4.0 stars weighted as 25 reviews.
 */
export function ratingScore(rating?: number, reviewCount?: number): number | null {
  if (rating === undefined || !Number.isFinite(rating)) return null;
  const v = Math.max(0, reviewCount ?? 0);
  const m = 25;
  const prior = 4.0;
  const adjusted = (rating * v + prior * m) / (v + m);
  return Math.max(0, Math.min(1, (adjusted - 3) / 2));
}

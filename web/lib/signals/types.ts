/**
 * Public / social signals. Every signal is a real item fetched from a public
 * source, and keeps where it came from, when, where it is about, what it says
 * and how much we trust it for this trip. Nothing in this layer is invented:
 * a provider that is not configured or not reachable returns no signals and a
 * status line saying so.
 */

export type SignalSource = "gdelt-news" | "mastodon" | "wikivoyage" | "wikipedia-pageviews" | "google-places" | "openstreetmap";
export type SignalKind = "news" | "social-post" | "travel-guide" | "trend" | "rating" | "review" | "poi";

export type PublicSignal = {
  id: string;
  source: SignalSource;
  kind: SignalKind;
  /** Link to the original item. */
  url?: string;
  /** When the item was published / observed (ms). Null for timeless guide text. */
  timestamp: number | null;
  location: { name: string; lat?: number; lon?: number };
  title?: string;
  summary: string;
  /** Place this signal is about (candidate / itinerary id), when it is about one place. */
  placeRef?: string;
  rating?: number;
  reviewCount?: number;
  /** -1 … 1, from a fixed lexicon (see score.ts). */
  sentiment?: number;
  /** 0 … 1: how relevant to this trip, place and current weather. */
  relevance: number;
  /** 0 … 1: how much weight the source deserves. */
  confidence: number;
  /** Weather words found in the text ("rain", "flood"…). */
  weatherTerms?: string[];
};

export type ProviderStatus = { source: SignalSource; ok: boolean; configured: boolean; count: number; note: string; fetchedAt: number };

export type PlaceRatings = {
  placeRef: string;
  rating?: number;
  reviewCount?: number;
  /** Mean sentiment of the recent reviews returned (-1 … 1). */
  recentSentiment?: number;
  /** Newest review time (ms). */
  latestReviewAt?: number;
  /** Wikipedia page-view trend: last 15 days vs the 15 before (ratio − 1). */
  pageviewTrend?: number;
  pageviews30d?: number;
  signalIds: string[];
};

import "server-only";

import type { LedgerEvent } from "@/lib/ledger/types";

/**
 * Persistence contract. Two implementations: Supabase (when a server secret
 * key is configured) and a local JSON file (development / offline demo). The
 * API routes only ever talk to this interface.
 *
 * A trip is stored as its append-only event log. `seq` is the position in the
 * log and doubles as the optimistic-concurrency token: an append must say
 * which seq it was built on, and loses if someone else appended first.
 */

export type Profile = { userId: string; name: string; email?: string; phone?: string; upiId?: string; createdAt: number };

export type TripRow = {
  id: string;
  ownerId: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: "active" | "closed";
  joinCode: string;
  createdAt: number;
  updatedAt: number;
};

export type MemberRow = { tripId: string; userId: string; participantId: string; role: "owner" | "member"; joinedAt: number };

/** A pool contribution paid through the payment provider (Razorpay test mode). */
export type PaymentStatus = "PENDING" | "VERIFIED" | "FAILED" | "REFUND_PENDING" | "REFUNDED";

export type Contribution = {
  id: string;
  tripId: string;
  participantId: string;
  userId: string;
  amountPaise: number;
  currency: "INR";
  provider: "razorpay";
  orderId?: string;
  /** Unique across all contributions: one provider payment = one contribution. */
  paymentId?: string;
  status: PaymentStatus;
  refundedPaise: number;
  refundId?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
};

export type AppendResult = { ok: true; seq: number } | { ok: false; conflict: true; seq: number };

export interface Repo {
  readonly kind: "supabase" | "file";
  getProfile(userId: string): Promise<Profile | null>;
  upsertProfile(profile: Profile): Promise<Profile>;

  createTrip(trip: TripRow, owner: MemberRow, events: LedgerEvent[]): Promise<void>;
  getTrip(tripId: string): Promise<TripRow | null>;
  updateTrip(tripId: string, patch: Partial<Omit<TripRow, "id" | "ownerId" | "joinCode" | "createdAt">>): Promise<void>;
  findTripByCode(code: string): Promise<TripRow | null>;
  listTripsForUser(userId: string): Promise<{ trip: TripRow; member: MemberRow }[]>;
  deleteTrip(tripId: string): Promise<void>;

  getMember(tripId: string, userId: string): Promise<MemberRow | null>;
  listMembers(tripId: string): Promise<MemberRow[]>;
  addMember(member: MemberRow): Promise<void>;

  /** Events in log order. */
  getEvents(tripId: string): Promise<LedgerEvent[]>;
  /** Appends only if the log is still `baseSeq` long. */
  appendEvents(tripId: string, baseSeq: number, events: LedgerEvent[]): Promise<AppendResult>;

  createContribution(c: Contribution): Promise<void>;
  getContribution(id: string): Promise<Contribution | null>;
  findContributionByOrder(orderId: string): Promise<Contribution | null>;
  findContributionByPayment(paymentId: string): Promise<Contribution | null>;
  listContributions(tripId: string): Promise<Contribution[]>;
  /**
   * Compare-and-set: applies `patch` only if the contribution's status is
   * still one of `from`. Returns the updated record, or null if another
   * request got there first. Throws if `patch.paymentId` is already used by a
   * different contribution.
   */
  transitionContribution(id: string, from: PaymentStatus[], patch: Partial<Omit<Contribution, "id" | "tripId">>): Promise<Contribution | null>;
  /** Records a provider webhook event id; false if it was already processed. */
  claimWebhookEvent(eventId: string, type: string): Promise<boolean>;
}

let cached: Repo | null = null;

/** Tests inject an isolated store here. */
export function setRepoForTests(r: Repo | null) {
  cached = r;
}

export async function repo(): Promise<Repo> {
  if (cached) return cached;
  if (process.env.SUPABASE_SECRET_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const { SupabaseRepo } = await import("./supabase-repo");
    cached = new SupabaseRepo(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  } else {
    const { FileRepo } = await import("./file-repo");
    cached = new FileRepo();
  }
  return cached;
}

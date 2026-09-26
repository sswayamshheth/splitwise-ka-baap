import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { LedgerEvent } from "@/lib/ledger/types";
import type { AppendResult, Contribution, MemberRow, PaymentStatus, Profile, Repo, TripRow } from "./repo";

/**
 * Supabase store (schema: supabase/migrations/0001_grouptrip_ledger.sql).
 * Runs server-side only, with the project's secret key; every route has
 * already authenticated the Clerk user and checked trip membership. User IDs
 * are Clerk IDs (text). Appends rely on the (trip_id, seq) primary key: two
 * writers racing for the same seq cannot both succeed.
 */

type TripDb = {
  id: string;
  owner_id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  status: "active" | "closed";
  join_code: string;
  created_at: string;
  updated_at: string;
};
type MemberDb = { trip_id: string; user_id: string; participant_id: string; role: "owner" | "member"; joined_at: string };

const toTrip = (r: TripDb): TripRow => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  destination: r.destination,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  joinCode: r.join_code,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});
const toMember = (r: MemberDb): MemberRow => ({ tripId: r.trip_id, userId: r.user_id, participantId: r.participant_id, role: r.role, joinedAt: Date.parse(r.joined_at) });
const iso = (ms: number) => new Date(ms).toISOString();

type ContributionDb = {
  id: string;
  trip_id: string;
  participant_id: string;
  user_id: string;
  amount_paise: number;
  currency: "INR";
  provider: "razorpay";
  order_id: string | null;
  payment_id: string | null;
  status: PaymentStatus;
  refunded_paise: number;
  refund_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};
const toContribution = (r: ContributionDb): Contribution => ({
  id: r.id,
  tripId: r.trip_id,
  participantId: r.participant_id,
  userId: r.user_id,
  amountPaise: Number(r.amount_paise),
  currency: r.currency,
  provider: r.provider,
  orderId: r.order_id ?? undefined,
  paymentId: r.payment_id ?? undefined,
  status: r.status,
  refundedPaise: Number(r.refunded_paise),
  refundId: r.refund_id ?? undefined,
  failureReason: r.failure_reason ?? undefined,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});
const contributionPatch = (p: Partial<Contribution>) => {
  const row: Record<string, unknown> = { updated_at: iso(Date.now()) };
  if (p.orderId !== undefined) row.order_id = p.orderId;
  if (p.paymentId !== undefined) row.payment_id = p.paymentId;
  if (p.status !== undefined) row.status = p.status;
  if (p.refundedPaise !== undefined) row.refunded_paise = p.refundedPaise;
  if ("refundId" in p) row.refund_id = p.refundId ?? null;
  if ("failureReason" in p) row.failure_reason = p.failureReason ?? null;
  return row;
};

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data;
}

export class SupabaseRepo implements Repo {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.db = createClient(url.replace(/\/rest\/v1\/?$/, ""), secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async getProfile(userId: string) {
    const r = check(await this.db.from("profiles").select("*").eq("user_id", userId).maybeSingle());
    return r ? { userId: r.user_id, name: r.name, email: r.email ?? undefined, phone: r.phone ?? undefined, upiId: r.upi_id ?? undefined, createdAt: Date.parse(r.created_at) } : null;
  }
  async upsertProfile(p: Profile) {
    check(await this.db.from("profiles").upsert({ user_id: p.userId, name: p.name, email: p.email ?? null, phone: p.phone ?? null, upi_id: p.upiId ?? null }));
    return p;
  }

  async createTrip(trip: TripRow, owner: MemberRow, events: LedgerEvent[]) {
    check(
      await this.db.from("trips").insert({
        id: trip.id,
        owner_id: trip.ownerId,
        name: trip.name,
        destination: trip.destination,
        start_date: trip.startDate,
        end_date: trip.endDate,
        status: trip.status,
        join_code: trip.joinCode,
      }),
    );
    check(await this.db.from("trip_members").insert({ trip_id: owner.tripId, user_id: owner.userId, participant_id: owner.participantId, role: owner.role }));
    if (events.length) check(await this.db.from("trip_events").insert(events.map((e, i) => ({ trip_id: trip.id, seq: i + 1, event: e, actor: e.actor, ts: iso(e.ts) }))));
  }
  async getTrip(tripId: string) {
    const r = check(await this.db.from("trips").select("*").eq("id", tripId).maybeSingle()) as TripDb | null;
    return r ? toTrip(r) : null;
  }
  async updateTrip(tripId: string, patch: Partial<TripRow>) {
    const row: Record<string, unknown> = { updated_at: iso(Date.now()) };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.destination !== undefined) row.destination = patch.destination;
    if (patch.startDate !== undefined) row.start_date = patch.startDate;
    if (patch.endDate !== undefined) row.end_date = patch.endDate;
    if (patch.status !== undefined) row.status = patch.status;
    check(await this.db.from("trips").update(row).eq("id", tripId));
  }
  async findTripByCode(code: string) {
    const r = check(await this.db.from("trips").select("*").eq("join_code", code.toUpperCase()).maybeSingle()) as TripDb | null;
    return r ? toTrip(r) : null;
  }
  async listTripsForUser(userId: string) {
    const rows = check(await this.db.from("trip_members").select("*, trips(*)").eq("user_id", userId)) as (MemberDb & { trips: TripDb | null })[];
    return rows.filter((r) => r.trips).map((r) => ({ trip: toTrip(r.trips!), member: toMember(r) }));
  }
  async deleteTrip(tripId: string) {
    check(await this.db.from("trips").delete().eq("id", tripId));
  }

  async getMember(tripId: string, userId: string) {
    const r = check(await this.db.from("trip_members").select("*").eq("trip_id", tripId).eq("user_id", userId).maybeSingle()) as MemberDb | null;
    return r ? toMember(r) : null;
  }
  async listMembers(tripId: string) {
    return (check(await this.db.from("trip_members").select("*").eq("trip_id", tripId)) as MemberDb[]).map(toMember);
  }
  async addMember(m: MemberRow) {
    check(await this.db.from("trip_members").upsert({ trip_id: m.tripId, user_id: m.userId, participant_id: m.participantId, role: m.role }, { onConflict: "trip_id,user_id", ignoreDuplicates: true }));
  }

  async getEvents(tripId: string) {
    const rows = check(await this.db.from("trip_events").select("event").eq("trip_id", tripId).order("seq", { ascending: true })) as { event: LedgerEvent }[];
    return rows.map((r) => r.event);
  }
  async createContribution(c: Contribution) {
    check(
      await this.db.from("pool_contributions").insert({
        id: c.id,
        trip_id: c.tripId,
        participant_id: c.participantId,
        user_id: c.userId,
        amount_paise: c.amountPaise,
        currency: c.currency,
        provider: c.provider,
        order_id: c.orderId ?? null,
        payment_id: c.paymentId ?? null,
        status: c.status,
        refunded_paise: c.refundedPaise,
      }),
    );
  }
  async getContribution(id: string) {
    const r = check(await this.db.from("pool_contributions").select("*").eq("id", id).maybeSingle()) as ContributionDb | null;
    return r ? toContribution(r) : null;
  }
  async findContributionByOrder(orderId: string) {
    const r = check(await this.db.from("pool_contributions").select("*").eq("order_id", orderId).maybeSingle()) as ContributionDb | null;
    return r ? toContribution(r) : null;
  }
  async findContributionByPayment(paymentId: string) {
    const r = check(await this.db.from("pool_contributions").select("*").eq("payment_id", paymentId).maybeSingle()) as ContributionDb | null;
    return r ? toContribution(r) : null;
  }
  async listContributions(tripId: string) {
    return (check(await this.db.from("pool_contributions").select("*").eq("trip_id", tripId).order("created_at", { ascending: false })) as ContributionDb[]).map(toContribution);
  }
  async transitionContribution(id: string, from: PaymentStatus[], patch: Partial<Contribution>) {
    // The status filter makes this a compare-and-set in one statement.
    const rows = check(await this.db.from("pool_contributions").update(contributionPatch(patch)).eq("id", id).in("status", from).select("*")) as ContributionDb[];
    return rows[0] ? toContribution(rows[0]) : null;
  }
  async claimWebhookEvent(eventId: string, type: string) {
    const res = await this.db.from("payment_webhook_events").insert({ event_id: eventId, type });
    if (res.error) {
      if (res.error.code === "23505") return false;
      throw new Error(`Supabase: ${res.error.message}`);
    }
    return true;
  }

  async appendEvents(tripId: string, baseSeq: number, events: LedgerEvent[]): Promise<AppendResult> {
    const { count } = await this.db.from("trip_events").select("seq", { count: "exact", head: true }).eq("trip_id", tripId);
    const current = count ?? 0;
    if (current !== baseSeq) return { ok: false, conflict: true, seq: current };
    const res = await this.db.from("trip_events").insert(events.map((e, i) => ({ trip_id: tripId, seq: baseSeq + i + 1, event: e, actor: e.actor, ts: iso(e.ts) })));
    if (res.error) {
      // 23505 = unique violation: another writer took this seq first.
      if (res.error.code === "23505") return { ok: false, conflict: true, seq: current };
      throw new Error(`Supabase: ${res.error.message}`);
    }
    return { ok: true, seq: baseSeq + events.length };
  }
}

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import type { LedgerEvent } from "@/lib/ledger/types";
import type { AppendResult, Contribution, MemberRow, PaymentStatus, Profile, Repo, TripRow } from "./repo";

/**
 * Local JSON-file store for development and offline demos. Same contract as
 * the Supabase store. Writes are serialised through one promise chain and
 * written atomically (temp file + rename), so concurrent requests from the
 * dev server can't interleave.
 */

type Db = {
  profiles: Record<string, Profile>;
  trips: Record<string, TripRow>;
  members: MemberRow[];
  events: Record<string, LedgerEvent[]>;
  contributions?: Record<string, Contribution>;
  webhookEvents?: Record<string, { type: string; at: number }>;
  extTokens?: Record<string, { userId: string; at: number }>;
};

const DEFAULT_FILE = path.join(process.cwd(), ".data", "db.json");

export class FileRepo implements Repo {
  readonly kind = "file" as const;
  private chain: Promise<unknown> = Promise.resolve();
  private db: Db | null = null;

  constructor(private readonly file = DEFAULT_FILE) {
    // Hosted file systems are ephemeral or read-only: fail loudly instead of losing data.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SUPABASE_SECRET_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set in production. The local file store is for development only.",
      );
    }
  }

  private async load(): Promise<Db> {
    if (this.db) return this.db;
    try {
      this.db = JSON.parse(await fs.readFile(this.file, "utf8")) as Db;
    } catch {
      this.db = { profiles: {}, trips: {}, members: [], events: {} };
    }
    return this.db;
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.db));
    await fs.rename(tmp, this.file);
  }

  /** Runs a mutation exclusively and persists it. */
  private write<T>(fn: (db: Db) => T): Promise<T> {
    const next = this.chain.then(async () => {
      const db = await this.load();
      const out = fn(db);
      await this.save();
      return out;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async getProfile(userId: string) {
    return (await this.load()).profiles[userId] ?? null;
  }
  upsertProfile(profile: Profile) {
    return this.write((db) => (db.profiles[profile.userId] = { ...db.profiles[profile.userId], ...profile }));
  }

  createTrip(trip: TripRow, owner: MemberRow, events: LedgerEvent[]) {
    return this.write((db) => {
      if (db.trips[trip.id]) throw new Error("Trip already exists");
      db.trips[trip.id] = trip;
      db.members.push(owner);
      db.events[trip.id] = [...events];
    });
  }
  async getTrip(tripId: string) {
    return (await this.load()).trips[tripId] ?? null;
  }
  updateTrip(tripId: string, patch: Partial<TripRow>) {
    return this.write((db) => {
      if (db.trips[tripId]) db.trips[tripId] = { ...db.trips[tripId], ...patch };
    });
  }
  async findTripByCode(code: string) {
    const db = await this.load();
    return Object.values(db.trips).find((t) => t.joinCode.toUpperCase() === code.toUpperCase()) ?? null;
  }
  async listTripsForUser(userId: string) {
    const db = await this.load();
    return db.members.filter((m) => m.userId === userId && db.trips[m.tripId]).map((member) => ({ trip: db.trips[member.tripId], member }));
  }
  deleteTrip(tripId: string) {
    return this.write((db) => {
      delete db.trips[tripId];
      delete db.events[tripId];
      db.members = db.members.filter((m) => m.tripId !== tripId);
    });
  }

  async getMember(tripId: string, userId: string) {
    return (await this.load()).members.find((m) => m.tripId === tripId && m.userId === userId) ?? null;
  }
  async listMembers(tripId: string) {
    return (await this.load()).members.filter((m) => m.tripId === tripId);
  }
  addMember(member: MemberRow) {
    return this.write((db) => {
      if (!db.members.some((m) => m.tripId === member.tripId && m.userId === member.userId)) db.members.push(member);
    });
  }

  async getEvents(tripId: string) {
    return [...((await this.load()).events[tripId] ?? [])];
  }
  createContribution(c: Contribution) {
    return this.write((db) => {
      const all = (db.contributions ??= {});
      if (all[c.id]) throw new Error("Contribution already exists");
      if (c.orderId && Object.values(all).some((x) => x.orderId === c.orderId)) throw new Error("Order already linked");
      all[c.id] = { ...c };
    });
  }
  async getContribution(id: string) {
    const c = (await this.load()).contributions?.[id];
    return c ? { ...c } : null;
  }
  async findContributionByOrder(orderId: string) {
    const c = Object.values((await this.load()).contributions ?? {}).find((x) => x.orderId === orderId);
    return c ? { ...c } : null;
  }
  async findContributionByPayment(paymentId: string) {
    const c = Object.values((await this.load()).contributions ?? {}).find((x) => x.paymentId === paymentId);
    return c ? { ...c } : null;
  }
  async listContributions(tripId: string) {
    return Object.values((await this.load()).contributions ?? {})
      .filter((c) => c.tripId === tripId)
      .map((c) => ({ ...c }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  transitionContribution(id: string, from: PaymentStatus[], patch: Partial<Contribution>) {
    return this.write((db) => {
      const all = (db.contributions ??= {});
      const current = all[id];
      if (!current || !from.includes(current.status)) return null;
      if (patch.paymentId && Object.values(all).some((x) => x.id !== id && x.paymentId === patch.paymentId)) {
        throw new Error("Payment already linked to another contribution");
      }
      all[id] = { ...current, ...patch, updatedAt: Date.now() };
      return { ...all[id] };
    });
  }
  claimWebhookEvent(eventId: string, type: string) {
    return this.write((db) => {
      const seen = (db.webhookEvents ??= {});
      if (seen[eventId]) return false;
      seen[eventId] = { type, at: Date.now() };
      return true;
    });
  }

  saveExtensionToken(tokenHash: string, userId: string) {
    return this.write((db) => {
      (db.extTokens ??= {})[tokenHash] = { userId, at: Date.now() };
    });
  }
  async userForExtensionToken(tokenHash: string) {
    return (await this.load()).extTokens?.[tokenHash]?.userId ?? null;
  }

  appendEvents(tripId: string, baseSeq: number, events: LedgerEvent[]): Promise<AppendResult> {
    return this.write((db) => {
      const log = (db.events[tripId] ??= []);
      if (log.length !== baseSeq) return { ok: false as const, conflict: true as const, seq: log.length };
      log.push(...events);
      return { ok: true as const, seq: log.length };
    });
  }
}

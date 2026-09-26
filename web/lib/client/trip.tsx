"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { CommandError } from "@/lib/ledger/commands";
import { computeLedger, type Ledger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent, ParticipantData, ParticipantId, TripState } from "@/lib/ledger/types";
import { api, ApiError } from "./api";

/**
 * One trip on the client. The server sends the event log; everything shown
 * (balances, shares, settlement, explanations) is derived from it here with
 * the same engine the server validates with. Changes are built with the
 * ledger commands against the current state and appended with the log length
 * they were built on; if someone else wrote first, we reload and rebuild the
 * change on the fresh state once.
 */

type TripPayload = { trip: { id: string; joinCode: string; ownerId: string }; me: { participantId: string; role: "owner" | "member" }; claimed: string[]; seq: number; events: LedgerEvent[] };

export type Ctx = { actor: ParticipantId; now?: number };
export type Build = (state: TripState, ctx: Ctx) => LedgerEvent | LedgerEvent[];

export type TripCtx = {
  tripId: string;
  joinCode: string;
  role: "owner" | "member";
  meId: ParticipantId;
  events: LedgerEvent[];
  state: TripState;
  ledger: Ledger;
  claimed: Set<string>;
  /** "You" for me, first name for others. */
  short: (id: ParticipantId | "system") => string;
  fullName: (id: ParticipantId) => string;
  participant: (id: ParticipantId) => ParticipantData | undefined;
  isMe: (id: ParticipantId) => boolean;
  /** Build events from the current state and append them. Throws CommandError / ApiError with a readable message. */
  run: (build: Build) => Promise<LedgerEvent[]>;
  /** Reload the trip from the server. */
  refresh: () => Promise<void>;
};

const TripContext = createContext<TripCtx | null>(null);

export function TripProvider({ tripId, children, fallback }: { tripId: string; children: ReactNode; fallback: (s: { loading: boolean; error?: string }) => ReactNode }) {
  const [data, setData] = useState<TripPayload | null>(null);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setData(await api<TripPayload>(`/api/trips/${tripId}`));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this trip");
    }
  }, [tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  const derived = useMemo(() => {
    if (!data) return null;
    const state = reduceEvents(data.events);
    if (!state) return null;
    return { state, ledger: computeLedger(state) };
  }, [data]);

  const run = useCallback(
    async (build: Build) => {
      if (!data || !derived) throw new CommandError("Trip is still loading");
      const attempt = async (payload: TripPayload, state: TripState) => {
        const built = build(state, { actor: payload.me.participantId });
        const events = Array.isArray(built) ? built : [built];
        const res = await api<{ seq: number; events: LedgerEvent[] }>(`/api/trips/${tripId}/events`, { body: { baseSeq: payload.seq, events } });
        setData({ ...payload, seq: res.seq, events: [...payload.events, ...res.events] });
        return res.events;
      };
      try {
        return await attempt(data, derived.state);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        // Someone else changed the trip: rebuild this change on the latest log, once.
        const fresh = await api<TripPayload>(`/api/trips/${tripId}`);
        const state = reduceEvents(fresh.events);
        if (!state) throw e;
        setData(fresh);
        return attempt(fresh, state);
      }
    },
    [data, derived, tripId],
  );

  const value = useMemo<TripCtx | null>(() => {
    if (!data || !derived) return null;
    const byId = new Map(derived.state.participants.map((p) => [p.id, p]));
    const meId = data.me.participantId;
    const first = (n: string) => n.split(" ")[0];
    return {
      tripId,
      joinCode: data.trip.joinCode,
      role: data.me.role,
      meId,
      events: data.events,
      state: derived.state,
      ledger: derived.ledger,
      claimed: new Set(data.claimed),
      short: (id) => (id === "system" ? "System" : id === meId ? "You" : first(byId.get(id)?.name ?? "Former member")),
      fullName: (id) => byId.get(id)?.name ?? "Former member",
      participant: (id) => byId.get(id),
      isMe: (id) => id === meId,
      run,
      refresh: load,
    };
  }, [data, derived, tripId, run, load]);

  if (!value) return <>{fallback({ loading: !error, error })}</>;
  return <TripContext.Provider value={value}>{children}</TripContext.Provider>;
}

export function useTrip(): TripCtx {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error("useTrip must be used inside TripProvider");
  return ctx;
}

/** A readable message for anything a command or the API throws. */
export function errorText(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof CommandError || e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

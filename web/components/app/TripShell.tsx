"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import { useChainEnabled } from "@/components/app/trip/ChainBadge";
import { api } from "@/lib/client/api";
import { formatDateRange } from "@/lib/dates";
import { TripProvider, useTrip } from "@/lib/client/trip";
import type { Interests } from "@/lib/interests";
import { addPaymentMethod, isValidUpiId, setParticipantInterests, updateParticipant } from "@/lib/ledger/commands";
import type { LedgerEvent } from "@/lib/ledger/types";
import { Button, cx, Empty, Icon, initials, Page, Spinner, TopBar } from "./kit";

const TABS = [
  { seg: "", label: "Trip", icon: "landscape" },
  { seg: "plan", label: "Plan", icon: "calendar_today" },
  { seg: "money", label: "Money", icon: "account_balance_wallet" },
  { seg: "activity", label: "Activity", icon: "history" },
] as const;

/** A trip: header, the trip's four tabs in the bottom bar, and the trip ledger in context for every screen below. */
export function TripShell({ tripId, children }: { tripId: string; children: ReactNode }) {
  return (
    <TripProvider
      tripId={tripId}
      fallback={({ loading, error }) => (
        <>
          <TopBar title="Trip" back="/home" />
          <Page>
            {loading ? (
              <Spinner label="Loading the trip ledger" />
            ) : (
              <Empty icon="error" title="Couldn't open this trip" message={error} action={<Button href="/home" variant="secondary" small>Back to trips</Button>} />
            )}
          </Page>
        </>
      )}
    >
      <TripChrome>{children}</TripChrome>
    </TripProvider>
  );
}

type Profile = { upiId?: string; interests?: Interests; cards?: { label: string; bank: string; network?: "Visa" | "Mastercard" | "RuPay" | "Amex"; kind: "credit-card" | "debit-card" | "netbanking" | "upi" }[] };

/**
 * Brings my saved preferences and card names into this trip (once per visit),
 * as ordinary ledger events — so the Harmony Score and the card optimiser see
 * them, and the change is in the trip's history.
 */
function useProfileSync() {
  const trip = useTrip();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || trip.state.trip.status === "closed") return;
    done.current = true;
    void api<{ profile: Profile }>("/api/me")
      .then(async ({ profile }) => {
        const mine = trip.participant(trip.meId);
        if (!mine || mine.leftOn) return;
        const wantsInterests = profile.interests && JSON.stringify(profile.interests) !== JSON.stringify(mine.interests ?? null);
        const have = new Set((mine.paymentMethods ?? []).map((m) => m.label.toLowerCase()));
        const newCards = (profile.cards ?? []).filter((c) => !have.has(c.label.toLowerCase()));
        // My UPI ID from Profile is where the group pays me (and the pool, when I'm the organiser).
        const wantsUpi = !!profile.upiId && isValidUpiId(profile.upiId) && profile.upiId.trim() !== (mine.upiId ?? "");
        if (!wantsInterests && newCards.length === 0 && !wantsUpi) return;
        await trip.run((state, ctx) => {
          const out: LedgerEvent[] = [];
          if (wantsInterests) out.push(setParticipantInterests(state, ctx.actor, profile.interests, ctx));
          if (wantsUpi) {
            const me = state.participants.find((p) => p.id === ctx.actor)!;
            out.push(updateParticipant(state, ctx.actor, { name: me.name, upiId: profile.upiId, phone: me.phone }, { ...ctx, now: Date.now() + out.length }));
          }
          for (const c of newCards) {
            out.push(addPaymentMethod(state, ctx.actor, { label: c.label, bank: c.bank, network: c.network, kind: c.kind === "upi" ? "upi" : c.kind === "netbanking" ? "netbanking" : c.kind }, { ...ctx, now: Date.now() + out.length }));
          }
          return out;
        });
      })
      .catch(() => undefined);
  }, [trip]);
}

function TripChrome({ children }: { children: ReactNode }) {
  const trip = useTrip();
  useProfileSync();
  const pathname = usePathname();
  const base = `/trips/${trip.tripId}`;
  const chainEnabled = useChainEnabled();
  const rest = pathname.slice(base.length).replace(/^\//, "");
  const tabbed = TABS.some((t) => t.seg === rest);
  const t = trip.state.trip;
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <TopBar
        eyebrow={`Settlr · ${t.destination.split(",")[0]} · ${formatDateRange(t.startDate, t.endDate)}`}
        title={t.name}
        back={tabbed ? "/home" : base}
        right={
          <div className="flex items-center gap-space-sm">
            {t.status === "closed" ? (
              <span className="rounded-full bg-surface-container px-space-sm py-0.5 font-label-sm text-label-sm text-on-surface-variant">Closed</span>
            ) : chainEnabled ? (
              <Link href={`${base}/chain`} aria-label="Blockchain proof" title="Blockchain proof" className="flex h-10 items-center gap-1 rounded-full bg-primary-container px-3 font-label-md text-label-md text-on-primary hover:opacity-90">
                <Icon name="deployed_code" className="text-[18px]" />
                <span className="hidden sm:inline">Blockchain</span>
              </Link>
            ) : null}
            {t.status === "closed" ? null : (
              <Link href={`${base}/ask`} aria-label="Ask the ledger" className="flex h-10 w-10 items-center justify-center rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant hover:opacity-90">
                <Icon name="auto_awesome" className="text-[20px]" />
              </Link>
            )}
            <span className="flex h-11 w-11 items-center justify-center rounded-full ring-2 ring-primary/20">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container font-label-md text-label-md text-on-primary">{initials(trip.fullName(trip.meId))}</span>
            </span>
          </div>
        }
      />
      <div className="flex flex-1 flex-col pb-20">{children}</div>
      {tabbed ? (
        <nav className="fixed bottom-0 z-50 w-full bg-surface/85 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(16,32,28,0.04)] backdrop-blur-xl">
          <div className="mx-auto flex h-20 max-w-[520px] items-center justify-around px-space-xs">
            {TABS.map((tab) => {
              const active = tab.seg === rest;
              return (
                <Link
                  key={tab.label}
                  href={tab.seg ? `${base}/${tab.seg}` : base}
                  prefetch
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex min-h-[44px] min-w-[56px] flex-col items-center justify-center gap-space-xs transition-colors",
                    active ? "font-semibold text-primary-container" : "text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  <Icon name={tab.icon} filled={active} className="text-[24px]" />
                  <span className="font-label-md text-label-md">{tab.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

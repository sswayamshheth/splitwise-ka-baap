"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { formatDateRange } from "@/lib/dates";
import { TripProvider, useTrip } from "@/lib/client/trip";
import { Button, cx, Empty, Icon, initials, Page, Spinner, TopBar } from "./kit";

const TABS = [
  { seg: "", label: "Trip", icon: "landscape" },
  { seg: "plan", label: "Plan", icon: "event_note" },
  { seg: "money", label: "Money", icon: "account_balance_wallet" },
  { seg: "activity", label: "Activity", icon: "history" },
] as const;

/** A trip: header, the four trip tabs, and the trip's ledger in context for every screen below. */
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

function TripChrome({ children }: { children: ReactNode }) {
  const trip = useTrip();
  const pathname = usePathname();
  const base = `/trips/${trip.tripId}`;
  const rest = pathname.slice(base.length).replace(/^\//, "");
  const tabbed = TABS.some((t) => t.seg === rest);
  const t = trip.state.trip;
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <TopBar
        eyebrow={`GroupTrip · ${t.destination.split(",")[0]} · ${formatDateRange(t.startDate, t.endDate)}`}
        title={t.name}
        back={tabbed ? "/home" : base}
        right={
          <div className="flex items-center gap-space-sm">
            {t.status === "closed" ? (
              <span className="rounded-full bg-surface-container px-space-sm py-0.5 font-label-sm text-label-sm text-on-surface-variant">Closed</span>
            ) : (
              <Link href={`${base}/ask`} aria-label="Ask the ledger" className="flex h-10 w-10 items-center justify-center rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant hover:opacity-90">
                <Icon name="auto_awesome" className="text-[20px]" />
              </Link>
            )}
            <Link href={`${base}/explain`} aria-label="My balance" className="flex h-11 w-11 items-center justify-center rounded-full ring-2 ring-primary/20 transition-colors hover:bg-surface-variant">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container font-label-md text-label-md text-on-primary">{initials(trip.fullName(trip.meId))}</span>
            </Link>
          </div>
        }
      />
      {tabbed ? (
        <div className="sticky top-16 z-30 bg-surface/90 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[520px] gap-space-sm overflow-x-auto px-margin py-space-sm">
            {TABS.map((tab) => {
              const active = tab.seg === rest;
              return (
                <Link
                  key={tab.label}
                  href={tab.seg ? `${base}/${tab.seg}` : base}
                  className={cx(
                    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-space-md py-space-xs font-label-md text-label-md transition-colors",
                    active ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
                  )}
                >
                  <Icon name={tab.icon} className="text-[16px]" />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}

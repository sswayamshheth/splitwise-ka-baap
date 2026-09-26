"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, Spinner, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { tripCover } from "@/lib/covers";
import { daysBetween, formatDateRange, parseIso, todayIso } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

type TripSummary = {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: "active" | "closed";
  phase: "ongoing" | "upcoming" | "past";
  role: "owner" | "member";
  members: number;
  plannedPaise: number;
  spentPaise: number;
  mySharePaise: number;
  myPaidPaise: number;
  myNetPaise: number;
  poolPaise: number;
  updatedAt: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (iso: string) => MONTHS[(parseIso(iso)?.getMonth() ?? 0) % 12];
const monthYear = (iso: string) => {
  const d = parseIso(iso);
  return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : iso;
};

function position(net: number) {
  if (net > 0) return { text: `You're owed ${formatMoney(net)}`, cls: "text-primary-fixed-dim" };
  if (net < 0) return { text: `You owe ${formatMoney(-net)}`, cls: "text-secondary-fixed-dim" };
  return { text: "All square", cls: "text-primary-fixed-dim" };
}

/** "In 4 days", "Day 2 of 5", "Starts today". */
function timing(t: TripSummary, today: string) {
  if (t.phase === "ongoing") {
    const total = daysBetween(t.startDate, t.endDate) + 1;
    const day = daysBetween(t.startDate, today) + 1;
    return `Day ${day} of ${total}`;
  }
  const n = daysBetween(today, t.startDate);
  if (n <= 0) return "Starts today";
  return n === 1 ? "Tomorrow" : `In ${n} days`;
}

const PAST_ICONS = ["local_cafe", "kayaking", "hiking", "beach_access", "landscape", "sailing"];

export default function HomePage() {
  const router = useRouter();
  const { toast } = useFeedback();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loadingDemo, setLoadingDemo] = useState(false);

  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your trips"));
    api<{ profile: { name: string } }>("/api/me")
      .then((r) => setName(r.profile.name?.split(" ")[0] ?? ""))
      .catch(() => undefined);
  }, []);

  async function loadDemo() {
    setLoadingDemo(true);
    try {
      const r = await api<{ tripId: string }>("/api/demo", { method: "POST", body: {} });
      router.push(`/trips/${r.tripId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load the demo", "error");
      setLoadingDemo(false);
    }
  }

  const joinCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const today = todayIso();
  const ongoing = (trips ?? []).filter((t) => t.phase === "ongoing").sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const upcomingAll = (trips ?? []).filter((t) => t.phase === "upcoming").sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const active = ongoing[0] ?? upcomingAll[0];
  const upcoming = [...ongoing.slice(1), ...upcomingAll].filter((t) => t.id !== active?.id);
  const past = (trips ?? []).filter((t) => t.phase === "past").sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-col gap-space-lg px-margin pb-32">
      {/* Greeting */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex flex-col">
          <h1 className="font-headline-md text-headline-md tracking-tight text-on-surface">Hi{name ? ` ${name}` : ""}</h1>
          <p className="font-body-md text-body-md text-on-surface-variant/80">Where are we wandering next?</p>
        </div>
        <div className="relative">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-primary shadow-sm">
            <Icon name="luggage" className="text-[22px]" />
          </span>
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-primary-container" />
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
          <Icon name="cloud_off" className="text-[36px] text-primary" />
          <p className="font-title-md text-title-md text-on-surface">Couldn&apos;t load your trips</p>
          <p className="font-body-md text-body-md text-on-surface-variant">{error}</p>
          <button onClick={() => location.reload()} className="font-title-md text-title-md text-primary">
            Try again
          </button>
        </div>
      ) : trips === null ? (
        <Spinner label="Loading your trips" />
      ) : trips.length === 0 ? (
        <EmptyHero loadingDemo={loadingDemo} onDemo={() => void loadDemo()} />
      ) : (
        <>
          {/* Active trip hero */}
          {active ? (
            <section className="flex flex-col gap-space-xs">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-label-sm text-label-sm font-semibold uppercase tracking-widest text-primary">{active.phase === "ongoing" ? "Active trip" : "Next trip"}</span>
                <span className="flex items-center gap-1 font-label-md text-label-md text-on-surface-variant">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" /> Live ledger
                </span>
              </div>
              <Link href={`/trips/${active.id}`} className="relative block h-64 w-full cursor-pointer overflow-hidden rounded-xl bg-surface-container shadow-sm transition-transform duration-300 active:scale-[0.99]">
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${tripCover(active.destination, active.id)}")` }} />
                <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface via-inverse-surface/40 to-transparent" />
                <div className="relative z-10 flex items-center justify-between p-4">
                  <span className="inline-flex items-center rounded-full bg-surface/90 px-3 py-1 font-label-md text-label-md text-on-surface shadow-sm backdrop-blur-md">{timing(active, today)}</span>
                  {active.poolPaise > 0 ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container/90 px-3 py-1 font-label-md text-label-md text-on-primary shadow-sm backdrop-blur-md">
                      <Icon name="savings" filled className="text-[15px]" />
                      Pool {formatMoney(active.poolPaise)}
                    </span>
                  ) : active.role === "owner" ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container/90 px-3 py-1 font-label-md text-label-md text-on-primary shadow-sm backdrop-blur-md">
                      <Icon name="verified" filled className="text-[15px]" />
                      Organiser
                    </span>
                  ) : null}
                </div>
                <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 p-4 text-on-primary">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="truncate font-headline-sm text-headline-sm font-medium tracking-tight text-surface-container-lowest">{active.name}</h2>
                    <span className="shrink-0 rounded bg-primary-container/60 px-2 py-0.5 font-label-md text-label-md text-primary-fixed backdrop-blur-sm">Group of {active.members}</span>
                  </div>
                  <p className="truncate font-body-md text-body-md text-surface-container-low/90">
                    {active.destination} · {formatDateRange(active.startDate, active.endDate)}
                  </p>
                  <div className="mt-2.5 flex items-center justify-between rounded-lg bg-inverse-surface/60 px-3 py-2 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                      <Icon name={active.poolPaise > 0 ? "lock" : "receipt_long"} className="text-[18px] text-primary-fixed" />
                      <span className="font-label-md text-label-md text-surface-bright">
                        {active.poolPaise > 0 ? `Pool: ${formatMoney(active.poolPaise)}` : `Spent ${formatMoney(active.spentPaise)} of ${formatMoney(active.plannedPaise)}`}
                      </span>
                    </div>
                    <span className={`font-label-sm text-label-sm ${position(active.myNetPaise).cls}`}>{position(active.myNetPaise).text}</span>
                  </div>
                </div>
              </Link>
            </section>
          ) : null}

          {/* Upcoming */}
          <section className="mt-1 flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="font-title-lg text-title-lg text-on-surface">Upcoming trips</h2>
                <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">{upcoming.length}</span>
              </div>
              <Link href="/trips/new" className="flex items-center gap-0.5 font-title-md text-title-md text-primary transition-colors hover:text-primary-container">
                <Icon name="add" className="text-[18px]" />
                <span>Plan trip</span>
              </Link>
            </div>
            {upcoming.length === 0 ? (
              <p className="rounded-xl bg-surface-container-low/70 p-3.5 font-body-md text-body-md text-on-surface-variant">Nothing else planned yet — tap + to start one.</p>
            ) : (
              upcoming.map((t) => (
                <Link key={t.id} href={`/trips/${t.id}`} className="flex w-full cursor-pointer items-center gap-3.5 rounded-xl bg-surface-container-lowest p-3.5 shadow-sm transition-colors hover:bg-surface-container-low">
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-surface-container-high bg-cover bg-center" style={{ backgroundImage: `url("${tripCover(t.destination, t.id)}")` }}>
                    <span className="absolute left-1 top-1 rounded-full bg-surface/90 px-1.5 py-0.5 text-[10px] font-semibold text-on-surface shadow-sm">{month(t.startDate)}</span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-1">
                      <h3 className="truncate font-headline-sm text-title-lg text-on-surface">{t.name}</h3>
                      <Icon name="arrow_forward" className="text-[18px] text-on-surface-variant/60" />
                    </div>
                    <p className="mt-0.5 truncate font-label-md text-label-md text-on-surface-variant">
                      {t.destination.split(",")[0]} · {formatDateRange(t.startDate, t.endDate)} · {t.members} {t.members === 1 ? "person" : "people"}
                    </p>
                    <div className="mt-2 flex items-center justify-between pt-1.5">
                      <span className="font-label-sm text-label-sm font-semibold text-primary">{t.poolPaise > 0 ? `Pool: ${formatMoney(t.poolPaise)}` : `Planned ${formatMoney(t.plannedPaise)}`}</span>
                      <span className="rounded-full bg-secondary-fixed/50 px-2 py-0.5 font-label-sm text-label-sm text-secondary">
                        {t.mySharePaise > 0 ? `Your share ${formatMoney(t.mySharePaise)}` : t.role === "owner" ? "Organiser" : "Member"}
                      </span>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </section>

          {/* Past journeys */}
          {past.length ? (
            <section className="mt-1 flex flex-col gap-space-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-title-lg text-title-lg text-on-surface">Past journeys</h2>
                <span className="font-label-md text-label-md text-on-surface-variant">Archived</span>
              </div>
              <div className="flex flex-col gap-2">
                {past.map((t, i) => (
                  <Link key={t.id} href={`/trips/${t.id}`} className="flex cursor-pointer items-center justify-between rounded-xl bg-surface-container-low/70 p-3.5 transition-colors hover:bg-surface-container">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                        <Icon name={PAST_ICONS[i % PAST_ICONS.length]} className="text-[20px]" />
                      </div>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-title-md text-title-md text-on-surface">{t.name}</span>
                        <span className="font-label-sm text-label-sm text-on-surface-variant/70">
                          {monthYear(t.startDate)} · {t.members} travellers
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`font-label-md text-label-md font-medium ${t.myNetPaise < 0 ? "text-error" : "text-primary"}`}>
                        {t.myNetPaise === 0 ? `Settled ${formatMoney(t.spentPaise)}` : t.myNetPaise > 0 ? `Owed ${formatMoney(t.myNetPaise)}` : `You owe ${formatMoney(-t.myNetPaise)}`}
                      </span>
                      <Icon name="chevron_right" className="text-[18px] text-on-surface-variant/50" />
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      {/* Join with a code */}
      <section className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-3.5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-container-high text-primary">
            <Icon name="group_add" className="text-[20px]" />
          </span>
          <div className="flex flex-col">
            <span className="font-title-md text-title-md text-on-surface">Join a friend&apos;s trip</span>
            <span className="font-label-sm text-label-sm text-on-surface-variant">Enter the 6-character invite code they shared</span>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="h-11 w-full rounded-lg border border-outline-variant/60 bg-surface-container-low px-3 font-title-md tracking-[0.2em] text-on-surface outline-none placeholder:tracking-normal placeholder:text-on-surface-variant/60 focus:border-primary"
            placeholder="e.g. K7Q2ZD"
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinCode.length >= 4 && router.push(`/join/${joinCode}`)}
            autoCapitalize="characters"
          />
          <button
            disabled={joinCode.length < 4}
            onClick={() => router.push(`/join/${joinCode}`)}
            className="h-11 shrink-0 rounded-lg bg-primary-container px-5 font-title-md text-title-md text-on-primary transition-colors hover:bg-primary disabled:opacity-40"
          >
            Join
          </button>
        </div>
      </section>

      {trips && trips.length > 0 ? (
        <button onClick={() => void loadDemo()} disabled={loadingDemo} className="mx-auto flex items-center gap-1 font-label-md text-label-md text-primary disabled:opacity-50">
          <Icon name="bolt" className="text-[16px]" /> {loadingDemo ? "Loading demo…" : "Load / reset the Goa demo trip"}
        </button>
      ) : null}
    </main>
  );
}

function EmptyHero({ loadingDemo, onDemo }: { loadingDemo: boolean; onDemo: () => void }) {
  return (
    <section className="flex flex-col gap-space-md">
      <div className="relative h-64 w-full overflow-hidden rounded-xl bg-surface-container shadow-sm">
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${tripCover("Candolim, Goa beach", "empty")}")` }} />
        <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface via-inverse-surface/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 p-4">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary-fixed">No trips yet</span>
          <h2 className="font-headline-sm text-headline-sm text-surface-container-lowest">Plan the trip, and the money follows</h2>
          <p className="font-body-md text-body-md text-surface-container-low/90">Every booking, share and settlement derives from who is on each plan item.</p>
        </div>
      </div>
      <Link href="/trips/new" className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm transition-colors hover:bg-primary">
        <Icon name="add" className="text-[20px]" /> Plan a trip
      </Link>
      <button onClick={onDemo} disabled={loadingDemo} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-container font-title-md text-title-md text-primary transition-colors hover:bg-surface-container-high disabled:opacity-50">
        <Icon name="bolt" className="text-[20px]" /> {loadingDemo ? "Loading…" : "Load the Goa demo trip"}
      </button>
    </section>
  );
}

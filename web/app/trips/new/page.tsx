"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { cx, Icon, initials, useFeedback } from "@/components/app/kit";
import { api, ApiError } from "@/lib/client/api";
import { portrait, tripCover } from "@/lib/covers";
import { formatDate, formatDateRange, isValidIso, todayIso } from "@/lib/dates";
import { listingById } from "@/lib/explore";
import { computeBudget } from "@/lib/ledger/budget";
import { addItineraryItem, addParticipant, CommandError, createTrip, validateTrip, type ItineraryInput, type TripInput } from "@/lib/ledger/commands";
import { applyEvent, reduceEvents } from "@/lib/ledger/reduce";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type LedgerEvent, type TripState } from "@/lib/ledger/types";
import { formatMoney, parseAmount } from "@/lib/money";

/**
 * New trip: (1) details → the trip is created on the server, (2) members —
 * invite code / link / contacts / by name, (3) budget — the plan's line items,
 * whose estimates become everyone's per-person budget. Each step writes real
 * ledger events, so the trip is usable even if the organiser skips ahead.
 */

const STEPS = ["Trip details", "Invite friends", "Budget"] as const;

function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Hardcoded until contact sync ships with the mobile app. */
const DEMO_CONTACTS = [
  { name: "Rohan Iyer", phone: "98330 •••81" },
  { name: "Siya Kapoor", phone: "99201 •••44" },
  { name: "Kavya Menon", phone: "97690 •••12" },
  { name: "Dev Malhotra", phone: "99870 •••45" },
  { name: "Meera Joshi", phone: "98191 •••07" },
  { name: "Ishaan Rao", phone: "98450 •••63" },
];

const SUGGESTIONS: Record<ExpenseCategory, string> = {
  Stay: "Hotel / villa",
  Transport: "Flights / train",
  Activity: "Activities & tours",
  Food: "Meals",
  "Local travel": "Cabs & scooters",
  Shopping: "Shopping",
  Other: "Permits & misc",
};

const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  Stay: "hotel",
  Transport: "flight",
  Activity: "kayaking",
  Food: "restaurant",
  "Local travel": "directions_car",
  Shopping: "shopping_bag",
  Other: "receipt_long",
};

const fieldCls =
  "h-12 w-full rounded-lg border border-outline-variant/60 bg-surface-container-low px-3.5 font-body-lg text-body-lg text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/60 focus:border-primary focus:bg-surface-container-lowest";

type Draft = { key: number; title: string; category: ExpenseCategory; date: string; endDate?: string; amount: string; forIds: string[]; vendor?: string };

type Created = { tripId: string; joinCode: string; seq: number; events: LedgerEvent[]; selfId: string };

function NewTrip() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useFeedback();
  const listing = listingById(params.get("from") ?? "");

  const [step, setStep] = useState(0);
  const [details, setDetails] = useState<TripInput>(() => {
    if (!listing) return { name: "", destination: "", startDate: "", endDate: "" };
    const start = addDays(todayIso(), 30);
    return { name: listing.title, destination: listing.destination, startDate: start, endDate: addDays(start, listing.nights) };
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [me, setMe] = useState<{ name: string; phone?: string; upiId?: string } | null>(null);

  useEffect(() => {
    api<{ profile: { name: string; phone?: string; upiId?: string } }>("/api/me")
      .then((r) => setMe(r.profile))
      .catch(() => setMe({ name: "" }));
  }, []);

  const errors = validateTrip(details);
  const state = useMemo(() => (created ? reduceEvents(created.events) : null), [created]);

  /** Append events built against the latest state; on a conflict, reload and rebuild once. */
  const append = useCallback(
    async (build: (s: TripState, actor: string) => LedgerEvent[]) => {
      if (!created) return;
      const once = async (c: Created) => {
        const s = reduceEvents(c.events);
        if (!s) throw new CommandError("Trip is not loaded");
        const events = build(s, c.selfId);
        if (!events.length) return c;
        const res = await api<{ seq: number; events: LedgerEvent[] }>(`/api/trips/${c.tripId}/events`, { body: { baseSeq: c.seq, events } });
        const next = { ...c, seq: res.seq, events: [...c.events, ...res.events] };
        setCreated(next);
        return next;
      };
      try {
        return await once(created);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        const fresh = await api<{ seq: number; events: LedgerEvent[] }>(`/api/trips/${created.tripId}`);
        return once({ ...created, seq: fresh.seq, events: fresh.events });
      }
    },
    [created],
  );

  async function createOnServer() {
    setTouched(true);
    if (Object.keys(errors).length) return;
    if (!me?.name) {
      toast("Set your name in Profile first", "error");
      return;
    }
    setBusy(true);
    try {
      const { events } = createTrip(details, { actor: "system" });
      const s0 = reduceEvents(events)!;
      const phone = me.phone?.replace(/\s/g, "");
      const self = addParticipant(s0, { name: me.name, phone: phone && /^(\+91)?[6-9]\d{9}$/.test(phone) ? phone : undefined, upiId: me.upiId }, { actor: "system" });
      if (self.type !== "PARTICIPANT_ADDED") throw new Error("Could not add you to the trip");
      const all = [...events, self];
      const res = await api<{ tripId: string; joinCode: string }>("/api/trips", { body: { events: all, selfParticipantId: self.participant.id } });
      setCreated({ tripId: res.tripId, joinCode: res.joinCode, seq: all.length, events: all, selfId: self.participant.id });
      setStep(1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create the trip", "error");
    } finally {
      setBusy(false);
    }
  }

  const back = created ? `/trips/${created.tripId}` : "/home";
  const coverDest = details.destination || "Goa beach";

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      {/* Top bar */}
      <header className="fixed top-0 z-50 w-full bg-surface/85 shadow-[0_1px_8px_rgba(16,32,28,0.03)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[520px] items-center justify-between px-margin">
          <div className="flex items-center gap-space-sm">
            <Link href={back} aria-label="Back" className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-variant">
              <Icon name="arrow_back" className="text-[24px] text-on-surface" />
            </Link>
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/30 text-primary">
              <Icon name="explore" className="text-[20px]" />
            </span>
            <h1 className="font-headline-sm text-headline-sm tracking-tight text-on-surface">New Trip</h1>
          </div>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-container font-label-md text-label-md text-on-primary ring-2 ring-primary/20">{me?.name ? initials(me.name) : "·"}</span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col gap-space-lg px-margin pb-16 pt-20">
        {/* Step indicator */}
        <div className="flex items-center justify-between">
          <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">
            Step {step + 1} of 3: {STEPS[step]}
          </span>
          <div className="flex gap-1.5" aria-label="Progress">
            {STEPS.map((label, i) => (
              <span key={label} className={cx("h-1 w-7 rounded-full", i <= step ? "bg-primary-container" : "bg-surface-container-high")} />
            ))}
          </div>
        </div>

        {/* Trip draft card */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-lowest p-4 shadow-sm">
          <div className="flex min-w-0 flex-col">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">{created ? "Trip created" : "Trip draft"}</span>
            <span className="truncate font-headline-md text-headline-md text-on-surface">{details.name || "Your next trip"}</span>
            <span className="flex items-center gap-1 truncate font-body-md text-body-md text-on-surface-variant">
              <Icon name="location_on" className="text-[16px]" />
              {details.destination || "Somewhere wonderful"}
              {isValidIso(details.startDate) && isValidIso(details.endDate) ? ` · ${formatDateRange(details.startDate, details.endDate)}` : ""}
            </span>
          </div>
          <div className="h-16 w-16 shrink-0 rounded-lg bg-surface-container-high bg-cover bg-center shadow-sm" style={{ backgroundImage: `url("${tripCover(coverDest, created?.tripId ?? coverDest)}")` }} />
        </div>

        {listing && step === 0 ? (
          <div className="flex items-start gap-3 rounded-xl bg-secondary-fixed/50 p-4">
            <Icon name="campaign" className="text-[20px] text-secondary" />
            <p className="font-body-md text-body-md text-on-secondary-fixed">
              <span className="font-title-md">Sponsored · {listing.advisor}.</span> We&apos;ve pre-filled this from the advisor&apos;s package. Change anything — nothing is booked.
            </p>
          </div>
        ) : null}

        {step === 0 ? (
          <section className="flex flex-col gap-space-md">
            <div className="flex flex-col gap-1">
              <h2 className="font-headline-lg text-headline-lg text-on-surface">Where are we wandering?</h2>
              <p className="font-body-lg text-body-lg text-on-surface-variant">Name the trip and pick the dates. Everything else — the plan, the money — hangs off this.</p>
            </div>
            <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-4 shadow-sm">
              <Labelled label="Trip name" icon="edit" error={touched ? errors.name : undefined}>
                <input className={fieldCls} value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} placeholder="e.g. Goa with the gang" maxLength={60} autoFocus />
              </Labelled>
              <Labelled label="Destination" icon="location_on" error={touched ? errors.destination : undefined}>
                <input className={fieldCls} value={details.destination} onChange={(e) => setDetails({ ...details, destination: e.target.value })} placeholder="e.g. Candolim, North Goa" />
              </Labelled>
              <div className="grid grid-cols-2 gap-space-sm">
                <Labelled label="Starts" icon="flight_takeoff" error={touched ? errors.startDate : undefined}>
                  <input type="date" className={fieldCls} value={details.startDate} onChange={(e) => setDetails({ ...details, startDate: e.target.value })} />
                </Labelled>
                <Labelled label="Ends" icon="flight_land" error={touched ? errors.endDate : undefined}>
                  <input type="date" className={fieldCls} value={details.endDate} min={details.startDate || undefined} onChange={(e) => setDetails({ ...details, endDate: e.target.value })} />
                </Labelled>
              </div>
            </div>
            <PrimaryButton icon="arrow_forward" disabled={busy} onClick={() => void createOnServer()}>
              {busy ? "Creating trip…" : "Create trip & invite friends"}
            </PrimaryButton>
            <p className="text-center font-label-md text-label-md text-on-surface-variant">You&apos;ll be the organiser. You can change details later.</p>
          </section>
        ) : null}

        {step === 1 && created && state ? <MembersStep created={created} state={state} append={append} onNext={() => setStep(2)} /> : null}

        {step === 2 && created && state ? (
          <BudgetStep created={created} state={state} listing={listing} append={append} onDone={() => router.push(`/trips/${created.tripId}`)} />
        ) : null}
      </main>
    </div>
  );
}

function Labelled({ label, icon, error, children }: { label: string; icon: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">
        <Icon name={icon} className="text-[16px] text-primary" /> {label}
      </span>
      {children}
      {error ? <span className="font-label-sm text-label-sm text-error">{error}</span> : null}
    </label>
  );
}

function PrimaryButton({ children, icon, disabled, onClick }: { children: React.ReactNode; icon?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-lg text-title-lg text-on-primary shadow-sm transition-colors hover:bg-primary active:scale-[0.99] disabled:opacity-40"
    >
      {children}
      {icon ? <Icon name={icon} className="text-[22px]" /> : null}
    </button>
  );
}

type Append = (build: (s: TripState, actor: string) => LedgerEvent[]) => Promise<Created | undefined>;

function MembersStep({ created, state, append, onNext }: { created: Created; state: TripState; append: Append; onNext: () => void }) {
  const { toast } = useFeedback();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [showCode, setShowCode] = useState(true);
  useEffect(() => setLink(`${window.location.origin}/join/${created.joinCode}`), [created.joinCode]);

  const names = new Set(state.participants.map((p) => p.name.toLowerCase()));

  async function add(n: string) {
    setBusy(true);
    try {
      await append((s, actor) => [addParticipant(s, { name: n }, { actor })]);
      setName("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add", "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast("Copy failed — select and copy it manually", "error");
    }
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: state.trip.name, text: `Join "${state.trip.name}" on GroupTrip with code ${created.joinCode}`, url: link });
      } catch {
        /* dismissed */
      }
    } else void copy(link, "Invite link");
  }

  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Join "${state.trip.name}" on GroupTrip — code ${created.joinCode}: ${link}`)}`;

  return (
    <section className="flex flex-col gap-space-md">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Bring the circle together</h2>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Friends join with the code or link and see the plan, their share and every change to it.</p>
      </div>

      <a href={whatsapp} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl bg-primary-fixed/40 p-4 transition-colors hover:bg-primary-fixed/60">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary">
          <Icon name="chat" className="text-[22px]" />
        </span>
        <span className="flex flex-1 flex-col">
          <span className="font-title-lg text-title-lg text-on-surface">Share on WhatsApp</span>
          <span className="font-label-md text-label-md text-on-surface-variant">Quickest way for group chats</span>
        </span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-lowest text-primary">
          <Icon name="arrow_forward" className="text-[20px]" />
        </span>
      </a>

      <div className="flex items-center gap-2 rounded-xl bg-surface-container-lowest p-3 shadow-sm">
        <Icon name="link" className="ml-1 text-[20px] text-on-surface-variant" />
        <span className="min-w-0 flex-1 truncate font-body-md text-body-md text-on-surface-variant">{link}</span>
        <button onClick={() => void copy(link, "Invite link")} className="flex shrink-0 items-center gap-1 rounded-lg bg-primary-container px-4 py-2 font-title-md text-title-md text-on-primary transition-colors hover:bg-primary">
          <Icon name="content_copy" className="text-[18px]" /> Copy
        </button>
      </div>

      <div className="flex flex-col rounded-xl bg-surface-container-lowest shadow-sm">
        <button onClick={() => setShowCode((v) => !v)} className="flex items-center justify-between p-4">
          <span className="flex items-center gap-3 font-title-lg text-title-lg text-on-surface">
            <Icon name="pin" className="text-[22px] text-primary" /> Invite code
          </span>
          <Icon name={showCode ? "expand_less" : "expand_more"} className="text-[22px] text-on-surface-variant" />
        </button>
        {showCode ? (
          <div className="flex flex-col items-center gap-2 border-t border-outline-variant/30 p-4">
            <span className="font-display-lg text-display-lg tracking-[0.25em] text-primary">{created.joinCode}</span>
            <span className="text-center font-label-md text-label-md text-on-surface-variant">Friends type this on their Home screen under &ldquo;Join a friend&apos;s trip&rdquo;.</span>
            <div className="flex gap-2">
              <button onClick={() => void copy(created.joinCode, "Code")} className="flex items-center gap-1 rounded-full bg-surface-container px-3 py-1.5 font-label-md text-label-md text-primary hover:bg-surface-container-high">
                <Icon name="content_copy" className="text-[16px]" /> Copy code
              </button>
              <button onClick={() => void share()} className="flex items-center gap-1 rounded-full bg-surface-container px-3 py-1.5 font-label-md text-label-md text-primary hover:bg-surface-container-high">
                <Icon name="share" className="text-[16px]" /> Share
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* In the circle */}
      <div className="flex items-center justify-between pt-1">
        <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">In the circle ({state.participants.length})</span>
        <span className="font-label-md text-label-md text-primary">Code {created.joinCode}</span>
      </div>
      <div className="flex flex-col divide-y divide-outline-variant/30 rounded-xl bg-surface-container-lowest px-4 shadow-sm">
        {state.participants.map((p) => (
          <div key={p.id} className="flex items-center gap-3 py-3.5">
            {p.id === created.selfId ? (
              <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-container font-title-md text-on-primary">
                {initials(p.name)}
                <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-on-primary ring-2 ring-surface-container-lowest">
                  <Icon name="star" filled className="text-[12px]" />
                </span>
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={portrait(p.name)} alt="" className="h-12 w-12 shrink-0 rounded-full bg-surface-container object-cover" />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-title-lg text-title-lg text-on-surface">{p.name}</span>
              <span className="font-label-md text-label-md text-primary">{p.id === created.selfId ? "Organiser · you" : "Added by name · can claim with the code"}</span>
            </div>
            <span className={cx("rounded-full px-2.5 py-0.5 font-label-sm text-label-sm", p.id === created.selfId ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : "bg-surface-container text-on-surface-variant")}>
              {p.id === created.selfId ? "Host" : "Invited"}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-3 py-3.5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
            <Icon name="person_add" className="text-[22px]" />
          </span>
          <input
            className="h-11 min-w-0 flex-1 rounded-lg border border-outline-variant/60 bg-surface-container-low px-3 font-body-md text-body-md text-on-surface outline-none focus:border-primary"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add someone by name"
            maxLength={40}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && void add(name.trim())}
          />
          <button disabled={!name.trim() || busy} onClick={() => void add(name.trim())} className="h-11 shrink-0 rounded-lg bg-primary-container px-4 font-title-md text-title-md text-on-primary disabled:opacity-40">
            Add
          </button>
        </div>
      </div>

      {/* Contacts (demo) */}
      <div className="flex items-center justify-between pt-1">
        <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">From your contacts</span>
        <span className="rounded-full bg-secondary-fixed/60 px-2 py-0.5 font-label-sm text-label-sm text-on-secondary-fixed-variant">Demo contacts</span>
      </div>
      <div className="flex flex-col divide-y divide-outline-variant/30 rounded-xl bg-surface-container-lowest px-4 shadow-sm">
        {DEMO_CONTACTS.map((c) => {
          const added = names.has(c.name.toLowerCase());
          return (
            <div key={c.name} className="flex items-center gap-3 py-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portrait(c.name)} alt="" className="h-10 w-10 shrink-0 rounded-full bg-surface-container object-cover" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-title-md text-title-md text-on-surface">{c.name}</span>
                <span className="font-label-sm text-label-sm text-on-surface-variant">+91 {c.phone}</span>
              </div>
              <button
                disabled={added || busy}
                onClick={() => void add(c.name)}
                className={cx(
                  "flex items-center gap-1 rounded-full px-3 py-1.5 font-label-md text-label-md transition-colors",
                  added ? "bg-transparent text-primary" : "bg-surface-container text-primary hover:bg-surface-container-high",
                )}
              >
                <Icon name={added ? "check" : "person_add"} className="text-[16px]" /> {added ? "Added" : "Add"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="font-label-md text-label-md text-on-surface-variant">Contact sync comes with the mobile app — these are sample contacts.</p>

      <PrimaryButton icon="arrow_forward" onClick={onNext}>
        Next: budget
      </PrimaryButton>
      <button onClick={onNext} className="text-center font-label-md text-label-md text-on-surface-variant">
        Skip for now — you can invite more friends anytime from the trip.
      </button>
    </section>
  );
}

function BudgetStep({ created, state, listing, append, onDone }: { created: Created; state: TripState; listing: ReturnType<typeof listingById>; append: Append; onDone: () => void }) {
  const { toast } = useFeedback();
  const everyone = state.participants.map((p) => p.id);
  const start = state.trip.startDate;
  const end = state.trip.endDate;
  const clampDate = (d: string) => (d < start ? start : d > end ? end : d);
  const [seq, setSeq] = useState(1);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    listing
      ? listing.items.map((i, k) => ({
          key: k + 1,
          title: i.title,
          category: i.category,
          date: clampDate(addDays(start, i.day)),
          endDate: i.nights ? clampDate(addDays(start, i.day + i.nights)) : undefined,
          amount: String((i.perPersonPaise * everyone.length) / 100),
          forIds: everyone,
          vendor: i.vendor,
        }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => setSeq(drafts.length + 1), []); // eslint-disable-line react-hooks/exhaustive-deps

  const toInput = (d: Draft): ItineraryInput => ({
    title: d.title,
    category: d.category,
    date: d.date,
    endDate: d.endDate && d.endDate > d.date ? d.endDate : undefined,
    vendor: d.vendor,
    estimatedPaise: parseAmount(d.amount).paise ?? -1,
    participantIds: d.forIds,
  });

  // Preview the budget exactly as the engine will see it.
  const preview = useMemo(() => {
    let s: TripState = state;
    const problems: Record<number, string> = {};
    for (const d of drafts) {
      try {
        const e = addItineraryItem(s, toInput(d), { actor: created.selfId });
        s = applyEvent(s, e) ?? s;
      } catch (err) {
        problems[d.key] = err instanceof Error ? err.message : "Invalid";
      }
    }
    return { budget: computeBudget(s), problems };
  }, [drafts, state]); // eslint-disable-line react-hooks/exhaustive-deps

  const addDraft = (category: ExpenseCategory) => {
    setDrafts((ds) => [...ds, { key: seq, title: SUGGESTIONS[category], category, date: start, amount: "", forIds: everyone }]);
    setSeq((n) => n + 1);
  };
  const patch = (key: number, p: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));

  async function save() {
    const valid = drafts.filter((d) => !preview.problems[d.key]);
    if (valid.length !== drafts.length) {
      toast("Fix the highlighted items first", "error");
      return;
    }
    setBusy(true);
    try {
      if (valid.length) {
        await append((s, actor) => {
          const out: LedgerEvent[] = [];
          let cur = s;
          for (const d of valid) {
            const e = addItineraryItem(cur, toInput(d), { actor });
            out.push(e);
            cur = applyEvent(cur, e) ?? cur;
          }
          return out;
        });
      }
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save the budget", "error");
      setBusy(false);
    }
  }

  const perPersonFlat = everyone.length ? Math.round(preview.budget.estimatedPaise / everyone.length) : 0;
  const cats = preview.budget.categories.filter((c) => c.estimatedPaise > 0);

  return (
    <section className="flex flex-col gap-space-md">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Sketch the budget</h2>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Add what you plan to spend on. Each line is split among the people it&apos;s for — opt people in and out later in Plan.</p>
      </div>

      {/* Projected share hero */}
      <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Estimated trip cost</span>
            <span className="mt-0.5 font-display-lg-mobile text-display-lg-mobile font-normal text-on-surface">{formatMoney(preview.budget.estimatedPaise)}</span>
          </div>
          <div className="flex flex-col items-end text-right">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Per person</span>
            <span className="mt-0.5 font-currency-md text-currency-md text-on-surface">{formatMoney(perPersonFlat)}</span>
          </div>
        </div>
        <div className="flex items-center gap-space-sm rounded-lg bg-surface-container-low px-3.5 py-2.5">
          <Icon name="calendar_today" className="text-[18px] text-primary" />
          <span className="font-body-md text-body-md text-on-surface-variant">
            {formatDateRange(start, end)} · {everyone.length} {everyone.length === 1 ? "person" : "people"} · nothing booked yet
          </span>
        </div>
        {cats.length ? (
          <div className="flex flex-col gap-3 pt-1">
            {cats.map((c) => (
              <div key={c.category} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-title-md text-title-md text-on-surface">
                    <Icon name={CATEGORY_ICONS[c.category]} className="text-[18px] text-primary" /> {c.category}
                  </span>
                  <span className="font-currency-md text-title-md text-on-surface">{formatMoney(c.estimatedPaise)}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                  <div className="h-full rounded-full bg-primary-container" style={{ width: `${Math.max(3, c.fraction * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Category quick add */}
      <div className="flex flex-col gap-2">
        <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Add a line</span>
        <div className="no-scrollbar -mx-margin flex gap-space-xs overflow-x-auto px-margin py-1">
          {EXPENSE_CATEGORIES.map((c) => (
            <button key={c} onClick={() => addDraft(c)} className="flex shrink-0 items-center gap-1 rounded-full bg-surface-container px-4 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-variant">
              <Icon name={CATEGORY_ICONS[c]} className="text-[16px] text-primary" /> {c}
            </button>
          ))}
        </div>
      </div>

      {drafts.map((d) => (
        <div key={d.key} className={cx("flex flex-col gap-3 rounded-xl bg-surface-container-lowest p-4 shadow-sm", preview.problems[d.key] && "ring-2 ring-error/60")}>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
              <Icon name={CATEGORY_ICONS[d.category]} className="text-[20px]" />
            </span>
            <input
              className="h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 font-title-lg text-title-lg text-on-surface outline-none focus:border-outline-variant"
              value={d.title}
              onChange={(e) => patch(d.key, { title: e.target.value })}
              placeholder="What is it?"
            />
            <button aria-label="Remove" onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-variant">
              <Icon name="close" className="text-[20px]" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-space-sm">
            <label className="flex flex-col gap-1">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Estimate (₹ total)</span>
              <input className={cx(fieldCls, "h-10")} inputMode="decimal" value={d.amount} onChange={(e) => patch(d.key, { amount: e.target.value })} placeholder="0" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Date</span>
              <input type="date" className={cx(fieldCls, "h-10")} min={start} max={end} value={d.date} onChange={(e) => isValidIso(e.target.value) && patch(d.key, { date: e.target.value })} />
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">For · {d.forIds.length === everyone.length ? "everyone" : `${d.forIds.length} of ${everyone.length}`}</span>
            <div className="flex flex-wrap gap-1.5">
              {state.participants.map((p) => {
                const on = d.forIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => patch(d.key, { forIds: on ? d.forIds.filter((x) => x !== p.id) : [...d.forIds, p.id] })}
                    className={cx("inline-flex items-center gap-1 rounded-full px-3 py-1 font-label-md text-label-md transition-colors", on ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                  >
                    {on ? <Icon name="check" className="text-[14px]" /> : null}
                    {p.id === created.selfId ? "You" : p.name.split(" ")[0]}
                  </button>
                );
              })}
            </div>
          </div>
          {preview.problems[d.key] ? <span className="font-label-md text-label-md text-error">{preview.problems[d.key]}</span> : null}
          {!preview.problems[d.key] && d.forIds.length ? (
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {formatMoney(Math.round((parseAmount(d.amount).paise ?? 0) / d.forIds.length))} each · {formatDate(d.date)}
            </span>
          ) : null}
        </div>
      ))}

      {preview.budget.estimatedPaise > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container-lowest p-4 shadow-sm">
          <span className="font-title-lg text-title-lg text-on-surface">Each person&apos;s estimate</span>
          {state.participants.map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              {p.id === created.selfId ? (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container font-label-md text-label-md text-on-primary">{initials(p.name)}</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={portrait(p.name)} alt="" className="h-8 w-8 rounded-full bg-surface-container object-cover" />
              )}
              <span className="flex-1 font-body-md text-body-md text-on-surface">{p.id === created.selfId ? "You" : p.name}</span>
              <span className="font-title-md text-title-md tabular-nums text-on-surface">{formatMoney(preview.budget.estimatedPerParticipant[p.id] ?? 0)}</span>
            </div>
          ))}
          <span className="font-label-sm text-label-sm text-on-surface-variant">Participation-aware: people only carry the lines they&apos;re on.</span>
        </div>
      ) : null}

      <PrimaryButton icon={drafts.length ? "check" : "arrow_forward"} disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : drafts.length ? "Save budget & view trip" : "Done & view trip"}
      </PrimaryButton>
      <button onClick={onDone} disabled={busy} className="text-center font-label-md text-label-md text-on-surface-variant">
        Skip — add plan items later in the Plan tab.
      </button>
    </section>
  );
}

export default function NewTripPage() {
  return (
    <Suspense>
      <NewTrip />
    </Suspense>
  );
}

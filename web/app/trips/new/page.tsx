"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cx, Icon, initials, useFeedback } from "@/components/app/kit";
import { api, ApiError } from "@/lib/client/api";
import { portrait, tripCover } from "@/lib/covers";
import { formatDateRange, isValidIso, todayIso } from "@/lib/dates";
import { listingById } from "@/lib/explore";
import type { Interests } from "@/lib/interests";
import type { DraftItem } from "@/lib/itinerary/parse";
import { extractPdfText, looksLikePdf } from "@/lib/itinerary/pdf-text";
import { addItineraryItem, addParticipant, CommandError, createTrip, validateTrip, type ItineraryInput, type TripInput } from "@/lib/ledger/commands";
import { DEFAULT_BUDGET_SPLIT, setTripBudget } from "@/lib/ledger/pool";
import { applyEvent, reduceEvents } from "@/lib/ledger/reduce";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type LedgerEvent, type TripState } from "@/lib/ledger/types";
import { allocate, formatMoney, parseAmount } from "@/lib/money";

/**
 * New trip: (1) details → the trip is created on the server, (2) members —
 * invite code / link / contacts / by name, (3) budget — one total, with an
 * optional category split, (4) itinerary (optional) — AI/library suggestions,
 * a PDF, a photo or a rough typed plan, reviewed before saving. Each step
 * writes real ledger events, so the trip is usable even if the organiser skips.
 */

const STEPS = ["Trip details", "Invite friends", "Budget", "Itinerary"] as const;

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
  const [me, setMe] = useState<{ name: string; phone?: string; upiId?: string; interests?: Interests } | null>(null);

  useEffect(() => {
    api<{ profile: { name: string; phone?: string; upiId?: string; interests?: Interests } }>("/api/me")
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
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
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

        {step === 2 && created && state ? <BudgetStep created={created} state={state} listing={listing} append={append} onNext={() => setStep(3)} /> : null}

        {step === 3 && created && state ? (
          <ItineraryStep created={created} state={state} listing={listing} me={me} append={append} onDone={() => router.push(`/trips/${created.tripId}`)} />
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

const SPLIT_CATEGORIES: ExpenseCategory[] = ["Stay", "Transport", "Food", "Activity", "Local travel", "Shopping", "Other"];

function BudgetStep({ created, state, listing, append, onNext }: { created: Created; state: TripState; listing: ReturnType<typeof listingById>; append: Append; onNext: () => void }) {
  const { toast } = useFeedback();
  const members = state.participants.filter((p) => !p.leftOn).length || 1;
  const fromListing = listing ? listing.items.reduce((sum, i) => sum + i.perPersonPaise, 0) * members : 0;
  const initialTotal = state.trip.budgetPaise ?? fromListing;
  const [total, setTotal] = useState(initialTotal ? String(initialTotal / 100) : "");
  const [splitOn, setSplitOn] = useState(!!state.trip.budgetSplit);
  const [split, setSplit] = useState<Record<ExpenseCategory, number>>(() => {
    const base = Object.fromEntries(SPLIT_CATEGORIES.map((c) => [c, 0])) as Record<ExpenseCategory, number>;
    return { ...base, ...(state.trip.budgetSplit ?? DEFAULT_BUDGET_SPLIT) } as Record<ExpenseCategory, number>;
  });
  const [busy, setBusy] = useState(false);

  const parsed = parseAmount(total);
  const totalPaise = parsed.paise ?? 0;
  const sum = SPLIT_CATEGORIES.reduce((s, c) => s + (split[c] || 0), 0);
  const splitOk = !splitOn || sum === 100;
  const active = SPLIT_CATEGORIES.filter((c) => (split[c] || 0) > 0);
  const amounts = totalPaise > 0 && sum > 0 ? allocate(totalPaise, SPLIT_CATEGORIES.map((c) => split[c] || 0)) : SPLIT_CATEGORIES.map(() => 0);
  const perPerson = Math.round(totalPaise / members);

  async function save() {
    if (!totalPaise) {
      onNext();
      return;
    }
    if (!splitOk) {
      toast(`Category percentages add up to ${sum}% — make them 100%`, "error");
      return;
    }
    setBusy(true);
    try {
      const splitValue = splitOn ? (Object.fromEntries(active.map((c) => [c, split[c]])) as Partial<Record<ExpenseCategory, number>>) : undefined;
      const unchanged = state.trip.budgetPaise === totalPaise && JSON.stringify(state.trip.budgetSplit ?? null) === JSON.stringify(splitValue ?? null);
      if (!unchanged) await append((s, actor) => [setTripBudget(s, { totalPaise, split: splitValue }, { actor })]);
      onNext();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save the budget", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-space-md">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Set the budget</h2>
        <p className="font-body-lg text-body-lg text-on-surface-variant">One number for the whole trip. Spending is tracked against it as the group books and pays.</p>
      </div>

      <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Total trip budget</span>
        <div className="flex items-center gap-2 border-b-2 border-primary/30 pb-1 focus-within:border-primary">
          <span className="font-display-lg-mobile text-display-lg-mobile text-on-surface-variant">₹</span>
          <input
            className="w-full min-w-0 bg-transparent font-display-lg-mobile text-display-lg-mobile text-on-surface outline-none placeholder:text-on-surface-variant/40"
            inputMode="decimal"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            placeholder="75,000"
            autoFocus
          />
        </div>
        {total && parsed.error ? <span className="font-label-sm text-label-sm text-error">{parsed.error}</span> : null}
        {listing && fromListing && !state.trip.budgetPaise ? (
          <span className="font-label-md text-label-md text-on-surface-variant">Pre-filled from the advisor&apos;s estimate (₹ per person × {members}). Change it freely.</span>
        ) : null}
        <div className="flex items-center gap-space-sm rounded-lg bg-surface-container-low px-3.5 py-2.5">
          <Icon name="group" className="text-[18px] text-primary" />
          <span className="font-body-md text-body-md text-on-surface-variant">
            {totalPaise > 0 ? (
              <>
                About <span className="font-semibold text-on-surface">{formatMoney(perPerson)}</span> per person · {members} {members === 1 ? "person" : "people"}
              </>
            ) : (
              `${members} ${members === 1 ? "person" : "people"} · ${formatDateRange(state.trip.startDate, state.trip.endDate)}`
            )}
          </span>
        </div>
      </div>

      {/* Optional category split */}
      <div className="flex flex-col rounded-xl bg-surface-container-lowest shadow-sm">
        <button type="button" onClick={() => setSplitOn((v) => !v)} className="flex items-center justify-between gap-3 p-4 text-left" aria-expanded={splitOn}>
          <span className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-container text-primary">
              <Icon name="donut_large" className="text-[20px]" />
            </span>
            <span className="flex flex-col">
              <span className="font-title-md text-title-md text-on-surface">Split by category</span>
              <span className="font-label-sm text-label-sm text-on-surface-variant">Optional · starts from a typical split you can change</span>
            </span>
          </span>
          <span className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors", splitOn ? "bg-primary-container" : "bg-surface-container-high")}>
            <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-surface-container-lowest shadow transition-all", splitOn ? "left-[22px]" : "left-0.5")} />
          </span>
        </button>
        {splitOn ? (
          <div className="flex flex-col gap-3 border-t border-outline-variant/30 p-4">
            {SPLIT_CATEGORIES.map((c, i) => {
              const pct = split[c] || 0;
              return (
                <div key={c} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-3">
                    <Icon name={CATEGORY_ICONS[c]} className="text-[18px] text-primary" />
                    <span className="flex-1 font-title-md text-title-md text-on-surface">{c}</span>
                    <span className="w-20 text-right font-label-md text-label-md tabular-nums text-on-surface-variant">{totalPaise ? formatMoney(amounts[i]) : "—"}</span>
                    <div className="flex items-center rounded-lg bg-surface-container-low">
                      <button type="button" aria-label={`Less ${c}`} onClick={() => setSplit({ ...split, [c]: Math.max(0, pct - 5) })} className="flex h-8 w-8 items-center justify-center text-on-surface-variant hover:text-primary">
                        <Icon name="remove" className="text-[16px]" />
                      </button>
                      <input
                        className="h-8 w-10 bg-transparent text-center font-title-md text-title-md tabular-nums text-on-surface outline-none"
                        inputMode="numeric"
                        value={pct}
                        onChange={(e) => setSplit({ ...split, [c]: Math.min(100, Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0)) })}
                        aria-label={`${c} percent`}
                      />
                      <button type="button" aria-label={`More ${c}`} onClick={() => setSplit({ ...split, [c]: Math.min(100, pct + 5) })} className="flex h-8 w-8 items-center justify-center text-on-surface-variant hover:text-primary">
                        <Icon name="add" className="text-[16px]" />
                      </button>
                    </div>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                    <div className="h-full rounded-full bg-primary-container transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            <div className={cx("flex items-center justify-between rounded-lg px-3 py-2", sum === 100 ? "bg-surface-container-low" : "bg-error-container/70")}>
              <span className={cx("font-label-md text-label-md", sum === 100 ? "text-on-surface-variant" : "text-on-error-container")}>{sum === 100 ? "Adds up to 100%" : `Adds up to ${sum}% — needs 100%`}</span>
              <button type="button" onClick={() => setSplit({ ...(Object.fromEntries(SPLIT_CATEGORIES.map((c) => [c, 0])) as Record<ExpenseCategory, number>), ...(DEFAULT_BUDGET_SPLIT as Record<ExpenseCategory, number>) })} className="font-label-md text-label-md font-semibold text-primary">
                Reset to default
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <PrimaryButton icon="arrow_forward" disabled={busy || (totalPaise > 0 && !splitOk) || (!!total && !!parsed.error)} onClick={() => void save()}>
        {busy ? "Saving…" : totalPaise ? "Save budget · next: itinerary" : "Next: itinerary"}
      </PrimaryButton>
      <button onClick={onNext} disabled={busy} className="text-center font-label-md text-label-md text-on-surface-variant">
        Skip — set a budget later from the trip.
      </button>
      <span className="text-center font-label-sm text-label-sm text-on-surface-variant/80">Trip {created.joinCode} · budget is a target, not a charge.</span>
    </section>
  );
}

// ------------------------------------------------------------------ itinerary (optional)

type Source = "suggest" | "pdf" | "photo" | "refine" | "listing";
type Review = { key: number; title: string; category: ExpenseCategory; date: string; endDate?: string; vendor?: string; amount: string; evidence: string };

const SOURCE_LABEL: Record<string, string> = { ai: "AI", library: "Curated library", rules: "Rule-based parser", listing: "Advisor package" };

function ItineraryStep({ created, state, listing, me, append, onDone }: { created: Created; state: TripState; listing: ReturnType<typeof listingById>; me: { interests?: Interests } | null; append: Append; onDone: () => void }) {
  const { toast } = useFeedback();
  const start = state.trip.startDate;
  const end = state.trip.endDate;
  const active = state.participants.filter((p) => !p.leftOn);
  const [mode, setMode] = useState<Source | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ source: string; note: string } | null>(null);
  const [items, setItems] = useState<Review[]>([]);
  const pdfRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  // Group interests: each member's saved preferences (mine from my profile if not synced into the trip yet).
  const { counts, diets, withPrefs } = useMemo(() => {
    const counts: Record<string, number> = {};
    const diets: string[] = [];
    let withPrefs = 0;
    for (const p of active) {
      const i = p.id === created.selfId ? (p.interests ?? me?.interests) : p.interests;
      if (!i) continue;
      withPrefs++;
      for (const a of i.activities) counts[a] = (counts[a] ?? 0) + 1;
      if (i.diet) diets.push(i.diet);
    }
    return { counts, diets, withPrefs };
  }, [active, created.selfId, me]);

  const clamp = (d?: string) => (!d || d < start ? start : d > end ? end : d);

  function load(drafts: DraftItem[], source: string, note: string) {
    setItems(
      drafts.map((d, k) => ({
        key: k + 1,
        title: d.title,
        category: d.category,
        date: clamp(d.date),
        endDate: d.endDate && d.endDate > clamp(d.date) && d.endDate <= end ? d.endDate : undefined,
        vendor: d.vendor,
        amount: d.estimatedPaise ? String(d.estimatedPaise / 100) : "",
        evidence: d.evidence,
      })),
    );
    setResult({ source, note });
    if (!drafts.length) setProblem(note || "Nothing found — try another option.");
  }

  async function ask(body: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    setResult(null);
    setItems([]);
    try {
      const r = await api<{ items: DraftItem[]; source: string; note: string }>("/api/itinerary", {
        body: { destination: state.trip.destination, startDate: start, endDate: end, travellers: active.length, interests: counts, diets, ...body },
      });
      load(r.items, r.source, r.note);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Couldn't read that — try another option");
    } finally {
      setBusy(false);
    }
  }

  async function onPdf(file: File) {
    setMode("pdf");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const content = looksLikePdf(bytes) ? extractPdfText(bytes) : new TextDecoder().decode(bytes);
      if (!content.trim()) {
        setProblem("This PDF has no text layer (it looks scanned). Try the photo option, or paste the text.");
        return;
      }
      await ask({ mode: "pdf", text: content });
    } catch {
      setProblem("Couldn't read that PDF — try pasting the text instead.");
    }
  }

  async function onPhoto(file: File) {
    setMode("photo");
    if (file.size > 5 * 1024 * 1024) {
      setProblem("That image is over 5 MB — try a smaller photo or a screenshot.");
      return;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    }).catch(() => "");
    if (!data) {
      setProblem("Couldn't read that image.");
      return;
    }
    await ask({ mode: "photo", image: { mediaType: file.type, data } });
  }

  function applyListing() {
    if (!listing) return;
    setMode("listing");
    setProblem(null);
    load(
      listing.items.map((i) => ({
        title: i.title,
        category: i.category,
        date: addDays(start, i.day),
        endDate: i.nights ? addDays(start, i.day + i.nights) : undefined,
        vendor: i.vendor,
        estimatedPaise: i.perPersonPaise * active.length,
        evidence: `From ${listing.advisor}'s package · ₹${(i.perPersonPaise / 100).toLocaleString("en-IN")}/person estimate`,
        confidence: "medium" as const,
      })),
      "listing",
      "Sponsored advisor package — estimates, nothing booked.",
    );
  }

  const patch = (key: number, p: Partial<Review>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const problems = useMemo(() => {
    const out: Record<number, string> = {};
    for (const it of items) {
      if (!it.title.trim()) out[it.key] = "Give it a title";
      else if (it.amount && parseAmount(it.amount).paise === undefined) out[it.key] = "Estimate must be an amount";
    }
    return out;
  }, [items]);

  async function save() {
    if (Object.keys(problems).length) {
      toast("Fix the highlighted items first", "error");
      return;
    }
    setSaving(true);
    try {
      await append((s, actor) => {
        const everyone = s.participants.filter((p) => !p.leftOn).map((p) => p.id);
        const out: LedgerEvent[] = [];
        let cur = s;
        for (const it of items) {
          const input: ItineraryInput = {
            title: it.title.trim(),
            category: it.category,
            date: it.date,
            endDate: it.endDate,
            vendor: it.vendor?.trim() || undefined,
            estimatedPaise: parseAmount(it.amount || "0").paise ?? 0,
            participantIds: everyone,
          };
          const e = addItineraryItem(cur, input, { actor, now: Date.now() + out.length });
          out.push(e);
          cur = applyEvent(cur, e) ?? cur;
        }
        return out;
      });
      toast(`${items.length} item${items.length === 1 ? "" : "s"} added to the plan`);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save the itinerary", "error");
      setSaving(false);
    }
  }

  const estimate = items.reduce((s, i) => s + (parseAmount(i.amount || "0").paise ?? 0), 0);
  const budget = state.trip.budgetPaise;

  const options: { id: Source; icon: string; title: string; hint: string; star?: boolean; onClick: () => void }[] = [
    {
      id: "suggest",
      icon: "auto_awesome",
      title: "Suggest for our group",
      hint: withPrefs ? `Based on ${withPrefs} member${withPrefs === 1 ? "'s" : "s'"} interests` : "Based on the destination (add interests in Profile for a better fit)",
      star: true,
      onClick: () => {
        setMode("suggest");
        void ask({ mode: "suggest" });
      },
    },
    { id: "pdf", icon: "picture_as_pdf", title: "Upload a PDF", hint: "Read on your device, then parsed", onClick: () => pdfRef.current?.click() },
    { id: "photo", icon: "photo_camera", title: "Photo of an itinerary", hint: "Screenshot or printout (needs AI)", onClick: () => photoRef.current?.click() },
    {
      id: "refine",
      icon: "edit_note",
      title: "Type a rough plan",
      hint: "We'll turn it into clean items",
      onClick: () => {
        setMode("refine");
        setProblem(null);
      },
    },
  ];

  return (
    <section className="flex flex-col gap-space-md">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Shape the itinerary</h2>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Optional. Start from a suggestion, a file or your own notes — you review every item before it&apos;s added.</p>
      </div>

      <input ref={pdfRef} type="file" accept="application/pdf,.pdf,.txt,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && void onPdf(e.target.files[0])} />
      <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void onPhoto(e.target.files[0])} />

      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={busy}
            onClick={o.onClick}
            className={cx(
              "relative flex flex-col items-start gap-1.5 rounded-xl p-3.5 text-left shadow-sm transition-all active:scale-[0.98] disabled:opacity-60",
              o.star ? "col-span-2 bg-primary-container text-on-primary" : mode === o.id ? "bg-surface-container-high text-on-surface ring-2 ring-primary/40" : "bg-surface-container-lowest text-on-surface hover:bg-surface-container-low",
            )}
          >
            <span className={cx("flex h-9 w-9 items-center justify-center rounded-full", o.star ? "bg-on-primary/15" : "bg-surface-container")}>
              <Icon name={o.icon} className={cx("text-[20px]", o.star ? "text-on-primary" : "text-primary")} />
            </span>
            <span className="font-title-md text-title-md">{o.title}</span>
            <span className={cx("font-label-sm text-label-sm", o.star ? "text-primary-fixed" : "text-on-surface-variant")}>{o.hint}</span>
            {o.star ? <span className="absolute right-3 top-3 rounded-full bg-secondary-container px-2 py-0.5 font-label-sm text-label-sm text-on-secondary-container">Recommended</span> : null}
          </button>
        ))}
        {listing ? (
          <button type="button" disabled={busy} onClick={applyListing} className="col-span-2 flex items-center gap-3 rounded-xl bg-secondary-fixed/40 p-3.5 text-left hover:bg-secondary-fixed/60">
            <Icon name="campaign" className="text-[20px] text-secondary" />
            <span className="flex flex-col">
              <span className="font-title-md text-title-md text-on-secondary-fixed">Use {listing.advisor}&apos;s package</span>
              <span className="font-label-sm text-label-sm text-on-secondary-fixed-variant">Sponsored · the package you came from</span>
            </span>
          </button>
        ) : null}
      </div>

      {mode === "refine" && !items.length ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container-lowest p-4 shadow-sm">
          <textarea
            className="min-h-[140px] w-full resize-y rounded-lg border border-outline-variant/60 bg-surface-container-low p-3 font-body-md text-body-md text-on-surface outline-none focus:border-primary"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"e.g.\nDay 1 · flight to Goa ₹24,000, villa in Candolim\nDay 2 · scuba at Grande Island ~₹3,500 each, dinner at Thalassa\nDay 3 · Dudhsagar trip"}
          />
          <button disabled={busy || !text.trim()} onClick={() => void ask({ mode: "refine", text })} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40">
            <Icon name="auto_fix_high" className="text-[20px]" /> {busy ? "Refining…" : "Refine into items"}
          </button>
        </div>
      ) : null}

      {busy ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-surface-container-low p-5 font-body-md text-body-md text-on-surface-variant">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {mode === "suggest" ? "Putting together a plan for your group…" : mode === "photo" ? "Reading your photo…" : "Reading your itinerary…"}
        </div>
      ) : null}

      {problem ? (
        <div className="flex items-start gap-2 rounded-xl bg-secondary-fixed/50 p-3.5">
          <Icon name="info" className="text-[20px] text-secondary" />
          <p className="font-body-md text-body-md text-on-secondary-fixed">{problem}</p>
        </div>
      ) : null}

      {items.length ? (
        <>
          <div className="flex items-start gap-2 rounded-xl bg-surface-container p-3.5">
            <Icon name={result?.source === "ai" ? "auto_awesome" : result?.source === "rules" ? "rule" : "menu_book"} className="text-[20px] text-primary" />
            <div className="flex flex-col">
              <span className="font-title-md text-title-md text-on-surface">
                {items.length} item{items.length === 1 ? "" : "s"} to review · {SOURCE_LABEL[result?.source ?? ""] ?? "Draft"}
              </span>
              {result?.note ? <span className="font-label-md text-label-md text-on-surface-variant">{result.note}</span> : null}
            </div>
          </div>

          {items.map((it) => (
            <div key={it.key} className={cx("flex flex-col gap-2.5 rounded-xl bg-surface-container-lowest p-3.5 shadow-sm", problems[it.key] && "ring-2 ring-error/60")}>
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
                  <Icon name={CATEGORY_ICONS[it.category]} className="text-[18px]" />
                </span>
                <input
                  className="h-9 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 font-title-md text-title-md text-on-surface outline-none focus:border-outline-variant"
                  value={it.title}
                  onChange={(e) => patch(it.key, { title: e.target.value })}
                />
                <button aria-label="Remove" onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-variant">
                  <Icon name="close" className="text-[18px]" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Estimate ₹</span>
                  <input className={cx(fieldCls, "h-10 px-2.5")} inputMode="decimal" value={it.amount} onChange={(e) => patch(it.key, { amount: e.target.value })} placeholder="0" />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Date</span>
                  <input type="date" className={cx(fieldCls, "h-10 px-2")} min={start} max={end} value={it.date} onChange={(e) => isValidIso(e.target.value) && patch(it.key, { date: clamp(e.target.value) })} />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Type</span>
                  <select className={cx(fieldCls, "h-10 px-2")} value={it.category} onChange={(e) => patch(it.key, { category: e.target.value as ExpenseCategory })}>
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="font-label-sm text-label-sm text-on-surface-variant">{problems[it.key] ?? it.evidence}</span>
            </div>
          ))}

          <div className="flex items-center justify-between rounded-xl bg-surface-container-low px-4 py-3">
            <span className="font-body-md text-body-md text-on-surface-variant">Estimated total</span>
            <span className={cx("font-title-lg text-title-lg tabular-nums", budget && estimate > budget ? "text-error" : "text-on-surface")}>
              {formatMoney(estimate)}
              {budget ? <span className="font-label-md text-label-md text-on-surface-variant"> / {formatMoney(budget)} budget</span> : null}
            </span>
          </div>

          <PrimaryButton icon="check" disabled={saving || busy} onClick={() => void save()}>
            {saving ? "Adding…" : `Add ${items.length} item${items.length === 1 ? "" : "s"} & view trip`}
          </PrimaryButton>
        </>
      ) : null}

      <button onClick={onDone} disabled={saving} className="text-center font-label-md text-label-md text-on-surface-variant">
        {items.length ? "Skip these — plan later in the Plan tab" : "Skip — plan the itinerary later in the Plan tab"}
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

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button, Card, Chip, cx, Empty, Field, Icon, inputCls, Label, Notice, Sheet, useFeedback } from "@/components/app/kit";
import { CATEGORY_ICON, PortraitStack, TimelinePin } from "@/components/app/trip/common";
import { PlanAssistantCard, PlanAssistantSheet } from "@/components/app/trip/PlanAssistant";
import { DayAlternatives, DayWeatherStrip, ItemWeatherBadge, PlanWeather } from "@/components/app/trip/weather/PlanWeather";
import { useTripWeather } from "@/components/app/trip/weather/useTripWeather";
import { useWeatherNotes } from "@/components/app/trip/weather/useWeatherNotes";
import { WeatherIntel, type ItemPins } from "@/components/app/twin/WeatherIntel";
import { categoryPhoto } from "@/lib/covers";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate, isValidIso, todayIso } from "@/lib/dates";
import { computeBudget } from "@/lib/ledger/budget";
import { addItineraryItem, removeItineraryItem, updateItineraryItem, type ItineraryInput } from "@/lib/ledger/commands";
import { describePolicy, pricingOf } from "@/lib/ledger/policy";
import { buildChangeEvents, simulate, type Change } from "@/lib/ledger/simulate";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type FixedLeaveRule, type ItineraryItem } from "@/lib/ledger/types";
import { formatMoney, parseAmount } from "@/lib/money";

/** An item's current fields as a command input, so an edit changes only what it means to. */
function inputOf(item: ItineraryItem): ItineraryInput {
  return {
    title: item.title,
    category: item.category,
    date: item.date,
    endDate: item.endDate,
    time: item.time,
    location: item.location,
    vendor: item.vendor,
    vendorUpi: item.vendorUpi,
    vendorUpiName: item.vendorUpiName,
    estimatedPaise: item.estimatedPaise,
    actualPaise: item.actualPaise,
    participantIds: item.participantIds,
    weights: item.weights,
    notes: item.notes,
    cancellationPolicy: item.cancellationPolicy,
    status: item.status,
  };
}

type Pending = { item: ItineraryItem; change: Change; joining: boolean };

/** Where to book an item: a real search on a booking site, prefilled where the site allows it. */
function bookingUrl(item: ItineraryItem, destination: string): string {
  const city = destination.split(",")[0].trim();
  const q = encodeURIComponent;
  if (item.category === "Stay") {
    const out = item.endDate ?? item.date;
    return `https://www.booking.com/searchresults.html?ss=${q(city)}&checkin=${item.date}&checkout=${out > item.date ? out : item.date}`;
  }
  if (item.category === "Transport") return "https://www.makemytrip.com/flights/";
  return `https://www.google.com/search?q=${q(`${item.title} ${city} book`)}`;
}

/**
 * The plan: the itinerary day by day, who is on each item, and what it is
 * expected to cost. Opting in or out of an unpaid item just edits the plan;
 * opting out of a paid booking goes through the ledger (the vendor's policy
 * decides the refund), previewed before anything is written.
 */
export default function PlanPage() {
  const trip = useTrip();
  const { state, meId } = trip;
  const { toast, confirm } = useFeedback();
  const budget = useMemo(() => computeBudget(state), [state]);
  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; item: ItineraryItem } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [assistant, setAssistant] = useState(false);
  const [pins, setPins] = useState<ItemPins>({});
  const closed = state.trip.status === "closed";

  // Map & weather: code-decided alerts per day; suggestions only, applied by the user.
  const weatherItems = useMemo(
    () => state.itinerary.map((i) => ({ id: i.id, title: i.title, category: i.category, date: i.date, location: i.location, vendor: i.vendor, status: i.status })),
    [state.itinerary],
  );
  const w = useTripWeather({ tripId: trip.tripId, destination: state.trip.destination, place: state.trip.place, startDate: state.trip.startDate, endDate: state.trip.endDate, items: weatherItems });
  const weatherNotes = useWeatherNotes(w.weather);
  const dayWeather = (date: string) => (w.weather?.status === "ok" ? w.weather.days.find((d) => d.date === date) : undefined);
  const itemRisk = (id: string) => (w.weather?.status === "ok" ? w.weather.itemRisk[id] : undefined);
  const canMove = (id: string) => {
    const it = state.itinerary.find((i) => i.id === id);
    return !!it && !closed && it.status === "planned" && it.expenseIds.length === 0 && !it.endDate;
  };
  async function moveItem(itemId: string, date: string) {
    const item = state.itinerary.find((i) => i.id === itemId);
    if (!item) return;
    const ok = await confirm({ title: `Move "${item.title}" to ${formatDate(date)}?`, message: "Only the date changes — everyone on it stays on it.", confirm: "Move" });
    if (!ok) return;
    try {
      await trip.run((s, ctx) => {
        const current = s.itinerary.find((i) => i.id === itemId)!;
        return updateItineraryItem(s, itemId, { ...inputOf(current), date }, ctx);
      });
      toast(`Moved to ${formatDate(date)}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const days = useMemo(() => {
    const sorted = [...state.itinerary].sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
    const groups = new Map<string, ItineraryItem[]>();
    for (const item of sorted) groups.set(item.date, [...(groups.get(item.date) ?? []), item]);
    return [...groups.entries()];
  }, [state.itinerary]);
  const dayIndex = (iso: string) => {
    const start = new Date(`${state.trip.startDate}T00:00:00`).getTime();
    const d = Math.round((new Date(`${iso}T00:00:00`).getTime() - start) / 86_400_000);
    if (d < 0) return "Before the trip";
    return iso > state.trip.endDate ? "After the trip" : `Day ${d + 1}`;
  };

  async function togglePlanned(item: ItineraryItem) {
    const on = item.participantIds.includes(meId);
    if (on && item.participantIds.length === 1) {
      const ok = await confirm({ title: `Remove "${item.title}"?`, message: "You're the only one on it, so opting out removes it from the plan.", confirm: "Remove", danger: true });
      if (!ok) return;
      try {
        await trip.run((s, ctx) => removeItineraryItem(s, item.id, ctx));
        toast("Removed from the plan");
      } catch (e) {
        toast(errorText(e), "error");
      }
      return;
    }
    try {
      await trip.run((s, ctx) => {
        const current = s.itinerary.find((i) => i.id === item.id)!;
        const input = inputOf(current);
        const idx = current.participantIds.indexOf(meId);
        if (idx >= 0) {
          input.participantIds = current.participantIds.filter((id) => id !== meId);
          input.weights = current.weights?.filter((_, i) => i !== idx);
        } else {
          input.participantIds = [...current.participantIds, meId];
          input.weights = current.weights ? [...current.weights, 1] : undefined;
        }
        return updateItineraryItem(s, item.id, input, ctx);
      });
      toast(on ? `You're out of ${item.title} · plan re-split` : `You're in for ${item.title}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  function toggleBooked(item: ItineraryItem) {
    const expense = state.expenses.find((e) => item.expenseIds.includes(e.id) && e.status === "active");
    if (!expense) {
      toast("This booking is cancelled", "error");
      return;
    }
    const joining = !expense.participants.some((p) => p.participantId === meId);
    const change: Change = joining ? { kind: "join-booking", participantId: meId, expenseId: expense.id } : { kind: "withdraw", participantId: meId, expenseId: expense.id, date: todayIso(), rule: "redistribute" };
    setPending({ item, change, joining });
  }

  const myPlanned = budget.estimatedPerParticipant[meId] ?? 0;
  const today = todayIso();
  const [day, setDay] = useState<string>(() => (days.some(([d]) => d === today) ? today : "all"));
  const shown = day === "all" ? days : days.filter(([d]) => d === day);
  const pinFor = (item: ItineraryItem, booked: boolean) =>
    item.status === "cancelled" ? ("idle" as const) : booked && item.date < today ? ("done" as const) : booked ? ("active" as const) : ("idle" as const);

  return (
    <main className="mx-auto w-full max-w-[520px] flex-1 pb-10">
      {/* header + day selector carousel */}
      <div className="px-margin pb-space-sm pt-space-md">
        <div className="flex items-center justify-between pb-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary">Chronicle &amp; Itinerary</span>
          <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {state.trip.destination.split(",")[0]}
          </span>
        </div>
        <div className="-mx-margin flex items-center gap-space-xs overflow-x-auto px-margin py-space-xs">
          <button
            onClick={() => setDay("all")}
            className={cx(
              "flex-shrink-0 rounded-full px-4 py-2 font-label-md text-label-md transition-colors",
              day === "all" ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
            )}
          >
            All days
          </button>
          {days.map(([date]) => {
            const active = day === date;
            return (
              <button
                key={date}
                onClick={() => setDay(date)}
                className={cx(
                  "flex flex-shrink-0 items-center gap-1.5 rounded-full px-4 py-2 font-label-md text-label-md transition-colors",
                  active ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high",
                )}
              >
                <span>
                  {dayIndex(date)} <span className={cx("text-xs font-normal", active ? "opacity-80" : "opacity-60")}>{formatDate(date)}</span>
                </span>
                {date === today ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-secondary-container" />
                    <span className="text-[10px] uppercase tracking-tight opacity-90">Today</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* plan estimate strip (the design's daily pool strip) */}
      <div className="px-margin">
        <div className="flex items-center gap-space-md rounded-xl bg-surface-container-low p-space-md">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-container-highest text-primary">
            <Icon name="account_balance_wallet" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline gap-1.5">
              <span className="font-currency-md text-currency-md text-on-surface">{formatMoney(budget.estimatedPaise)}</span>
              <span className="font-label-md text-label-md text-on-surface-variant">planned</span>
            </span>
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              Your share {formatMoney(myPlanned)} · {budget.plannedCount} planned · {budget.bookedCount} booked{budget.cancelledCount ? ` · ${budget.cancelledCount} cancelled` : ""}
            </span>
          </div>
          <Link href={`/trips/${trip.tripId}/simulate`} aria-label="What if" className="flex h-10 w-10 items-center justify-center rounded-full text-primary hover:bg-surface-container">
            <Icon name="science" />
          </Link>
        </div>
        {!closed ? <WeatherIntel onPins={setPins} /> : null}
        {!closed ? <PlanAssistantCard onOpen={() => setAssistant(true)} /> : null}
        {!closed ? (
          <button onClick={() => setSheet({ mode: "add" })} className="mt-space-sm flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/40 font-title-md text-[15px] text-primary hover:bg-surface-container-low">
            <Icon name="add" className="text-[20px]" /> Add to the plan
          </button>
        ) : null}
      </div>

      <PlanWeather w={w} pins={pins} itemTitle={(id) => state.itinerary.find((i) => i.id === id)?.title ?? "Plan item"} />

      {days.length === 0 ? (
        <div className="px-margin pt-space-lg">
          <Empty icon="event_note" title="Nothing planned yet" message="Add stays, travel and activities — the budget and everyone's share follow from the plan." action={<Button small icon="add" onClick={() => setSheet({ mode: "add" })}>Add the first item</Button>} />
        </div>
      ) : null}

      {shown.map(([date, items]) => (
        <section key={date} className="px-margin pt-space-lg">
          <div className="mb-space-md flex items-baseline justify-between">
            <h2 className="font-headline-md text-headline-md text-on-surface">
              {dayIndex(date)} <span className="font-body-md text-body-md text-on-surface-variant">· {formatDate(date)}</span>
            </h2>
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
              {items.length} milestone{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <DayWeatherStrip day={dayWeather(date)} />
          {/* editorial timeline */}
          <div className="relative">
            <div className="absolute bottom-8 left-[11px] top-6 w-[2px] rounded-full bg-surface-container-highest" />
            <div className="flex flex-col gap-space-lg">
              {items.map((item) => {
                const b = budget.byItemId[item.id];
                const on = item.participantIds.includes(meId) || state.expenses.some((e) => item.expenseIds.includes(e.id) && e.status === "active" && e.participants.some((p) => p.participantId === meId));
                const booked = item.expenseIds.length > 0 && item.status !== "cancelled";
                const expense = state.expenses.find((e) => item.expenseIds.includes(e.id));
                const perHead = expense ? pricingOf(expense) === "per-head" : pricingOf({ category: item.category }) === "per-head";
                const going = item.participantIds.map((id) => trip.fullName(id));
                const amount = b?.actualPaise ?? item.estimatedPaise;
                const perPerson = item.participantIds.length ? Math.round(amount / item.participantIds.length) : amount;
                const when = [item.time, item.location ?? item.vendor].filter(Boolean).join(" · ") || item.category;
                const status = item.status === "cancelled" ? "Cancelled" : booked ? (item.date < today ? "Done" : "Booked") : "Planned";
                const footer = (
                  <>
                    {b?.variancePaise ? (
                      <span className={cx("font-label-sm text-label-sm", b.variancePaise > 0 ? "text-error" : "text-primary")}>
                        Estimated {formatMoney(item.estimatedPaise)} · actual {formatMoney(b.actualPaise ?? 0)} ({formatMoney(b.variancePaise, { signed: true })})
                      </span>
                    ) : null}
                    {item.cancellationPolicy ? (
                      <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
                        <Icon name="policy" className="text-[14px]" />
                        {describePolicy(item.cancellationPolicy)}
                      </span>
                    ) : null}
                    {item.status !== "cancelled" && !closed ? (
                      <div className="mt-space-sm flex gap-space-sm">
                        <button
                          onClick={() => (booked ? toggleBooked(item) : void togglePlanned(item))}
                          className={cx(
                            "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg font-label-md text-label-md transition-colors",
                            on ? "bg-surface-container text-on-surface-variant hover:bg-surface-container-high" : "bg-surface-container-lowest text-primary shadow-sm ring-1 ring-primary/30 hover:bg-surface-container-low",
                          )}
                        >
                          <Icon name={on ? "do_not_disturb_on" : "thumb_up"} className="text-[18px]" />
                          {on ? "Decline" : "Count me in"}
                        </button>
                        {!booked ? (
                          <a
                            href={bookingUrl(item, state.trip.destination)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Opens the booking site in a new tab. On desktop, the GroupTrip extension shows whose card saves most at checkout."
                            className="flex h-10 items-center justify-center gap-1 rounded-lg bg-primary-container px-space-md font-label-md text-label-md text-on-primary hover:bg-primary"
                          >
                            <Icon name="open_in_new" className="text-[18px]" /> Book
                          </a>
                        ) : null}
                        {!booked ? (
                          <button onClick={() => setSheet({ mode: "edit", item })} className="flex h-10 items-center justify-center gap-1 rounded-lg px-space-md font-label-md text-label-md text-primary hover:bg-surface-container">
                            <Icon name="edit" className="text-[18px]" /> Edit
                          </button>
                        ) : (
                          <Link href={`/trips/${trip.tripId}/activity?expense=${item.expenseIds[0]}`} className="flex h-10 items-center justify-center gap-1 rounded-lg px-space-md font-label-md text-label-md text-primary hover:bg-surface-container">
                            <Icon name="history" className="text-[18px]" /> History
                          </Link>
                        )}
                      </div>
                    ) : null}
                    <div className="-mx-space-md -mb-space-md mt-space-md flex items-center justify-between gap-space-sm rounded-b-xl bg-surface-container-low/60 p-space-sm px-space-md">
                      <span className="flex min-w-0 items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
                        {booked ? <Icon name="check_circle" className="text-[16px] text-primary" /> : <Icon name="group" className="text-[16px]" />}
                        <span className="truncate">
                          {booked ? "Confirmed" : "Planned"} · {item.participantIds.length} going · {perHead ? "per head" : "one price"}
                          {b?.estimatedShares[meId] ? ` · you ${formatMoney(b.estimatedShares[meId])}` : ""}
                        </span>
                      </span>
                      <PortraitStack names={going} max={4} size={24} />
                    </div>
                  </>
                );
                return (
                  <div key={item.id} className={cx("relative flex items-start gap-space-md", item.status === "cancelled" && "opacity-60")}>
                    <TimelinePin icon={pinFor(item, booked) === "done" ? "check_circle" : CATEGORY_ICON[item.category]} tone={pinFor(item, booked)} />
                    {booked ? (
                      <div className="min-w-0 flex-1 overflow-hidden rounded-xl bg-surface-container-lowest shadow-md">
                        <div className="relative h-28 w-full bg-cover bg-center" style={{ backgroundImage: `url("${categoryPhoto(item.category, item.id)}")` }}>
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                          <div className="absolute left-3 top-2.5">
                            <span className="rounded-full bg-surface-container-lowest/90 px-2.5 py-1 font-label-sm text-label-sm font-semibold text-primary backdrop-blur-sm">{item.time ?? formatDate(item.date)}{item.endDate ? ` → ${formatDate(item.endDate)}` : ""}</span>
                          </div>
                          <div className="absolute bottom-2.5 left-3 right-3 flex items-end justify-between">
                            <span className="truncate font-label-md text-label-md text-surface-container-lowest">{item.vendor ?? item.location ?? item.category}</span>
                            <span className="font-currency-md text-currency-md text-secondary-container">
                              {formatMoney(perHead ? perPerson : amount)}
                              {perHead ? <span className="font-label-sm text-label-sm">/p</span> : null}
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-space-xs p-space-md">
                          <h3 className="min-w-0 break-words font-headline-sm text-headline-sm text-on-surface">{item.title}</h3>
                          <ItemWeatherBadge risk={itemRisk(item.id)} />
                          {b?.nights ? (
                            <span className="font-body-md text-body-md text-on-surface-variant">
                              {b.nights} night{b.nights === 1 ? "" : "s"} · {formatMoney(amount)} total
                            </span>
                          ) : !perHead ? (
                            <span className="font-body-md text-body-md text-on-surface-variant">{formatMoney(amount)} for the group</span>
                          ) : null}
                          {footer}
                        </div>
                      </div>
                    ) : (
                      <div className={cx("flex min-w-0 flex-1 flex-col gap-space-xs rounded-xl p-space-md", item.status === "cancelled" ? "bg-surface-container-low" : "bg-surface-container-lowest shadow-sm")}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-label-sm text-label-sm uppercase tracking-wider text-primary">{when}</span>
                          <span className={cx("shrink-0 rounded-full px-2 py-0.5 font-label-sm text-[10px] font-semibold uppercase", status === "Cancelled" ? "bg-error-container text-on-error-container" : "bg-surface-container text-on-surface-variant")}>{status}</span>
                        </div>
                        <div className="flex items-start justify-between gap-space-sm">
                          <h3 className="font-headline-sm text-headline-sm text-on-surface">{item.title}</h3>
                          <span className="shrink-0 text-right font-currency-md text-currency-md text-on-surface">
                            {formatMoney(perHead ? perPerson : amount)}
                            {perHead ? <span className="font-label-sm text-label-sm text-on-surface-variant">/p</span> : null}
                          </span>
                        </div>
                        <ItemWeatherBadge risk={itemRisk(item.id)} />
                        {item.endDate ? (
                          <span className="font-body-md text-body-md text-on-surface-variant">
                            until {formatDate(item.endDate)}
                            {b?.nights ? ` · ${b.nights} night${b.nights === 1 ? "" : "s"}` : ""}
                          </span>
                        ) : null}
                        {footer}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <DayAlternatives day={dayWeather(date)} canMove={canMove} onMove={(id, d) => void moveItem(id, d)} explanations={weatherNotes.notes} order={weatherNotes.order[date]} />
        </section>
      ))}

      <ItemSheet state={sheet} onClose={() => setSheet(null)} />
      {pending ? <BookedChange pending={pending} onClose={() => setPending(null)} /> : null}
      {assistant ? <PlanAssistantSheet open onClose={() => setAssistant(false)} /> : null}
    </main>
  );
}

/** Opting in/out of a paid booking: a real ledger change, previewed with the simulator first. */
function BookedChange({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [rule, setRule] = useState<FixedLeaveRule>("redistribute");
  const [busy, setBusy] = useState(false);
  const change = useMemo<Change>(() => (pending.change.kind === "withdraw" ? { ...pending.change, rule } : pending.change), [pending.change, rule]);
  const expense = trip.state.expenses.find((e) => e.id === ("expenseId" in change ? change.expenseId : ""));
  const fixed = expense ? pricingOf(expense) === "fixed" : false;
  const sim = useMemo(() => simulate(trip.events, [change], { actor: trip.meId }, (id) => trip.fullName(id).split(" ")[0]), [change, trip]);
  const mine = sim.ok ? sim.diff.people.find((p) => p.participantId === trip.meId) : undefined;
  const others = sim.ok ? sim.diff.people.filter((p) => p.participantId !== trip.meId && p.deltaPaise !== 0) : [];

  async function apply() {
    setBusy(true);
    try {
      await trip.run((state, ctx) => buildChangeEvents(state, change, ctx));
      toast(pending.joining ? `You're in for ${pending.item.title}` : `You're out of ${pending.item.title}`);
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={pending.joining ? "Join this booking?" : "Drop out of this booking?"}>
      <div className="flex flex-col gap-space-md">
        <p className="font-body-md text-body-md text-on-surface-variant">
          <span className="font-title-md text-on-surface">{pending.item.title}</span> is already paid, so this changes the ledger. Preview from the engine — nothing is written until you confirm.
        </p>
        {!pending.joining && fixed ? (
          <div className="flex flex-col gap-space-xs">
            <Label>Fixed price — the vendor charges the same without you</Label>
            <div className="flex gap-space-sm">
              <Chip selected={rule === "redistribute"} onClick={() => setRule("redistribute")}>
                Others absorb my part
              </Chip>
              <Chip selected={rule === "leaver-pays"} onClick={() => setRule("leaver-pays")}>
                I keep paying
              </Chip>
            </div>
          </div>
        ) : null}
        {!sim.ok ? (
          <Notice tone="coral" icon="block" title="Not possible">
            {sim.error}
          </Notice>
        ) : (
          <Card tone="soft" className="flex flex-col gap-space-sm">
            {sim.diff.affected.map((b) => (
              <span key={b.expenseId} className="font-body-md text-body-md text-on-surface">
                {b.reason}
              </span>
            ))}
            {sim.diff.refundsAdded.map((r) => (
              <span key={r.id} className="font-body-md text-body-md text-primary">
                Vendor refund {formatMoney(r.amountPaise)} to {trip.short(r.receivedBy)}
              </span>
            ))}
            {mine ? (
              <div className="flex items-center justify-between border-t border-outline-variant/40 pt-space-sm">
                <span className="font-title-md text-title-md">Your balance</span>
                <span className="font-currency-md">
                  {formatMoney(mine.netBefore, { signed: true })} → {formatMoney(mine.netAfter, { signed: true })}
                </span>
              </div>
            ) : null}
            {others.length ? (
              <span className="font-label-md text-label-md text-on-surface-variant">
                Others: {others.map((p) => `${trip.short(p.participantId)} ${formatMoney(p.deltaPaise, { signed: true })}`).join(" · ")}
              </span>
            ) : (
              <span className="font-label-md text-label-md text-on-surface-variant">Nobody else&apos;s balance moves.</span>
            )}
          </Card>
        )}
        <Button full icon="check" disabled={!sim.ok || busy} onClick={() => void apply()}>
          {busy ? "Applying…" : "Confirm"}
        </Button>
      </div>
    </Sheet>
  );
}

/** Add or edit an unpaid plan item. */
function ItemSheet({ state: open, onClose }: { state: { mode: "add" } | { mode: "edit"; item: ItineraryItem } | null; onClose: () => void }) {
  const trip = useTrip();
  const { toast, confirm } = useFeedback();
  const editing = open?.mode === "edit" ? open.item : null;
  const key = open ? (editing?.id ?? "new") : "closed";
  return open ? <ItemForm key={key} editing={editing} onClose={onClose} trip={trip} toast={toast} confirm={confirm} /> : null;
}

function ItemForm({
  editing,
  onClose,
  trip,
  toast,
  confirm,
}: {
  editing: ItineraryItem | null;
  onClose: () => void;
  trip: ReturnType<typeof useTrip>;
  toast: ReturnType<typeof useFeedback>["toast"];
  confirm: ReturnType<typeof useFeedback>["confirm"];
}) {
  const active = trip.state.participants.filter((p) => !p.leftOn);
  const [title, setTitle] = useState(editing?.title ?? "");
  const [category, setCategory] = useState<ExpenseCategory>(editing?.category ?? "Activity");
  const [date, setDate] = useState(editing?.date ?? trip.state.trip.startDate);
  const [endDate, setEndDate] = useState(editing?.endDate ?? "");
  const [time, setTime] = useState(editing?.time ?? "");
  const [vendor, setVendor] = useState(editing?.vendor ?? "");
  const [vendorUpi, setVendorUpi] = useState(editing?.vendorUpi ?? "");
  const [amount, setAmount] = useState(editing ? String(editing.estimatedPaise / 100) : "");
  const [who, setWho] = useState<string[]>(editing?.participantIds ?? active.map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const parsed = parseAmount(amount);
  const valid = title.trim() && isValidIso(date) && (!endDate || isValidIso(endDate)) && parsed.paise !== undefined && who.length > 0;

  async function save() {
    if (!valid || parsed.paise === undefined) return;
    setBusy(true);
    try {
      await trip.run((s, ctx) => {
        const input: ItineraryInput = {
          ...(editing ? inputOf(s.itinerary.find((i) => i.id === editing.id) ?? editing) : { participantIds: [], estimatedPaise: 0, title: "", category, date }),
          title,
          category,
          date,
          endDate: endDate || undefined,
          time: time || undefined,
          vendor: vendor || undefined,
          vendorUpi: vendorUpi.trim() || undefined,
          estimatedPaise: parsed.paise!,
          participantIds: who,
          weights: undefined,
        };
        return editing ? updateItineraryItem(s, editing.id, input, ctx) : addItineraryItem(s, input, ctx);
      });
      toast(editing ? "Plan updated · every share re-derived" : "Added to the plan");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    const ok = await confirm({ title: `Remove "${editing.title}"?`, message: `The plan estimate drops by ${formatMoney(editing.estimatedPaise)}.`, confirm: "Remove", danger: true });
    if (!ok) return;
    try {
      await trip.run((s, ctx) => removeItineraryItem(s, editing.id, ctx));
      toast("Removed from the plan");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return (
    <Sheet open onClose={onClose} title={editing ? "Edit plan item" : "Add to plan"}>
      <div className="flex flex-col gap-space-md">
        <Field label="What">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sunset cruise" maxLength={80} autoFocus={!editing} />
        </Field>
        <div className="flex flex-wrap gap-space-xs">
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-space-sm">
          <Field label="Date">
            <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Until (optional)">
            <input className={inputCls} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="Time (optional)">
            <input className={inputCls} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Estimate" error={amount && parsed.error ? parsed.error : undefined}>
            <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹ total" />
          </Field>
        </div>
        <Field label="Vendor (optional)">
          <input className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Goa Dive Centre" />
        </Field>
        <Field label="Vendor UPI ID (optional)" hint="From the vendor's UPI QR — lets anyone pay them from a UPI app.">
          <input className={inputCls} value={vendorUpi} onChange={(e) => setVendorUpi(e.target.value)} placeholder="vendor@okaxis" autoCapitalize="none" />
        </Field>
        <div className="flex flex-col gap-space-xs">
          <Label>Who&apos;s going ({who.length})</Label>
          <div className="flex flex-wrap gap-space-xs">
            {active.map((p) => (
              <Chip key={p.id} selected={who.includes(p.id)} onClick={() => setWho(who.includes(p.id) ? who.filter((x) => x !== p.id) : [...who, p.id])}>
                {trip.short(p.id)}
              </Chip>
            ))}
          </div>
          {parsed.paise !== undefined && who.length ? <span className="font-label-sm text-label-sm text-on-surface-variant">≈ {formatMoney(Math.round(parsed.paise / who.length))} each (exact split is computed by the ledger)</span> : null}
        </div>
        <Button full icon="check" disabled={!valid || busy} onClick={() => void save()}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add to plan"}
        </Button>
        {editing ? (
          <Button full variant="ghost" icon="delete" onClick={() => void remove()}>
            Remove from plan
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

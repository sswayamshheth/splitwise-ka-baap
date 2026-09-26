"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";

import { Button, Card, Chip, cx, Field, Icon, inputCls, Money, Notice, Page, Pill, useFeedback } from "@/components/app/kit";
import { buildAll } from "@/components/app/money/build";
import { AmountField, Eyebrow, Face, FacePair } from "@/components/app/money/parts";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate, isValidIso, todayIso } from "@/lib/dates";
import { buildNameLookup, describeEvent } from "@/lib/ledger/describe";
import { summariseDelta } from "@/lib/ledger/explain";
import { describePolicy, describeRefundOn, pricingOf } from "@/lib/ledger/policy";
import { describeChange, refundTotal, simulate, type Change, type PersonDiff, type Simulation } from "@/lib/ledger/simulate";
import type { FixedLeaveRule } from "@/lib/ledger/types";
import { formatMoney, parseAmount } from "@/lib/money";

/**
 * What if…? Build a change (or several), see exactly what it does to every
 * balance, booking, refund and the settlement plan, then apply it — or don't.
 * The preview is the same validated commands replayed on a copy of the log;
 * Apply rebuilds those events on the live state and appends them.
 */

type Kind = "leave-trip" | "withdraw" | "join-booking" | "cancel-booking" | "reprice" | "drop-item";
const KINDS: { value: Kind; label: string; icon: string }[] = [
  { value: "leave-trip", label: "Someone leaves", icon: "person_remove" },
  { value: "withdraw", label: "Drops one booking", icon: "event_busy" },
  { value: "join-booking", label: "Joins a booking", icon: "person_add" },
  { value: "cancel-booking", label: "Booking cancelled", icon: "block" },
  { value: "reprice", label: "Price changes", icon: "price_change" },
  { value: "drop-item", label: "Drop a plan item", icon: "playlist_remove" },
];

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseChangeParam(raw: string | null): Change[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Change | Change[];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((c) => c && typeof c === "object" && typeof (c as { kind?: unknown }).kind === "string");
  } catch {
    return [];
  }
}

function Simulator() {
  const trip = useTrip();
  const router = useRouter();
  const params = useSearchParams();
  const { toast, confirm } = useFeedback();

  const preset = useMemo(() => parseChangeParam(params.get("change")), [params]);
  const [stack, setStack] = useState<Change[]>(preset.length > 1 ? preset.slice(0, -1) : []);
  const first = preset[preset.length - 1];
  const [kind, setKind] = useState<Kind>(first && KINDS.some((k) => k.value === first.kind) ? (first.kind as Kind) : "leave-trip");
  const [personId, setPersonId] = useState<string | null>(first && "participantId" in first ? first.participantId : null);
  const [expenseId, setExpenseId] = useState<string | null>(first && "expenseId" in first ? (first.expenseId ?? null) : null);
  const [itemId, setItemId] = useState<string | null>(first && "itemId" in first ? (first.itemId ?? null) : null);
  const [amountText, setAmountText] = useState<string>(first && first.kind === "reprice" ? String(first.newAmountPaise / 100) : "");
  const [date, setDate] = useState<string>(first && "date" in first ? first.date : todayIso());
  const [rule, setRule] = useState<FixedLeaveRule>(first && "rule" in first && first.rule ? first.rule : "redistribute");
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const draft: Change | null = useMemo(() => {
    if (!isValidIso(date) && (kind === "leave-trip" || kind === "withdraw" || kind === "cancel-booking")) return null;
    if (kind === "leave-trip") return personId ? { kind, participantId: personId, date, rule } : null;
    if (kind === "withdraw") return personId && expenseId ? { kind, participantId: personId, expenseId, date, rule } : null;
    if (kind === "join-booking") return personId && expenseId ? { kind, participantId: personId, expenseId } : null;
    if (kind === "cancel-booking") return expenseId ? { kind, expenseId, date } : null;
    if (kind === "reprice") {
      const parsed = parseAmount(amountText);
      if (parsed.paise === undefined || parsed.paise <= 0) return null;
      if (expenseId) return { kind, expenseId, newAmountPaise: parsed.paise };
      if (itemId) return { kind, itemId, newAmountPaise: parsed.paise };
      return null;
    }
    if (kind === "drop-item") return itemId ? { kind, itemId } : null;
    return null;
  }, [kind, personId, expenseId, itemId, amountText, date, rule]);

  const changes = useMemo(() => (draft ? [...stack, draft] : stack), [stack, draft]);
  const first_ = (id: string) => trip.fullName(id).split(" ")[0];
  const sim = useMemo(() => (changes.length ? simulate(trip.events, changes, { actor: trip.meId }, first_) : null), [trip.events, trip.meId, changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (!sim || !sim.ok) return;
    const ok = await confirm({
      title: "Apply this change to the trip?",
      message: `${sim.events.length} event${sim.events.length === 1 ? "" : "s"} will be written to the ledger. Every balance, refund and the settlement plan update exactly as previewed.`,
      confirm: "Apply",
    });
    if (!ok) return;
    setApplying(true);
    try {
      const written = await trip.run((state, ctx) => buildAll(state, changes, ctx));
      toast(`Applied · ${written.length} ledger event${written.length === 1 ? "" : "s"} written`);
      router.push(`/trips/${trip.tripId}`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setApplying(false);
    }
  };

  const { state } = trip;
  const members = state.participants.filter((p) => !p.leftOn);
  const activeExpenses = state.expenses.filter((e) => e.status === "active");
  const bookingChoices = activeExpenses.filter((e) => {
    if (kind === "withdraw") return !personId || e.participants.some((p) => p.participantId === personId);
    if (kind === "join-booking") return !personId || (!e.participants.some((p) => p.participantId === personId) && !e.withdrawals?.some((w) => w.participantId === personId));
    return true;
  });
  const selectedExpense = expenseId ? state.expenses.find((e) => e.id === expenseId) : undefined;
  const needsPerson = kind === "leave-trip" || kind === "withdraw" || kind === "join-booking";
  const needsBooking = kind === "withdraw" || kind === "join-booking" || kind === "cancel-booking";
  const needsDate = kind === "leave-trip" || kind === "withdraw" || kind === "cancel-booking";
  const planItems = state.itinerary.filter((i) => i.status !== "cancelled" && i.expenseIds.length === 0);
  const selectedItem = itemId ? state.itinerary.find((i) => i.id === itemId) : undefined;
  const repriceBase = selectedExpense?.amountPaise ?? selectedItem?.estimatedPaise;
  const showsRule = (kind === "leave-trip" || (kind === "withdraw" && selectedExpense && pricingOf(selectedExpense) === "fixed")) && needsPerson;
  const today = todayIso();
  const dateChips = [
    { label: "Today", value: today },
    { label: "In a week", value: addDays(today, 7) },
    { label: "Trip start", value: state.trip.startDate },
  ];
  const closed = state.trip.status === "closed";

  return (
    <>
      <Page className="pb-44">
        <div className="mb-space-xs flex items-center gap-space-xs font-label-md text-label-md uppercase tracking-wider text-primary">
          <Icon name="science" className="text-[16px]" />
          <span>What if…?</span>
        </div>
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Simulate a Change</h2>
        <p className="mt-space-xs font-body-md text-body-md text-on-surface-variant">A simulation on a copy of the trip&apos;s ledger — nothing changes until you apply.</p>
        {closed ? (
          <div className="mt-space-md">
            <Notice tone="amber" icon="lock">
              This trip is closed. Reopen it to apply changes.
            </Notice>
          </div>
        ) : null}

        {stack.length ? (
          <Card className="mt-space-md flex flex-col gap-space-sm rounded-2xl">
            <Eyebrow>Scenario so far</Eyebrow>
            {stack.map((c, i) => (
              <div key={i} className="flex items-center gap-space-sm">
                <Pill tone="ink">{i + 1}</Pill>
                <span className="flex-1 font-body-md text-body-md text-on-surface">{describeChange(state, c)}</span>
                <button aria-label="Remove this change" onClick={() => setStack(stack.filter((_, j) => j !== i))} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-variant">
                  <Icon name="close" className="text-[18px]" />
                </button>
              </div>
            ))}
          </Card>
        ) : null}

        <Card className="mt-space-md flex flex-col gap-space-md rounded-2xl p-space-lg">
          <Eyebrow>{stack.length ? "Then also…" : "The change"}</Eyebrow>
          <div className="grid grid-cols-3 gap-space-sm">
            {KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => {
                  setKind(k.value);
                  setExpenseId(null);
                  setItemId(null);
                  setAmountText("");
                }}
                className={cx(
                  "flex flex-col items-center gap-1 rounded-xl px-space-xs py-space-sm text-center transition-all",
                  kind === k.value ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
                )}
              >
                <Icon name={k.icon} className="text-[22px]" />
                <span className="font-label-md text-label-md leading-tight">{k.label}</span>
              </button>
            ))}
          </div>

          {needsPerson ? (
            <Field label="Who">
              <div className="flex flex-wrap gap-space-sm">
                {members.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPersonId(personId === p.id ? null : p.id)}
                    className={cx(
                      "flex items-center gap-1.5 rounded-full py-1 pl-1 pr-space-md font-label-md text-label-md transition-colors",
                      personId === p.id ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
                    )}
                  >
                    <Face name={p.name} size={26} />
                    {trip.short(p.id)}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}

          {needsBooking ? (
            <Field label="Booking">
              {bookingChoices.length === 0 ? (
                <span className="font-body-md text-on-surface-variant">{personId ? "No bookings to choose for this person." : "No active bookings."}</span>
              ) : (
                <div className="flex flex-wrap gap-space-sm">
                  {bookingChoices.map((e) => (
                    <Chip key={e.id} selected={expenseId === e.id} onClick={() => setExpenseId(expenseId === e.id ? null : e.id)}>
                      {e.title.split(" · ")[0]} · {formatMoney(e.amountPaise)}
                    </Chip>
                  ))}
                </div>
              )}
              {selectedExpense ? (
                <span className="font-label-sm text-label-sm text-on-surface-variant">
                  {pricingOf(selectedExpense) === "per-head" ? "Per-head pricing (each person is a seat)" : "Fixed price (one price for the whole booking)"} · {describePolicy(selectedExpense.cancellationPolicy)}
                </span>
              ) : null}
            </Field>
          ) : null}

          {kind === "reprice" ? (
            <Field label="Which booking or plan item">
              <div className="flex flex-wrap gap-space-sm">
                {activeExpenses.map((e) => (
                  <Chip
                    key={e.id}
                    selected={expenseId === e.id}
                    onClick={() => {
                      setExpenseId(expenseId === e.id ? null : e.id);
                      setItemId(null);
                      setAmountText("");
                    }}
                  >
                    {e.title.split(" · ")[0]} · {formatMoney(e.amountPaise)}
                  </Chip>
                ))}
                {planItems.map((i) => (
                  <Chip
                    key={i.id}
                    selected={itemId === i.id}
                    onClick={() => {
                      setItemId(itemId === i.id ? null : i.id);
                      setExpenseId(null);
                      setAmountText("");
                    }}
                  >
                    {i.title.split(" · ")[0]} · est. {formatMoney(i.estimatedPaise)}
                  </Chip>
                ))}
              </div>
              {repriceBase !== undefined ? (
                <div className="mt-space-sm flex flex-col gap-space-sm">
                  <div className="flex flex-wrap gap-space-sm">
                    {[
                      { label: "+₹5,000", v: repriceBase + 5_000_00 },
                      { label: "+10%", v: Math.round(repriceBase * 1.1) },
                      { label: "−10%", v: Math.round(repriceBase * 0.9) },
                    ].map((q) => (
                      <Chip key={q.label} selected={amountText === String(q.v / 100)} onClick={() => setAmountText(String(q.v / 100))}>
                        {q.label} → {formatMoney(q.v)}
                      </Chip>
                    ))}
                  </div>
                  <AmountField label="New price" value={amountText} onChange={setAmountText} />
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {selectedExpense ? "Already paid: the difference is settled with the vendor by the main payer, and every share re-derives from who is on it." : "Not paid yet: only the plan estimate moves."}
                  </span>
                </div>
              ) : null}
            </Field>
          ) : null}

          {kind === "drop-item" ? (
            <Field label="Unpaid plan items (paid ones are cancelled instead)">
              <div className="flex flex-wrap gap-space-sm">
                {planItems.map((i) => (
                  <Chip key={i.id} selected={itemId === i.id} onClick={() => setItemId(itemId === i.id ? null : i.id)}>
                    {i.title} · est. {formatMoney(i.estimatedPaise)}
                  </Chip>
                ))}
              </div>
            </Field>
          ) : null}

          {needsDate ? (
            <Field label="When">
              <div className="flex flex-wrap gap-space-sm">
                {dateChips.map((c) => (
                  <Chip key={c.label} selected={date === c.value} onClick={() => setDate(c.value)}>
                    {c.label} · {formatDate(c.value)}
                  </Chip>
                ))}
              </div>
              <input className={cx(inputCls, "mt-space-sm")} value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD" aria-label="Date" />
              {!isValidIso(date) ? <span className="font-label-sm text-label-sm text-error">Use YYYY-MM-DD</span> : null}
              {selectedExpense && isValidIso(date) ? (
                <span className="font-label-sm text-label-sm text-on-surface-variant">
                  On {formatDate(date)}: {describeRefundOn(selectedExpense.cancellationPolicy, date)}
                </span>
              ) : null}
            </Field>
          ) : null}

          {showsRule ? (
            <Field label="Fixed-price bookings (villa, cab) cost the same with fewer people. Who carries the leaver's part?">
              <div className="flex flex-wrap gap-space-sm">
                <Chip selected={rule === "redistribute"} onClick={() => setRule("redistribute")}>
                  Others absorb it
                </Chip>
                <Chip selected={rule === "leaver-pays"} onClick={() => setRule("leaver-pays")}>
                  Leaver keeps paying
                </Chip>
              </div>
            </Field>
          ) : null}

          {draft && sim && sim.ok ? (
            <Button
              small
              variant="secondary"
              icon="add"
              onClick={() => {
                setStack([...stack, draft]);
                setPersonId(null);
                setExpenseId(null);
                setItemId(null);
                setAmountText("");
              }}
            >
              Stack another change
            </Button>
          ) : null}
        </Card>

        <div className="mt-space-md">
          {!sim ? (
            <Notice icon="science" title="Pick a change">
              Choose who and what above. The result appears here instantly — computed by the ledger engine on a copy of the trip.
            </Notice>
          ) : !sim.ok ? (
            <Notice tone="coral" icon="block" title="This change isn't possible">
              {sim.error}
            </Notice>
          ) : (
            <Results sim={sim} openPerson={openPerson} setOpenPerson={setOpenPerson} />
          )}
        </div>
      </Page>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/40 bg-surface-container-lowest/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[520px] flex-col gap-1 px-margin py-space-sm">
          {sim && sim.ok ? (
            <span className="text-center font-label-sm text-label-sm text-on-surface-variant">
              Apply writes the {sim.events.length} ledger event{sim.events.length === 1 ? "" : "s"} listed above — exactly what you previewed.
            </span>
          ) : null}
          <Button full icon="check" disabled={!sim || !sim.ok || closed || applying} onClick={() => void apply()}>
            {applying ? "Applying…" : sim && sim.ok ? "Apply to trip" : "Pick a change to simulate"}
          </Button>
        </div>
      </div>
    </>
  );
}

type OkSim = Extract<Simulation, { ok: true }>;

function Results({ sim, openPerson, setOpenPerson }: { sim: OkSim; openPerson: string | null; setOpenPerson: (id: string | null) => void }) {
  const trip = useTrip();
  const { diff } = sim;
  const refunds = refundTotal(diff);
  const moved = diff.people.filter((p) => p.deltaPaise !== 0 || p.shareBefore !== p.shareAfter).sort((a, b) => Math.abs(b.deltaPaise) - Math.abs(a.deltaPaise));
  const still = diff.people.filter((p) => !moved.includes(p));
  const names = buildNameLookup([...trip.events, ...sim.events], trip.meId);
  const settlementsById = new Map(trip.state.settlements.map((s) => [s.id, s]));
  const same = (a: { from: string; to: string; amountPaise: number }, b: { from: string; to: string; amountPaise: number }) => a.from === b.from && a.to === b.to && a.amountPaise === b.amountPaise;

  return (
    <div className="flex flex-col">
      <div className="relative overflow-hidden rounded-2xl bg-surface-container-lowest p-space-lg shadow-sm">
        <div className="pointer-events-none absolute -right-8 -top-8 h-36 w-36 rounded-full bg-primary-fixed/20 blur-2xl" />
        <div className="relative flex items-center justify-between gap-space-sm">
          <Eyebrow>Current vs simulated</Eyebrow>
          <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-label-sm text-label-sm", diff.reconciliationAfter === 0 ? "bg-surface-container-high text-primary" : "bg-error-container text-on-error-container")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", diff.reconciliationAfter === 0 ? "animate-pulse bg-primary" : "bg-error")} />
            Σ = {formatMoney(diff.reconciliationAfter)}
          </span>
        </div>
        <h3 className="relative mt-space-sm font-headline-md text-headline-md text-on-surface">{sim.changes.map((c) => describeChange(sim.before.state, c)).join(" · then ")}</h3>
        <div className="relative mt-space-md grid grid-cols-3 gap-2">
          <Compare label="Trip cost" before={formatMoney(diff.spendBefore)} after={formatMoney(diff.spendAfter)} />
          <Compare label="Refunds back" before="₹0" after={refunds ? formatMoney(refunds) : "₹0"} />
          <Compare label="Payments" before={String(diff.transfersBefore.length)} after={String(diff.transfersAfter.length)} />
        </div>
        <p className="relative mt-space-md flex items-center gap-1 rounded-lg bg-surface-container-low px-space-sm py-1.5 font-label-md text-label-md text-on-surface-variant">
          <Icon name={diff.reconciliationAfter === 0 ? "verified" : "error"} className="text-[16px] text-primary" />
          {diff.affected.length} booking{diff.affected.length === 1 ? "" : "s"} affected · {diff.unaffected.length} unaffected · balances still sum to {formatMoney(diff.reconciliationAfter)}
        </p>
      </div>

      <Propagation sim={sim} />

      <Heading title="What Happens to Each Person" aside={`${moved.length} affected`} />
        <Card className="flex flex-col divide-y divide-outline-variant/40 rounded-2xl py-space-xs">
          {moved.map((p) => (
            <PersonRow key={p.participantId} p={p} open={openPerson === p.participantId} onToggle={() => setOpenPerson(openPerson === p.participantId ? null : p.participantId)} />
          ))}
          {still.length ? <p className="py-space-sm font-label-md text-label-md text-on-surface-variant">No change for {still.map((p) => trip.short(p.participantId)).join(", ")}.</p> : null}
        </Card>

      <Heading title="Bookings" aside={`${diff.affected.length} of ${diff.affected.length + diff.unaffected.length} affected`} />
      <div className="flex flex-col gap-space-sm">
        {diff.affected.map((b) => {
          const cancelled = b.statusAfter === "cancelled" && b.statusBefore === "active";
          return (
            <Card key={b.expenseId} className="flex flex-col gap-space-sm rounded-2xl">
              <div className="flex items-center gap-space-sm">
                <Pill tone={cancelled ? "coral" : "amber"}>{cancelled ? "Cancelled" : "Affected"}</Pill>
                <span className="min-w-0 flex-1 truncate font-title-md text-title-md text-on-surface">{b.title}</span>
                <span className="whitespace-nowrap font-label-md text-label-md text-on-surface-variant">
                  {formatMoney(b.effectiveBefore)} → {formatMoney(b.effectiveAfter)}
                </span>
              </div>
              <p className="font-body-md text-body-md text-on-surface">{b.reason}</p>
              <div className="flex flex-wrap gap-space-sm">
                {b.shares.map((s) => (
                  <div key={s.participantId} className="flex items-center gap-1.5 rounded-lg bg-surface-container-low py-1 pl-1 pr-space-sm">
                    <Face name={trip.fullName(s.participantId)} size={22} />
                    <div>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">{trip.short(s.participantId)}</p>
                    <p className={cx("font-label-md text-label-md", s.after === s.before ? "text-on-surface-variant" : "text-on-surface")}>
                      {s.after === s.before ? formatMoney(s.after) : `${formatMoney(s.before)} → ${formatMoney(s.after)}`}
                    </p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
        {diff.unaffected.length ? (
          <Card tone="soft" className="flex flex-col gap-1 rounded-2xl">
            <Eyebrow>Unaffected</Eyebrow>
            {diff.unaffected.map((u) => (
              <p key={u.expenseId} className="flex items-start gap-1 font-body-md text-body-md text-on-surface-variant">
                <Icon name="check_circle" className="text-[16px] text-primary" />
                <span>
                  <span className="font-semibold text-on-surface">{u.title}</span> — {u.why}
                </span>
              </p>
            ))}
          </Card>
        ) : null}
      </div>

      {diff.refundsAdded.length ? (
        <>
          <Heading title="Refunds: Who Gets the Credit" aside={formatMoney(refunds)} />
          <div className="flex flex-col gap-space-sm">
            {diff.refundsAdded.map((r) => (
              <RefundFlow key={r.id} refundId={r.id} sim={sim} />
            ))}
          </div>
        </>
      ) : null}

      {diff.budget.lines.length || Object.values(diff.budget.perParticipant).some((p) => p.delta !== 0) ? (
        <>
          <Heading title="Plan Estimate" aside={`${formatMoney(diff.budget.beforePaise)} → ${formatMoney(diff.budget.afterPaise)}`} />
          <Card className="flex flex-col gap-1 rounded-2xl">
            <p className="font-body-md text-body-md text-on-surface">
              Estimate {formatMoney(diff.budget.beforePaise)} → {formatMoney(diff.budget.afterPaise)}
            </p>
            {diff.budget.lines.map((l) => (
              <p key={l.itemId} className="font-label-md text-label-md text-on-surface-variant">
                {l.title}: {formatMoney(l.beforePaise)} → {formatMoney(l.afterPaise)} · {l.reason}
              </p>
            ))}
            {Object.entries(diff.budget.perParticipant)
              .filter(([, v]) => v.delta !== 0)
              .map(([id, v]) => (
                <p key={id} className="font-label-md text-label-md text-on-surface-variant">
                  {trip.isMe(id) ? "Your" : `${trip.short(id)}'s`} planned spend {formatMoney(v.before)} → {formatMoney(v.after)}
                </p>
              ))}
          </Card>
        </>
      ) : null}

      <Heading title="Settlement: Current vs Simulated" aside={`${diff.transfersBefore.length} → ${diff.transfersAfter.length}`} />
      <div className="rounded-xl bg-secondary-fixed/40 p-space-md">
        <span className="flex items-center gap-space-xs font-title-md text-title-md text-on-secondary-fixed">
          <Icon name="auto_mode" className="text-[20px]" /> {diff.transfersAfter.length} transfer{diff.transfersAfter.length === 1 ? "" : "s"} after the change
        </span>
        <p className="mt-space-xs font-body-md text-body-md text-on-secondary-fixed-variant">Minimum number of transfers for the new balances, recomputed by the same settlement engine. ● = new or changed.</p>
      </div>
      <Eyebrow className="mt-space-md">Now · {diff.transfersBefore.length}</Eyebrow>
      <div className="mt-space-xs flex flex-col gap-space-xs">
        {diff.transfersBefore.length === 0 ? <p className="font-label-md text-on-surface-variant">Everyone square.</p> : null}
        {diff.transfersBefore.map((t, i) => (
          <TransferLine key={i} from={t.from} to={t.to} amount={t.amountPaise} muted={!diff.transfersAfter.some((x) => same(x, t))} />
        ))}
      </div>
      <Eyebrow className="mt-space-md">After · {diff.transfersAfter.length}</Eyebrow>
      <div className="mt-space-xs flex flex-col gap-space-xs">
        {diff.transfersAfter.length === 0 ? <p className="font-label-md text-on-surface-variant">Everyone square.</p> : null}
        {diff.transfersAfter.map((t, i) => (
          <TransferLine key={i} from={t.from} to={t.to} amount={t.amountPaise} fresh={!diff.transfersBefore.some((x) => same(x, t))} />
        ))}
      </div>

      <Heading title="Ledger Events Apply Will Write" aside={String(sim.events.length)} />
        <Card className="flex flex-col gap-1 rounded-2xl">
          {sim.events.map((e) => (
            <div key={e.id} className="flex gap-space-sm">
              <code className="w-44 shrink-0 truncate text-[11px] text-on-surface-variant">{e.type}</code>
              <span className="font-label-md text-label-md text-on-surface">{describeEvent(e, names, { settlements: settlementsById }).title}</span>
            </div>
          ))}
          <p className="mt-space-xs font-label-sm text-label-sm text-on-surface-variant">Append-only: nothing existing is edited. Every line keeps its actor and timestamp, so this change can always be explained later.</p>
        </Card>
    </div>
  );
}

function Compare({ label, before, after }: { label: string; before: string; after: string }) {
  const changed = before !== after;
  return (
    <div className={cx("flex flex-col gap-0.5 rounded-xl p-3", changed ? "bg-surface-container" : "bg-surface-container-low")}>
      <span className={cx("font-label-sm text-label-sm", changed ? "font-semibold text-primary" : "text-on-surface-variant")}>{label}</span>
      <span className="font-label-sm text-label-sm text-on-surface-variant">Now {before}</span>
      <span className={cx("font-title-md text-title-md", changed ? "font-bold text-primary" : "text-on-surface")}>{after}</span>
    </div>
  );
}

function Heading({ title, aside }: { title: string; aside?: string }) {
  return (
    <div className="mb-space-sm mt-space-lg flex items-center justify-between gap-space-sm">
      <h3 className="font-headline-sm text-headline-sm text-on-surface">{title}</h3>
      {aside ? <span className="shrink-0 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{aside}</span> : null}
    </div>
  );
}

function TransferLine({ from, to, amount, muted, fresh }: { from: string; to: string; amount: number; muted?: boolean; fresh?: boolean }) {
  const trip = useTrip();
  return (
    <div className={cx("flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-space-sm shadow-sm", muted && "opacity-60")}>
      <div className="flex min-w-0 items-center gap-space-sm">
        <FacePair names={[trip.fullName(from), trip.fullName(to)]} size={26} />
        <span className={cx("truncate font-title-md text-title-md text-on-surface", muted && "line-through")}>
          {fresh ? "● " : ""}
          {trip.short(from)} → {trip.short(to)}
        </span>
      </div>
      <span className={cx("shrink-0 font-currency-md text-currency-md", muted ? "text-outline line-through" : "text-on-surface")}>{formatMoney(amount)}</span>
    </div>
  );
}

/** The cascade: one change traced layer by layer through the ledger, every count read off the two states. */
function Propagation({ sim }: { sim: OkSim }) {
  const trip = useTrip();
  const { diff, before, after } = sim;
  const beforeItems = new Map(before.state.itinerary.map((i) => [i.id, i]));
  const afterItems = new Map(after.state.itinerary.map((i) => [i.id, i]));
  const planChanged = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].filter((id) => {
    const a = beforeItems.get(id);
    const b = afterItems.get(id);
    return !a || !b || a.estimatedPaise !== b.estimatedPaise || a.status !== b.status || a.participantIds.join() !== b.participantIds.join();
  });
  const shareChanges = diff.affected.reduce((n, b) => n + b.shares.filter((x) => x.before !== x.after).length, 0);
  const sharePeople = diff.people.filter((p) => p.shareBefore !== p.shareAfter);
  const movers = diff.people.filter((p) => p.deltaPaise !== 0).sort((a, b) => Math.abs(b.deltaPaise) - Math.abs(a.deltaPaise));
  const refund = refundTotal(diff);
  const planTitles = planChanged.map((id) => (afterItems.get(id) ?? beforeItems.get(id))!.title.split(" · ")[0]);
  const settleChanged = JSON.stringify(diff.transfersBefore) !== JSON.stringify(diff.transfersAfter);
  const steps: { icon: string; label: string; value: string; detail: string; live: boolean }[] = [
    { icon: "bolt", label: "Change", value: String(sim.changes.length), detail: sim.changes.map((c) => describeChange(before.state, c)).join(" · then "), live: true },
    { icon: "event_note", label: "Itinerary", value: `${planChanged.length} item${planChanged.length === 1 ? "" : "s"}`, detail: planTitles.length ? planTitles.join(", ") : "plan unchanged", live: planChanged.length > 0 },
    {
      icon: "receipt_long",
      label: "Bookings",
      value: `${diff.affected.length} of ${diff.affected.length + diff.unaffected.length}`,
      detail: diff.affected.length ? diff.affected.map((b) => b.title.split(" · ")[0]).join(", ") : "no paid booking touched",
      live: diff.affected.length > 0,
    },
    { icon: "replay", label: "Refunds", value: refund ? formatMoney(refund) : "₹0", detail: refund ? diff.refundsAdded.map((r) => `${formatMoney(r.amountPaise)} to ${trip.short(r.receivedBy)}`).join(", ") : "vendor returns nothing", live: refund > 0 },
    { icon: "pie_chart", label: "Shares", value: `${shareChanges} re-derived`, detail: sharePeople.length ? `${sharePeople.length} people's share of costs moves` : "nobody's share moves", live: shareChanges > 0 },
    {
      icon: "account_balance_wallet",
      label: "Balances",
      value: `${movers.length} change`,
      detail: movers.length ? movers.slice(0, 3).map((p) => `${trip.short(p.participantId)} ${formatMoney(p.deltaPaise, { signed: true })}`).join(" · ") + (movers.length > 3 ? " …" : "") : "no balance moves",
      live: movers.length > 0,
    },
    { icon: "swap_horiz", label: "Settlement", value: `${diff.transfersBefore.length} → ${diff.transfersAfter.length}`, detail: settleChanged ? "payment plan recomputed" : "same payments", live: settleChanged },
  ];
  return (
    <div className="mt-space-lg">
      <div className="mb-space-md flex items-center justify-between">
        <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">How the Change Propagates</span>
        <span className="font-label-sm text-label-sm font-medium text-primary">
          {steps.filter((x) => x.live).length} of {steps.length} layers move
        </span>
      </div>
      <div className="relative space-y-space-sm pl-6">
        <div className="absolute bottom-4 left-2.5 top-3 w-0.5 -translate-x-1/2 bg-surface-variant" />
        {steps.map((st) => (
          <div key={st.label} className="relative">
            <div className={cx("absolute -left-6 top-3 flex h-5 w-5 items-center justify-center rounded-full shadow-sm", st.live ? "bg-primary text-on-primary" : "bg-surface-container-highest text-outline")}>
              <Icon name={st.icon} className="text-[13px]" />
            </div>
            <div className={cx("rounded-xl p-space-md shadow-sm", st.live ? "bg-surface-container-lowest" : "bg-surface-container-low/60")}>
              <div className="flex items-start justify-between gap-space-xs">
                <p className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{st.label}</p>
                <span className={cx("whitespace-nowrap font-currency-md text-currency-md", st.live ? "font-bold text-primary" : "text-outline")}>{st.value}</span>
              </div>
              <p className={cx("mt-1 font-body-md text-body-md", st.live ? "text-on-surface" : "text-outline")}>{st.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Who paid → who bore the cost → refund → who gets the credit → where it leaves them. */
function RefundFlow({ refundId, sim }: { refundId: string; sim: OkSim }) {
  const trip = useTrip();
  const refund = sim.diff.refundsAdded.find((r) => r.id === refundId)!;
  const before = sim.before.ledger.byExpenseId[refund.expenseId];
  const after = sim.after.ledger.byExpenseId[refund.expenseId];
  if (!before || !after) return null;
  const bore = Object.entries(before.shares).filter(([, v]) => v > 0);
  const credit = Object.keys({ ...before.shares, ...after.shares })
    .map((id) => ({ id, amount: (before.shares[id] ?? 0) - (after.shares[id] ?? 0) }))
    .filter((c) => c.amount > 0);
  const receiver = refund.receivedBy;
  const person = (id: string) => sim.diff.people.find((p) => p.participantId === id);
  const Row = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
    <div className="flex items-start gap-space-sm">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tertiary-container text-[11px] font-bold text-on-tertiary">{n}</span>
      <div className="flex flex-col gap-0.5">
        <span className="font-label-md text-label-md text-on-surface">{title}</span>
        {children}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-space-sm rounded-2xl bg-tertiary-fixed/50 p-space-md">
      <div className="flex items-center gap-space-sm">
        <FacePair names={[trip.fullName(receiver), ...credit.slice(0, 2).map((c) => trip.fullName(c.id))]} size={28} />
        <p className="font-title-md text-title-md text-on-tertiary-fixed">
          {formatMoney(refund.amountPaise)} back on {after.expense.title}
        </p>
      </div>
      <p className="font-label-sm text-label-sm text-on-surface-variant">{refund.reason}</p>
      <Row n={1} title="Who paid the vendor">
        <span className="font-label-md text-label-md text-on-surface-variant">{before.expense.payers.map((p) => `${trip.short(p.participantId)} ${formatMoney(p.amountPaise)}`).join(", ")}</span>
      </Row>
      <Row n={2} title="Who was bearing the cost">
        <span className="font-label-md text-label-md text-on-surface-variant">{bore.map(([id, v]) => `${trip.short(id)} ${formatMoney(v)}`).join(" · ")}</span>
      </Row>
      <Row n={3} title="Refund lands with">
        <span className="font-label-md text-label-md text-on-surface-variant">
          {trip.short(receiver)} (the card that paid) receives {formatMoney(refund.amountPaise)} — money they now hold for the group.
        </span>
      </Row>
      <Row n={4} title="Who gets the credit">
        <span className="font-label-md text-label-md text-on-surface-variant">
          {credit.length ? credit.map((c) => `${trip.short(c.id)} −${formatMoney(c.amount)} share`).join(" · ") : "nobody's share drops"} — the booking now costs {formatMoney(after.effectivePaise)} instead of{" "}
          {formatMoney(before.effectivePaise)}.
        </span>
      </Row>
      <Row n={5} title="Where it leaves them">
        <span className="font-label-md text-label-md text-on-surface-variant">
          {[...new Set([receiver, ...credit.map((c) => c.id)])]
            .map((id) => person(id))
            .filter((p): p is PersonDiff => !!p)
            .map((p) => `${trip.short(p.participantId)} ${formatMoney(p.netBefore, { signed: true })} → ${formatMoney(p.netAfter, { signed: true })}`)
            .join(" · ")}
        </span>
      </Row>
    </div>
  );
}

function PersonRow({ p, open, onToggle }: { p: PersonDiff; open: boolean; onToggle: () => void }) {
  const trip = useTrip();
  const status = (net: number) => (net > 0 ? `is owed ${formatMoney(net)}` : net < 0 ? `owes ${formatMoney(-net)}` : "is square");
  return (
    <div className="py-space-sm">
      <button className="flex w-full items-center gap-space-md text-left" onClick={onToggle} aria-expanded={open}>
        <Face name={trip.fullName(p.participantId)} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-space-xs">
            <span className="font-title-md text-title-md text-on-surface">{trip.short(p.participantId)}</span>
            {p.left ? <span className="rounded bg-error-container px-1.5 font-label-sm text-[10px] font-bold uppercase text-on-error-container">Leaves</span> : null}
          </div>
          <p className="truncate font-label-md text-label-md text-on-surface-variant">
            {status(p.netBefore)} → <span className="text-on-surface">{status(p.netAfter)}</span>
          </p>
        </div>
        <div className="flex flex-col items-end">
          <Money paise={p.deltaPaise} signed tone="auto" />
          <span className="font-label-sm text-label-sm text-on-surface-variant">{open ? "hide" : "why?"}</span>
        </div>
      </button>
      {open ? (
        <div className="mt-space-sm flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-sm">
          <p className="font-body-md text-body-md text-on-surface">{summariseDelta(trip.fullName(p.participantId).split(" ")[0], p.deltaPaise, p.lines)}</p>
          <p className="font-label-sm text-label-sm text-on-surface-variant">
            Share of costs {formatMoney(p.shareBefore)} → {formatMoney(p.shareAfter)}. Positive = better off.
          </p>
          {p.lines.map((l, i) => (
            <div key={i} className="flex items-start justify-between gap-space-sm">
              <div className="min-w-0">
                <p className="font-label-md text-label-md text-on-surface">
                  {l.title}
                  {l.shareBefore !== undefined && l.shareAfter !== undefined ? ` · share ${formatMoney(l.shareBefore)} → ${formatMoney(l.shareAfter)}` : ""}
                </p>
                <p className="font-label-sm text-label-sm text-on-surface-variant">{l.reason}</p>
              </div>
              <Money paise={l.deltaPaise} signed tone="auto" className="text-[14px]" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function SimulatePage() {
  return (
    <Suspense>
      <Simulator />
    </Suspense>
  );
}

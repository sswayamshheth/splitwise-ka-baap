"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Button, Chip, cx, Icon, Pill, useFeedback } from "@/components/app/kit";
import { ExplainBox, ImpactChain, ItemImpact, levelTone, NugenProof, RecommendationCard, SourceBadge, TwinMap, useRealTwin, WeatherStrip, type WorldMode } from "@/components/app/twin/parts";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { InferenceMeta } from "@/lib/nugen/intelligence";
import { EMPTY_SCENARIO, type Scenario } from "@/lib/twin/scenario";
import { primaryPerItem, type Twin } from "@/lib/twin/twin";

/**
 * Digital Twin What-If. The REAL trip (live forecast, real ledger) on one
 * side; a SIMULATED copy with the weather / availability / people changed on
 * the other. The simulation is computed on the server from a copy of the
 * event log — nothing is written. Exit returns to the real state.
 */

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export default function TwinPage() {
  return (
    <Suspense>
      <TwinInner />
    </Suspense>
  );
}

function TwinInner() {
  const trip = useTrip();
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useFeedback();
  const [mode, setMode] = useState<WorldMode>(params.get("mode") === "replay" ? "replay" : "live");
  const real = useRealTwin(trip.tripId, mode);
  const focusItem = params.get("item") ?? undefined;
  const focusDate = trip.state.itinerary.find((i) => i.id === focusItem)?.date;
  const [s, setS] = useState<Scenario>(() => ({ ...EMPTY_SCENARIO, date: focusDate ?? addDays(trip.state.trip.startDate, 1), rainfallMm: 20, stormStartHour: 6, stormHours: 10 }));
  const [sim, setSim] = useState<{ twin: Twin; adaptation: InferenceMeta | null; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nl, setNl] = useState("");
  const [nlMeta, setNlMeta] = useState<{ meta: InferenceMeta; understood: string[] } | null>(null);
  const [judge, setJudge] = useState(false);
  const live = trip.state.itinerary.filter((i) => i.status !== "cancelled");
  const members = trip.state.participants.filter((p) => !p.leftOn);
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = trip.state.trip.startDate; d <= trip.state.trip.endDate; d = addDays(d, 1)) out.push(d);
    return out;
  }, [trip.state.trip.startDate, trip.state.trip.endDate]);

  async function run(next: Scenario, m: WorldMode = mode) {
    setS(next);
    setBusy(true);
    try {
      const res = await api<{ twin: Twin; adaptation: InferenceMeta | null; warnings: string[] }>(`/api/trips/${trip.tripId}/twin`, { body: { scenario: next, mode: m } });
      setSim(res);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function fromText(text: string) {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ scenario: Scenario; understood: string[]; meta: InferenceMeta }>(`/api/trips/${trip.tripId}/twin/scenario`, { body: { text } });
      setNlMeta({ meta: res.meta, understood: res.understood });
      await run({ ...EMPTY_SCENARIO, ...res.scenario });
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  }

  function exit() {
    setSim(null);
    setNlMeta(null);
    if (judge) setMode("live");
    setJudge(false);
    toast("Back to the real trip — the simulation was never saved");
  }

  async function judgeDemo() {
    setJudge(true);
    setMode("replay");
    await run({ ...EMPTY_SCENARIO, label: "Judge demo: heavy rain on day 2", date: addDays(trip.state.trip.startDate, 1), rainfallMm: 100, stormStartHour: 6, stormHours: 10 }, "replay");
  }

  const twin = sim?.twin;
  const realTwin = real.data?.twin;
  const world = real.data?.world;
  const simulated = !!twin && twin.mode === "simulated";
  const shown = simulated ? twin : realTwin;
  const recs = shown ? primaryPerItem(shown.recommendations) : [];
  const f = twin?.finance;

  return (
    <main className="mx-auto w-full max-w-[520px] flex-1 px-margin pb-16 pt-space-md">
      <div className="flex items-center justify-between">
        <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary">Digital Twin · Weather What-If</span>
        <SourceBadge simulated={simulated} replay={world?.mode === "replay"} />
      </div>

      {/* REAL vs SIMULATED banner */}
      <div className={cx("mt-space-sm flex items-start gap-space-sm rounded-xl p-space-md", simulated ? "bg-tertiary-container text-on-tertiary-container" : "bg-primary-container text-on-primary")}>
        <Icon name={simulated ? "science" : "verified"} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-title-md text-title-md">{simulated ? "SIMULATED DIGITAL TWIN" : "REAL TRIP"}</span>
          <span className="font-label-md text-label-md opacity-90">
            {simulated
              ? `${twin!.scenario?.label ?? "Scenario"} — computed on a copy. The real trip still has ${trip.events.length} ledger events and ${formatMoney(trip.ledger.budget.estimatedPaise)} planned.`
              : `${world?.mode === "replay" ? "Recorded (not live) forecast capture" : "Live forecast"} and the real ledger (${trip.events.length} events, ${formatMoney(trip.ledger.budget.estimatedPaise)} planned).`}
          </span>
          {judge ? <span className="mt-1 font-label-sm text-label-sm">JUDGE DEMO MODE · recorded real capture ({world?.capturedAt ? new Date(world.capturedAt).toLocaleString("en-IN") : "—"}) + simulated heavy rain. Not live data.</span> : null}
        </div>
        {simulated ? (
          <Button small variant="secondary" icon="logout" onClick={exit}>
            Exit
          </Button>
        ) : null}
      </div>

      {/* controls */}
      <section className="mt-space-md flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
        <form
          className="flex gap-space-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void fromText(nl);
          }}
        >
          <input value={nl} onChange={(e) => setNl(e.target.value)} placeholder='e.g. "rainfall becomes 100mm on day 2 and three members skip"' className="h-11 min-w-0 flex-1 rounded-lg bg-surface-container-lowest px-space-sm font-body-md text-body-md outline-none ring-1 ring-outline-variant focus:ring-primary" />
          <Button small type="submit" icon="auto_awesome" disabled={busy}>
            Ask
          </Button>
        </form>
        {nlMeta ? (
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {nlMeta.meta.engine === "nugen" ? `GroupTrip Intelligence (${nlMeta.meta.model}) → structured scenario` : `Deterministic parser (${nlMeta.meta.fallbackReason}) understood: ${nlMeta.understood.join(", ") || "nothing"}`}
          </span>
        ) : null}
        <div className="flex flex-wrap gap-space-xs">
          {["Rainfall 20mm on day 2", "Rainfall 100mm on day 2", "Storm lasts another 12 hours, 90mm on day 2", "Temperature 42°C on day 2", "Scuba unavailable", "Three members skip day 2", "Hotel removed"].map((p) => (
            <button key={p} onClick={() => void fromText(p)} className="rounded-full bg-surface-container-lowest px-3 py-1 font-label-sm text-label-sm ring-1 ring-outline-variant hover:bg-surface-container">
              {p}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-label-md text-label-md">Day</span>
          <select value={s.date ?? ""} onChange={(e) => setS({ ...s, date: e.target.value || undefined })} className="h-10 rounded-lg bg-surface-container-lowest px-space-sm ring-1 ring-outline-variant">
            <option value="">Every trip day</option>
            {days.map((d, i) => (
              <option key={d} value={d}>
                Day {i + 1} · {formatDate(d)}
              </option>
            ))}
          </select>
        </label>
        <Slider label="Rainfall" unit="mm" min={0} max={200} value={s.rainfallMm ?? 0} onChange={(v) => setS({ ...s, rainfallMm: v })} hint={(s.rainfallMm ?? 0) >= 115.6 ? "IMD: very heavy" : (s.rainfallMm ?? 0) >= 64.5 ? "IMD: heavy" : (s.rainfallMm ?? 0) >= 15.6 ? "IMD: moderate" : "light / none"} />
        <div className="grid grid-cols-2 gap-space-sm">
          <Slider label="Rain starts" unit=":00" min={0} max={23} value={s.stormStartHour ?? 6} onChange={(v) => setS({ ...s, stormStartHour: v })} />
          <Slider label="Lasts" unit="h" min={1} max={24} value={s.stormHours ?? 10} onChange={(v) => setS({ ...s, stormHours: v })} />
          <Slider label="Storm extends" unit="h" min={0} max={24} value={s.stormExtraHours ?? 0} onChange={(v) => setS({ ...s, stormExtraHours: v || undefined })} />
          <Slider label="Wind" unit="km/h" min={0} max={120} value={s.windKmh ?? 0} onChange={(v) => setS({ ...s, windKmh: v || undefined })} />
        </div>
        <Slider label="Max temperature (0 = keep forecast)" unit="°C" min={0} max={50} value={s.temperatureC ?? 0} onChange={(v) => setS({ ...s, temperatureC: v || undefined })} />
        <label className="flex flex-col gap-1">
          <span className="font-label-md text-label-md">Affected location</span>
          <select
            value={s.area?.kind === "item" ? s.area.itemId : ""}
            onChange={(e) => setS({ ...s, area: e.target.value ? { kind: "item", itemId: e.target.value, radiusKm: 15 } : undefined })}
            className="h-10 rounded-lg bg-surface-container-lowest px-space-sm ring-1 ring-outline-variant"
          >
            <option value="">Whole trip area</option>
            {live.map((i) => (
              <option key={i.id} value={i.id}>
                Within 15 km of {i.title}
              </option>
            ))}
          </select>
        </label>
        <span className="font-label-md text-label-md">Activity unavailable</span>
        <div className="flex flex-wrap gap-space-xs">
          {live
            .filter((i) => i.category !== "Stay")
            .map((i) => (
              <Chip key={i.id} selected={s.unavailableItemIds.includes(i.id)} onClick={() => setS({ ...s, unavailableItemIds: s.unavailableItemIds.includes(i.id) ? s.unavailableItemIds.filter((x) => x !== i.id) : [...s.unavailableItemIds, i.id] })}>
                {i.title.slice(0, 28)}
              </Chip>
            ))}
        </div>
        <span className="font-label-md text-label-md">Members skipping {s.date ? `on ${formatDate(s.date)}` : ""}</span>
        <div className="flex flex-wrap gap-space-xs">
          {members.map((m) => (
            <Chip key={m.id} selected={s.skippingParticipantIds.includes(m.id)} onClick={() => setS({ ...s, skippingParticipantIds: s.skippingParticipantIds.includes(m.id) ? s.skippingParticipantIds.filter((x) => x !== m.id) : [...s.skippingParticipantIds, m.id] })}>
              {trip.short(m.id)}
            </Chip>
          ))}
          <Chip selected={s.hotelRemoved} onClick={() => setS({ ...s, hotelRemoved: !s.hotelRemoved })} icon="hotel">
            Hotel removed
          </Chip>
        </div>
        <div className="flex flex-wrap gap-space-xs">
          <Button icon="science" onClick={() => void run(s)} disabled={busy}>
            {busy ? "Recalculating…" : "Recalculate twin"}
          </Button>
          <Button variant="secondary" icon="wb_sunny" onClick={() => void run({ ...EMPTY_SCENARIO, date: s.date, rainfallMm: 2, stormStartHour: 14, stormHours: 2, label: "Normal weather" })} disabled={busy}>
            Normal weather
          </Button>
          <Button variant="ghost" icon="gavel" onClick={() => void judgeDemo()} disabled={busy}>
            Judge demo
          </Button>
          {mode === "replay" ? (
            <Button
              variant="ghost"
              icon="sensors"
              onClick={() => {
                setMode("live");
                setJudge(false);
                setSim(null);
              }}
            >
              Back to live data
            </Button>
          ) : null}
        </div>
        {sim?.warnings.length ? <span className="font-label-sm text-label-sm text-error">{sim.warnings.join(" · ")}</span> : null}
      </section>

      {real.loading && !real.data ? <p className="mt-space-md font-label-md text-label-md text-on-surface-variant">Loading live weather, places and public signals…</p> : null}
      {real.error ? <p className="mt-space-md font-label-md text-label-md text-error">{real.error}</p> : null}

      {shown && world ? (
        <>
          <section className="mt-space-md flex flex-col gap-space-sm">
            <WeatherStrip twin={shown} world={world} />
            <TwinMap world={world} twin={shown} date={twin?.scenario?.date ?? s.date} focusItemId={focusItem} />
          </section>

          {/* real vs simulated, item by item */}
          <section className="mt-space-md flex flex-col gap-space-xs">
            <span className="font-title-md text-title-md">Itinerary: real vs twin</span>
            {shown.items.map((t) => {
              const r = realTwin?.items.find((x) => x.id === t.id);
              const rec = recs.find((x) => x.forItemId === t.id);
              return (
                <details key={t.id} className="rounded-lg bg-surface-container-lowest p-space-sm shadow-sm" open={t.id === focusItem}>
                  <summary className="flex cursor-pointer items-center justify-between gap-space-xs">
                    <span className="min-w-0 truncate font-label-md text-label-md">
                      {formatDate(t.date)} · {t.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r && simulated ? <Pill tone={levelTone(r.assessment.level)}>real {r.assessment.availability}</Pill> : null}
                      <Pill tone={t.assessment.availability === "unknown" ? "grey" : levelTone(t.assessment.level)}>
                        {simulated ? "twin " : ""}
                        {t.assessment.availability}
                      </Pill>
                    </span>
                  </summary>
                  <div className="mt-space-xs flex flex-col gap-space-xs">
                    <ItemImpact item={t} replay={world.mode === "replay"} />
                    {t.movement.minutesNormal !== null ? (
                      <span className="font-label-sm text-label-sm text-on-surface-variant">
                        Movement: {t.movement.fromStayKm} km from stay · {t.movement.minutesNormal} min normally{t.movement.minutesNow !== t.movement.minutesNormal ? ` → ~${t.movement.minutesNow} min` : ""}
                      </span>
                    ) : null}
                    {rec ? <span className="font-label-md text-label-md text-primary">Twin: {rec.stayIn ? `→ ${rec.stayIn.title}` : rec.kind === "replace" ? `→ ${rec.alternative?.candidate.name}` : `→ ${rec.newDate ? `${rec.newDate}${rec.newTime ? ` ${rec.newTime}` : ""}` : rec.newTime}`}</span> : null}
                  </div>
                </details>
              );
            })}
          </section>

          {shown.effects.length ? (
            <section className="mt-space-md flex flex-col gap-1">
              <span className="font-title-md text-title-md">Direct → cascading → secondary effects</span>
              {shown.effects.map((e) => (
                <span key={e.id} className="font-label-md text-label-md">
                  <Pill tone={e.kind === "direct" ? "coral" : e.kind === "cascading" ? "amber" : "grey"}>{e.kind}</Pill> {e.text}
                </span>
              ))}
            </section>
          ) : (
            <p className="mt-space-md font-body-md text-body-md text-on-surface-variant">No weather effect on the plan in this state.</p>
          )}

          {recs.length ? (
            <section className="mt-space-md flex flex-col gap-space-sm">
              <span className="font-title-md text-title-md">{simulated ? "Simulated itinerary changes" : "Recommendations"}</span>
              {recs.map((r) => (
                <RecommendationCard key={r.id} rec={r} simulated={simulated} />
              ))}
              {recs[0]?.chain.length ? (
                <div className="rounded-xl bg-surface-container-low p-space-md">
                  <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary">Impact chain</span>
                  <ImpactChain steps={recs[0].chain} />
                </div>
              ) : null}
            </section>
          ) : null}

          {simulated && f ? (
            <section className="mt-space-md flex flex-col gap-space-xs rounded-xl bg-surface-container-low p-space-md">
              <span className="font-title-md text-title-md">Booking & cost effects (ledger, simulated)</span>
              {f.ok ? (
                <>
                  {f.lines.map((l, i) => (
                    <span key={i} className="font-label-md text-label-md">
                      • {l}
                    </span>
                  ))}
                  <span className="font-label-md text-label-md">
                    Planned {formatMoney(f.plannedBefore)} → <b>{formatMoney(f.plannedAfter)}</b> · Spend {formatMoney(f.spendBefore)} → <b>{formatMoney(f.spendAfter)}</b>
                  </span>
                  {f.refunds.map((r, i) => (
                    <span key={i} className="font-label-md text-label-md text-primary">
                      Vendor refund {formatMoney(r.amountPaise)} → {r.to} ({r.expense})
                    </span>
                  ))}
                  {f.people.map((p) => (
                    <span key={p.id} className="font-label-md text-label-md">
                      {p.name}: {formatMoney(p.before, { signed: true })} → {formatMoney(p.after, { signed: true })} ({formatMoney(p.delta, { signed: true })})
                    </span>
                  ))}
                  <span className="font-label-sm text-[11px] text-on-surface-variant">Computed by the ledger&apos;s simulate() on a copy of the event log. Real trip unchanged.</span>
                </>
              ) : (
                <span className="text-error">{f.error}</span>
              )}
            </section>
          ) : null}

          <section className="mt-space-md flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
            <span className="font-title-md text-title-md">Ask why</span>
            <ExplainBox scenario={simulated ? twin!.scenario : null} mode={mode} itemId={recs[0]?.forItemId} />
          </section>

          <section className="mt-space-md">
            <NugenProof meta={(simulated ? sim?.adaptation : real.data?.adaptation) ?? nlMeta?.meta ?? null} task={nlMeta ? "What-If → scenario + weather adaptation" : "Weather adaptation"} />
          </section>
        </>
      ) : null}
      <div className="mt-space-lg">
        <Button variant="ghost" icon="arrow_back" onClick={() => router.push(`/trips/${trip.tripId}/plan`)}>
          Back to the plan
        </Button>
      </div>
    </main>
  );
}

function Slider({ label, unit, min, max, value, onChange, hint }: { label: string; unit: string; min: number; max: number; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between font-label-md text-label-md">
        <span>{label}</span>
        <span className="tabular-nums text-primary">
          {value}
          {unit} {hint ? <span className="text-on-surface-variant">· {hint}</span> : null}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[#006a6a]" />
    </label>
  );
}

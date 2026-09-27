"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Button, cx, Icon, Pill, useFeedback } from "@/components/app/kit";
import { buildAll } from "@/components/app/money/build";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { InferenceMeta } from "@/lib/nugen/intelligence";
import type { Scenario } from "@/lib/twin/scenario";
import type { Recommendation, Twin, TwinItem, TwinWorld } from "@/lib/twin/twin";
import { describeWeatherCode } from "@/lib/weather/openmeteo";

export const TwinMap = dynamic(() => import("./TwinMap"), { ssr: false, loading: () => <div className="h-[320px] animate-pulse rounded-xl bg-surface-container" /> });

export type WorldMode = "live" | "replay";
export type TwinPayload = { world: TwinWorld; twin: Twin; adaptation: InferenceMeta | null };

/** Loads the REAL twin (live inputs, no scenario). */
export function useRealTwin(tripId: string, mode: WorldMode) {
  const [data, setData] = useState<TwinPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        setData(await api<TwinPayload>(`/api/trips/${tripId}/twin?mode=${mode}${refresh ? "&refresh=1" : ""}`));
      } catch (e) {
        setError(errorText(e, "Could not load weather intelligence"));
      } finally {
        setLoading(false);
      }
    },
    [tripId, mode],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

export function levelTone(level: string): "coral" | "amber" | "teal" {
  return level === "High" ? "coral" : level === "Medium" ? "amber" : "teal";
}

export function SourceBadge({ simulated, replay }: { simulated?: boolean; replay?: boolean }) {
  if (simulated) return <Pill tone="lavender" icon="science">SIMULATED</Pill>;
  if (replay) return <Pill tone="ink" icon="history">RECORDED REAL DATA</Pill>;
  return <Pill tone="teal" icon="sensors">LIVE</Pill>;
}

/** The trip days' weather at the destination (real forecast or the twin's simulated days). */
export function WeatherStrip({ twin, world }: { twin: Twin; world: TwinWorld }) {
  const f = world.forecasts[0]?.forecast;
  return (
    <div className="-mx-space-md flex gap-space-xs overflow-x-auto px-space-md pb-1">
      {f?.current ? (
        <div className="flex min-w-[92px] flex-col rounded-lg bg-surface-container-lowest p-space-xs text-center ring-1 ring-outline-variant/40">
          <span className="font-label-sm text-[10px] uppercase text-primary">Now</span>
          <span className="font-title-md text-title-md">{Math.round(f.current.temperatureC)}°</span>
          <span className="truncate font-label-sm text-[10px] text-on-surface-variant">{describeWeatherCode(f.current.weatherCode)}</span>
        </div>
      ) : null}
      {twin.days.map((d) => {
        const item = twin.items.find((t) => t.date === d && t.conditions.day && t.conditions.forecastKey === world.forecasts[0]?.key) ?? twin.items.find((t) => t.date === d && t.conditions.day);
        const day = item?.conditions.day ?? f?.daily.find((x) => x.date === d) ?? null;
        const sim = item?.conditions.source === "simulated";
        return (
          <div key={d} className={cx("flex min-w-[92px] flex-col rounded-lg p-space-xs text-center", sim ? "bg-tertiary-fixed/60 ring-1 ring-tertiary" : "bg-surface-container-lowest ring-1 ring-outline-variant/40")}>
            <span className="font-label-sm text-[10px] uppercase text-on-surface-variant">{formatDate(d)}</span>
            {day ? (
              <>
                <span className="font-title-md text-title-md">{day.precipitationMm.toFixed(0)} mm</span>
                <span className="font-label-sm text-[10px] text-on-surface-variant">
                  {Math.round(day.tempMaxC)}° · {day.precipitationProbability ?? "–"}%
                </span>
                {sim ? <span className="font-label-sm text-[9px] font-bold text-tertiary">SIMULATED</span> : null}
              </>
            ) : (
              <span className="py-1 font-label-sm text-[10px] text-on-surface-variant">beyond 16-day forecast</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ScoreBar({ value, label, detail }: { value: number; label: string; detail: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between font-label-sm text-label-sm">
        <span className="text-on-surface">{label}</span>
        <span className="tabular-nums text-on-surface-variant">{value < 0 ? "no data" : `${value}/100`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, value)}%` }} />
      </div>
      <span className="font-label-sm text-[11px] text-on-surface-variant">{detail}</span>
    </div>
  );
}

export function ImpactChain({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-space-xs font-label-md text-label-md text-on-surface">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-container font-label-sm text-[10px] text-on-primary">{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function ItemImpact({ item }: { item: TwinItem }) {
  const a = item.assessment;
  return (
    <div className="flex flex-col gap-space-xs">
      <div className="flex flex-wrap items-center gap-space-xs">
        <Pill tone={levelTone(a.level)} icon="warning">
          Impact {a.impactScore}/100 · {a.level}
        </Pill>
        <Pill tone="grey">{a.availability}</Pill>
        <Pill tone="grey">confidence {Math.round(a.confidence * 100)}%</Pill>
        <SourceBadge simulated={item.conditions.source === "simulated"} />
      </div>
      {a.components.map((c) => (
        <ScoreBar key={c.label} value={c.value} label={c.label} detail={c.detail} />
      ))}
      {item.slots.length ? (
        <div className="flex flex-col gap-1">
          <span className="font-label-sm text-label-sm text-on-surface-variant">Across the day (hourly forecast)</span>
          <div className="flex gap-0.5">
            {item.slots.map((s) => (
              <div key={s.start} title={`${s.start}:00–${s.end}:00 · ${s.mm} mm · suitability ${s.suitability}`} className="flex flex-1 flex-col items-center">
                <div className="w-full rounded-sm" style={{ height: 28, background: s.hazard >= 0.75 ? "#ba1a1a" : s.hazard >= 0.4 ? "#e8a33d" : "#6fbfae", opacity: s.start === a.window[0] ? 1 : 0.75 }} />
                <span className="font-label-sm text-[9px] text-on-surface-variant">{s.start}</span>
              </div>
            ))}
          </div>
          {item.bestSlot ? (
            <span className="font-label-sm text-label-sm text-primary">
              {a.window[0]}:00 is risky → {item.bestSlot.start}:00 looks viable (suitability {item.bestSlot.suitability})
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Applies a recommendation to the REAL trip — only after the user confirms, via the ledger's validated commands. */
export function useAccept() {
  const trip = useTrip();
  const { toast, confirm } = useFeedback();
  return async (r: Recommendation, onDone?: () => void) => {
    if (!r.changes.length) {
      toast("This one needs the vendor to confirm — nothing to change in the ledger", "error");
      return;
    }
    const money = r.finance?.ok ? [...r.finance.refunds.map((x) => `refund ${formatMoney(x.amountPaise)} to ${x.to}`), r.finance.plannedAfter !== r.finance.plannedBefore ? `plan ${formatMoney(r.finance.plannedAfter - r.finance.plannedBefore, { signed: true })}` : ""].filter(Boolean).join(" · ") : "";
    const ok = await confirm({
      title: "Change the real itinerary?",
      message: `${r.finance?.lines.join(" · ") ?? ""}${money ? ` — ${money}` : ""}. This writes to the trip ledger for everyone.`,
      confirm: "Apply to trip",
    });
    if (!ok) return;
    try {
      await trip.run((s, ctx) => buildAll(s, r.changes, ctx));
      toast("Applied · every share re-derived by the ledger");
      onDone?.();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
}

export function RecommendationCard({ rec, onAccept, onDismiss, onSimulate, onWhy, simulated }: { rec: Recommendation; onAccept?: () => void; onDismiss?: () => void; onSimulate?: () => void; onWhy?: () => void; simulated?: boolean }) {
  const [open, setOpen] = useState(false);
  const alt = rec.alternative;
  return (
    <div className={cx("flex flex-col gap-space-sm rounded-xl p-space-md", simulated ? "bg-tertiary-fixed/40 ring-1 ring-tertiary/40" : "bg-surface-container-lowest shadow-sm")}>
      <div className="flex items-start justify-between gap-space-sm">
        <div className="flex min-w-0 flex-col">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-primary">{rec.kind === "replace" ? `Instead of ${rec.forTitle}` : `Reschedule ${rec.forTitle}`}</span>
          <span className="font-headline-sm text-headline-sm text-on-surface">{alt ? alt.candidate.name : `Move to ${rec.newTime}`}</span>
          {alt ? (
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {alt.candidate.kind.replace(/_/g, " ")} · {alt.distanceKm} km · {alt.candidate.indoor ? "indoor" : "outdoor"} · est. {formatMoney(alt.estTotalPaise)} ({alt.candidate.estimateBasis})
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-currency-md text-currency-md text-primary">{rec.score}</span>
          <span className="font-label-sm text-[10px] text-on-surface-variant">match score</span>
          <Pill tone={rec.chosenBy === "nugen" ? "lavender" : "grey"} icon={rec.chosenBy === "nugen" ? "auto_awesome" : "calculate"}>
            {rec.chosenBy === "nugen" ? "Nugen pick" : "Engine pick"}
          </Pill>
        </div>
      </div>
      <p className="font-body-md text-body-md text-on-surface">{rec.rationale}</p>
      <div className="flex flex-col gap-1 rounded-lg bg-surface-container-low p-space-sm">
        <span className="font-label-sm text-label-sm font-semibold text-on-surface">Why this? — evidence</span>
        {rec.evidence.map((e, i) => (
          <span key={i} className="flex items-start gap-1.5 font-label-sm text-label-sm text-on-surface-variant">
            <Icon name={e.icon} className="text-[16px] text-primary" />
            <span>
              <b className="text-on-surface">{e.label}:</b> {e.text} {e.source ? <span className="opacity-70">· {e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="underline">{e.source}</a> : e.source}</span> : null}
            </span>
          </span>
        ))}
      </div>
      {open ? (
        <div className="flex flex-col gap-space-sm">
          <span className="font-label-sm text-label-sm font-semibold">Score breakdown (weather + public signals + preferences + constraints + itinerary)</span>
          {rec.breakdown.map((b) => (
            <ScoreBar key={b.label} value={b.value} label={b.label} detail={b.detail} />
          ))}
          <span className="font-label-sm text-label-sm font-semibold">Impact chain</span>
          <ImpactChain steps={rec.chain} />
          {rec.finance?.ok && rec.finance.people.length ? (
            <span className="font-label-sm text-label-sm text-on-surface-variant">Balances (ledger): {rec.finance.people.map((p) => `${p.name} ${formatMoney(p.delta, { signed: true })}`).join(" · ")}</span>
          ) : null}
          {rec.finance && !rec.finance.ok ? <span className="font-label-sm text-label-sm text-error">Ledger: {rec.finance.error}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-space-xs">
        <Button small variant="ghost" icon={open ? "expand_less" : "account_tree"} onClick={() => setOpen(!open)}>
          {open ? "Less" : "View impact"}
        </Button>
        {onWhy ? (
          <Button small variant="ghost" icon="help" onClick={onWhy}>
            Why?
          </Button>
        ) : null}
        {onSimulate ? (
          <Button small variant="secondary" icon="science" onClick={onSimulate}>
            Simulate
          </Button>
        ) : null}
        {onAccept ? (
          <Button small icon="check" onClick={onAccept} disabled={!rec.changes.length}>
            Accept
          </Button>
        ) : null}
        {onDismiss ? (
          <Button small variant="ghost" icon="close" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Judge-facing: what the Nugen pipeline actually is right now, and what the last inference was. */
export function NugenProof({ meta, task }: { meta: InferenceMeta | null; task: string }) {
  const [status, setStatus] = useState<{ configured: boolean; baseModel: string; alignedModelId: string | null; alignmentId: string | null; stage: string; alignment: Record<string, unknown> | null } | null>(null);
  useEffect(() => {
    api<typeof status>("/api/nugen/status").then(setStatus, () => setStatus(null));
  }, []);
  const stage = status?.stage ?? "…";
  const step = (label: string, value: string, ok: boolean) => (
    <div className="flex items-start gap-space-xs">
      <Icon name={ok ? "check_circle" : "radio_button_unchecked"} className={cx("text-[18px]", ok ? "text-primary" : "text-on-surface-variant")} />
      <span className="font-label-md text-label-md">
        <b>{label}</b> — {value}
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-space-xs rounded-xl bg-inverse-surface p-space-md text-inverse-on-surface">
      <span className="font-label-sm text-label-sm uppercase tracking-widest opacity-80">Nugen proof panel</span>
      {step("Base model", status?.baseModel ?? "…", !!status)}
      {step("Nugen alignment", status?.alignmentId ? `project ${status.alignmentId}${status.alignment ? ` · ${String(status.alignment.status ?? JSON.stringify(status.alignment)).slice(0, 60)}` : ""}` : "not run yet — needs NUGEN_API_KEY (scripts/nugen/align.ts)", !!status?.alignmentId)}
      {step("GroupTrip Intelligence", status?.alignedModelId ? `aligned model ${status.alignedModelId}` : stage === "base-model-only" ? "base model only (no aligned id yet)" : "not deployed", !!status?.alignedModelId)}
      {step(
        "Current inference",
        meta ? `${task} · ${meta.engine === "nugen" ? `Nugen ${meta.model}${meta.aligned ? " (aligned)" : " (base)"}${meta.confidenceScore != null ? ` · confidence ${meta.confidenceScore}` : ""}` : `deterministic engine (${meta.fallbackReason ?? "fallback"})`}` : `${task} · no AI step needed`,
        meta?.engine === "nugen",
      )}
      {meta ? <span className="font-label-sm text-[11px] opacity-80">Inputs: {meta.inputs.join(" + ")}{meta.repaired?.length ? ` · repaired: ${meta.repaired.join("; ")}` : ""}</span> : null}
      <span className="font-label-sm text-[11px] opacity-70">Money, shares, refunds and availability are always computed by the deterministic engine; the model only chooses among validated options and explains.</span>
    </div>
  );
}

/** "Why did you recommend this?" — answered from the twin's facts by GroupTrip Intelligence (or the grounded fallback). */
export function ExplainBox({ scenario, itemId, mode, presets }: { scenario: Scenario | null; itemId?: string; mode: WorldMode; presets?: string[] }) {
  const trip = useTrip();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ answer: string; meta: InferenceMeta } | null>(null);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setQ(question);
    setBusy(true);
    try {
      setRes(await api(`/api/trips/${trip.tripId}/twin/explain`, { body: { question, scenario, itemId, mode } }));
    } catch (e) {
      setRes({ answer: errorText(e), meta: { task: "explanation", engine: "deterministic", inputs: [] } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-space-sm">
      <div className="flex flex-wrap gap-space-xs">
        {(presets ?? ["Why did you recommend this?", "Why was this activity removed?", "Why did my cost change?", "Why is this better?"]).map((p) => (
          <button key={p} onClick={() => void ask(p)} className="rounded-full bg-surface-container px-3 py-1 font-label-sm text-label-sm text-on-surface hover:bg-surface-container-high">
            {p}
          </button>
        ))}
      </div>
      <form
        className="flex gap-space-xs"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask GroupTrip Intelligence…" className="h-10 min-w-0 flex-1 rounded-lg bg-surface-container-low px-space-sm font-body-md text-body-md outline-none ring-1 ring-outline-variant focus:ring-primary" />
        <Button small type="submit" icon="send" disabled={busy}>
          {busy ? "…" : "Ask"}
        </Button>
      </form>
      {res ? (
        <div className="flex flex-col gap-1 rounded-lg bg-tertiary-fixed/50 p-space-sm">
          <span className="font-body-md text-body-md text-on-surface">{res.answer}</span>
          <span className="font-label-sm text-[11px] text-on-surface-variant">
            {res.meta.engine === "nugen" ? `GroupTrip Intelligence · ${res.meta.model}` : `Grounded deterministic explanation (${res.meta.fallbackReason ?? "fallback"})`} · every number comes from the twin / ledger
          </span>
        </div>
      ) : null}
    </div>
  );
}

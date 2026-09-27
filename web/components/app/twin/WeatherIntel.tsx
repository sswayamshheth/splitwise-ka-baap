"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, cx, Icon, Pill, Sheet } from "@/components/app/kit";
import { useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { primaryPerItem } from "@/lib/twin/twin";
import { ExplainBox, ItemImpact, levelTone, NugenProof, RecommendationCard, SourceBadge, TwinMap, useAccept, useRealTwin, WeatherStrip } from "./parts";

/**
 * Weather Intelligence — the Plan tab's entry point into the Digital Twin.
 * Live forecast + public signals → impact on the REAL plan → recommended
 * alternatives. Nothing changes until the user accepts a card.
 */
export function WeatherIntel() {
  const trip = useTrip();
  const router = useRouter();
  const { data, error, loading, reload } = useRealTwin(trip.tripId, "live");
  const accept = useAccept();
  const [sheet, setSheet] = useState<"impact" | "map" | "signals" | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setDismissed(new Set(JSON.parse(localStorage.getItem(`twin-dismissed:${trip.tripId}`) ?? "[]")));
    } catch {
      /* per-viewer convenience only */
    }
  }, [trip.tripId]);
  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      localStorage.setItem(`twin-dismissed:${trip.tripId}`, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };
  const recs = useMemo(() => (data ? primaryPerItem(data.twin.recommendations).filter((r) => !dismissed.has(r.id)) : []), [data, dismissed]);

  if (loading && !data) {
    return (
      <div className="mt-space-sm flex items-center gap-space-md rounded-xl bg-surface-container-low p-space-md">
        <Icon name="cloud_sync" className="animate-pulse text-primary" />
        <span className="font-label-md text-label-md text-on-surface-variant">Loading live weather, places and public signals for {trip.state.trip.destination.split(",")[0]}…</span>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mt-space-sm flex items-center gap-space-md rounded-xl bg-error-container/40 p-space-md">
        <Icon name="cloud_off" className="text-error" />
        <span className="flex-1 font-label-md text-label-md text-on-surface">Weather intelligence unavailable: {error}. Nothing is guessed — </span>
        <Button small variant="ghost" onClick={() => void reload()}>
          Retry
        </Button>
      </div>
    );
  }

  const { twin, world, adaptation } = data;
  const h = twin.headline;
  const focus = h.itemId ? twin.items.find((t) => t.id === h.itemId) : undefined;
  const affected = twin.items.filter((t) => t.assessment.availability === "unavailable" || t.assessment.availability === "at-risk");
  const signals = world.signals.slice(0, 6);
  const simulate = (itemId?: string) => router.push(`/trips/${trip.tripId}/twin${itemId ? `?item=${itemId}` : ""}`);

  return (
    <section className="mt-space-sm flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
      <div className="flex items-center justify-between gap-space-sm">
        <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-widest text-primary">
          <Icon name="thunderstorm" className="text-[18px]" /> Weather intelligence
        </span>
        <span className="flex items-center gap-1">
          <SourceBadge replay={world.mode === "replay"} />
          <button onClick={() => void reload(true)} aria-label="Refresh" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-container">
            <Icon name="refresh" className={cx("text-[18px]", loading && "animate-spin")} />
          </button>
        </span>
      </div>

      <div className={cx("flex items-start gap-space-sm rounded-lg p-space-sm", h.normal ? "bg-primary-fixed/40" : h.level === "High" ? "bg-error-container/60" : "bg-secondary-fixed/60")}>
        <Icon name={h.normal ? "partly_cloudy_day" : "rainy_heavy"} className="mt-0.5" />
        <div className="flex min-w-0 flex-col">
          <span className="font-title-md text-title-md text-on-surface">{h.title}</span>
          <span className="font-label-md text-label-md text-on-surface-variant">{h.detail}</span>
          {focus ? <span className="font-label-sm text-label-sm text-on-surface-variant">Confidence {Math.round(focus.assessment.confidence * 100)}% · {focus.assessment.drivers.join(" · ")}</span> : null}
        </div>
      </div>

      <WeatherStrip twin={twin} world={world} />
      <span className="font-label-sm text-[11px] text-on-surface-variant">
        {world.weatherNote} · updated {new Date(world.fetchedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </span>

      {affected.length ? (
        <div className="flex flex-wrap gap-space-xs">
          {affected.map((t) => (
            <Pill key={t.id} tone={levelTone(t.assessment.level)} icon="warning">
              {t.title} · {t.assessment.impactScore}
            </Pill>
          ))}
        </div>
      ) : null}

      {signals.length ? (
        <button onClick={() => setSheet("signals")} className="flex items-center gap-space-xs rounded-lg bg-surface-container-lowest p-space-sm text-left">
          <Icon name="forum" className="text-primary" />
          <span className="min-w-0 flex-1 truncate font-label-md text-label-md text-on-surface">
            {signals.length} public signal{signals.length === 1 ? "" : "s"}: {signals[0].summary}
          </span>
          <Icon name="chevron_right" />
        </button>
      ) : null}

      {recs.map((r) => (
        <RecommendationCard key={r.id} rec={r} onAccept={() => void accept(r, () => void reload(true))} onDismiss={() => dismiss(r.id)} onSimulate={() => simulate(r.forItemId)} onWhy={() => setWhy(r.forItemId)} />
      ))}

      <div className="flex flex-wrap gap-space-xs">
        <Button small variant="secondary" icon="account_tree" onClick={() => setSheet("impact")}>
          View impact
        </Button>
        <Button small variant="secondary" icon="map" onClick={() => setSheet("map")}>
          View map
        </Button>
        <Button small icon="science" onClick={() => simulate(h.itemId)}>
          Weather What-If
        </Button>
      </div>

      <Sheet open={sheet === "map"} onClose={() => setSheet(null)} title="Trip weather map">
        <TwinMap world={world} twin={twin} focusItemId={h.itemId} height={380} />
      </Sheet>
      <Sheet open={sheet === "impact"} onClose={() => setSheet(null)} title="Weather impact on the real plan">
        <div className="flex flex-col gap-space-md">
          {twin.items
            .filter((t) => t.assessment.availability !== "unknown")
            .sort((a, b) => b.assessment.impactScore - a.assessment.impactScore)
            .map((t) => (
              <div key={t.id} className="flex flex-col gap-space-xs border-b border-outline-variant/40 pb-space-sm">
                <span className="font-title-md text-title-md">
                  {t.title} <span className="font-label-sm text-label-sm text-on-surface-variant">· {formatDate(t.date)}</span>
                </span>
                <ItemImpact item={t} />
              </div>
            ))}
          {twin.effects.length ? (
            <div className="flex flex-col gap-1">
              <span className="font-title-md text-title-md">Direct, cascading & secondary effects</span>
              {twin.effects.map((e) => (
                <span key={e.id} className="font-label-md text-label-md">
                  <Pill tone={e.kind === "direct" ? "coral" : e.kind === "cascading" ? "amber" : "grey"}>{e.kind}</Pill> {e.text}
                </span>
              ))}
            </div>
          ) : (
            <span className="font-body-md text-body-md text-on-surface-variant">No weather effect on the real plan in the forecast window.</span>
          )}
          <NugenProof meta={adaptation} task="Weather adaptation" />
        </div>
      </Sheet>
      <Sheet open={sheet === "signals"} onClose={() => setSheet(null)} title="Public & social signals">
        <div className="flex flex-col gap-space-sm">
          {world.signals.map((s) => (
            <div key={s.id} className="flex flex-col gap-0.5 rounded-lg bg-surface-container-low p-space-sm">
              <span className="font-label-sm text-label-sm uppercase text-primary">
                {s.source} · {s.kind}
                {s.timestamp ? ` · ${new Date(s.timestamp).toISOString().slice(0, 10)}` : ""}
              </span>
              <span className="font-body-md text-body-md">{s.summary}</span>
              <span className="font-label-sm text-[11px] text-on-surface-variant">
                {s.location.name} · relevance {s.relevance} · confidence {s.confidence}
                {s.sentiment !== undefined ? ` · sentiment ${s.sentiment}` : ""}
                {s.url ? (
                  <>
                    {" · "}
                    <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  </>
                ) : null}
              </span>
            </div>
          ))}
          <span className="font-title-md text-title-md">Providers</span>
          {world.providers.map((p) => (
            <span key={p.source} className="flex items-start gap-1 font-label-md text-label-md">
              <Icon name={p.ok ? "check_circle" : p.configured ? "error" : "key_off"} className={cx("text-[16px]", p.ok ? "text-primary" : "text-error")} />
              <span>
                <b>{p.source}</b> — {p.note}
              </span>
            </span>
          ))}
        </div>
      </Sheet>
      <Sheet open={!!why} onClose={() => setWhy(null)} title="Ask GroupTrip Intelligence">
        <ExplainBox scenario={null} itemId={why ?? undefined} mode="live" />
      </Sheet>
    </section>
  );
}

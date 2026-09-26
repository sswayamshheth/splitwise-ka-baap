"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { useTrip } from "@/lib/client/trip";
import { computeHarmony } from "@/lib/interests";
import { Portrait } from "./common";

/**
 * Harmony Score: how well this trip suits everyone, from members' travel
 * preferences and the itinerary. Deterministic (lib/interests.ts) — shared
 * interests, conflicts and per-person swaps all come from the same inputs.
 */
export function HarmonyCard() {
  const trip = useTrip();
  const { state } = trip;
  const [open, setOpen] = useState<string | null>(null);
  const h = useMemo(
    () =>
      computeHarmony(
        state.participants.filter((p) => !p.leftOn).map((p) => ({ id: p.id, name: p.name, interests: p.interests })),
        state.itinerary.filter((i) => i.status !== "cancelled").map((i) => ({ id: i.id, title: i.title, category: i.category, vendor: i.vendor, participantIds: i.participantIds })),
      ),
    [state],
  );

  const score = h.score;
  const pct = score ?? 0;
  const R = 34;
  const C = 2 * Math.PI * R;
  const ringTone = score === null ? "text-outline-variant" : score >= 75 ? "text-primary" : score >= 55 ? "text-primary-container" : score >= 35 ? "text-secondary-container" : "text-error";

  return (
    <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-wider text-primary">
          <Icon name="diversity_3" className="text-[16px]" /> Harmony score
        </span>
        <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
          {h.coverage.withPrefs} of {h.coverage.total} shared preferences
        </span>
      </div>

      <div className="flex items-center gap-space-lg">
        <div className="relative h-24 w-24 shrink-0">
          <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
            <circle cx="40" cy="40" r={R} fill="none" strokeWidth="8" className="stroke-surface-container-high" />
            <circle
              cx="40"
              cy="40"
              r={R}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              stroke="currentColor"
              className={cx("transition-all duration-700", ringTone)}
              strokeDasharray={C}
              strokeDashoffset={C - (C * pct) / 100}
            />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-currency-display text-[26px] leading-none text-on-surface">{score ?? "—"}</span>
            <span className="font-label-sm text-[10px] text-on-surface-variant">/ 100</span>
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-headline-sm text-headline-sm text-on-surface">{h.label}</span>
          {score === null ? (
            <span className="font-body-md text-body-md text-on-surface-variant">Add travel preferences in your Profile to see how well this trip suits everyone.</span>
          ) : (
            <span className="font-body-md text-body-md text-on-surface-variant">
              {h.groupSimilarity !== null ? `Tastes ${Math.round(h.groupSimilarity * 100)}% alike` : "Tastes not compared yet"}
              {h.itineraryFit !== null ? ` · itinerary fits ${Math.round(h.itineraryFit * 100)}%` : ""}
            </span>
          )}
        </div>
      </div>

      {h.sharedInterests.length ? (
        <div className="flex flex-wrap gap-space-xs">
          {h.sharedInterests.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-primary-fixed/50 px-2.5 py-1 font-label-md text-label-md text-on-primary-fixed-variant">
              {s.label}
              <span className="text-[10px] opacity-70">×{s.count}</span>
            </span>
          ))}
        </div>
      ) : null}

      {h.conflicts.map((c) => (
        <div key={c} className="flex gap-space-sm rounded-lg bg-secondary-fixed/40 px-space-md py-space-sm">
          <Icon name="lightbulb" className="text-[18px] text-on-secondary-fixed-variant" />
          <span className="font-body-md text-body-md text-on-secondary-fixed">{c}</span>
        </div>
      ))}

      {h.perMember.some((m) => m.hasPrefs) ? (
        <div className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Personal variations</span>
          {h.perMember.map((m) => {
            const expanded = open === m.id;
            return (
              <div key={m.id} className="rounded-lg bg-surface-container-low/70">
                <button onClick={() => setOpen(expanded ? null : m.id)} className="flex w-full items-center gap-space-sm px-space-sm py-space-sm text-left" aria-expanded={expanded}>
                  <Portrait name={m.name} size={32} />
                  <span className="min-w-0 flex-1 truncate font-title-md text-[15px] text-on-surface">{trip.isMe(m.id) ? "You" : m.name.split(" ")[0]}</span>
                  <span className="font-label-md text-label-md text-on-surface-variant">
                    {!m.hasPrefs ? "No preferences" : m.fit === null ? "—" : `${Math.round(m.fit * 100)}% fit`}
                  </span>
                  {m.variations.length ? <span className="rounded-full bg-secondary-fixed px-1.5 text-[10px] font-semibold text-on-secondary-fixed">{m.variations.length}</span> : null}
                  <Icon name={expanded ? "expand_less" : "expand_more"} className="text-[20px] text-on-surface-variant" />
                </button>
                {expanded ? (
                  <div className="flex flex-col gap-space-xs px-space-sm pb-space-sm">
                    {m.variations.length ? (
                      m.variations.map((v) => (
                        <div key={v.itemId} className="rounded-lg bg-surface-container-lowest px-space-md py-space-sm">
                          <span className="font-title-md text-[14px] text-on-surface">{v.itemTitle}</span>
                          <p className="font-label-md text-label-md text-on-surface-variant">{v.reason}</p>
                          <p className="flex items-center gap-1 font-label-md text-label-md text-primary">
                            <Icon name="swap_horiz" className="text-[16px]" /> {v.suggestion}
                          </p>
                        </div>
                      ))
                    ) : (
                      <span className="px-space-sm font-body-md text-body-md text-on-surface-variant">{m.hasPrefs ? "Everything they're on matches their interests." : "They haven't shared preferences yet."}</span>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <Link href="/profile" className="flex items-center justify-center gap-1 rounded-lg bg-surface-container-low py-space-sm font-label-md text-label-md text-primary">
          <Icon name="tune" className="text-[18px]" /> Set your travel preferences
        </Link>
      )}
    </section>
  );
}

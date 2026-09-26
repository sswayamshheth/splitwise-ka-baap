"use client";

import type { ReactNode } from "react";

import type { Described } from "@/lib/ledger/describe";
import type { ExpenseCategory } from "@/lib/ledger/types";
import { formatRelative } from "@/lib/dates";
import { portrait } from "@/lib/covers";
import { cx, Icon, Money } from "../kit";

/** Material Symbols name for an expense / itinerary category. */
export const CATEGORY_ICON: Record<ExpenseCategory, string> = {
  Stay: "hotel",
  Transport: "flight",
  Activity: "kayaking",
  Food: "restaurant",
  "Local travel": "local_taxi",
  Shopping: "shopping_bag",
  Other: "receipt_long",
};

export function CategoryBadge({ category, size = 40 }: { category: ExpenseCategory; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-xl bg-surface-container text-primary" style={{ width: size, height: size }}>
      <Icon name={CATEGORY_ICON[category] ?? "receipt_long"} className="text-[20px]" />
    </span>
  );
}

/** describe.ts uses hyphenated Material Icons names; Material Symbols uses underscores. */
export const symbol = (icon: string) => icon.replace(/-/g, "_");

const TONE: Record<Described["tone"], string> = {
  blue: "bg-primary-fixed/60 text-primary",
  mint: "bg-primary-fixed/40 text-primary",
  coral: "bg-error-container text-on-error-container",
  amber: "bg-secondary-fixed text-on-secondary-fixed-variant",
  grey: "bg-surface-container text-on-surface-variant",
  lavender: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
};

/** One audit-trail line: an event described in plain language, straight from describe.ts. */
export function EventRow({ d, ts, actor }: { d: Described; ts: number; actor?: string }) {
  return (
    <div className="flex gap-space-sm py-space-sm">
      <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", TONE[d.tone])}>
        <Icon name={symbol(d.icon)} className="text-[18px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start justify-between gap-space-sm">
          <span className="font-title-md text-[15px] leading-5 text-on-surface">{d.title}</span>
          {d.amountPaise !== undefined ? <Money paise={d.amountPaise} className="shrink-0 text-[15px]" /> : null}
        </div>
        <span className="font-body-md text-body-md text-on-surface-variant">{d.detail}</span>
        {d.changes?.length ? (
          <div className="mt-1 flex flex-col gap-0.5 rounded-lg bg-surface-container-low px-space-sm py-space-xs">
            {d.changes.map((c, i) => (
              <span key={i} className="font-label-md text-label-md text-on-surface-variant">
                {c.label}: <span className="line-through opacity-70">{c.before}</span> → <span className="text-on-surface">{c.after}</span>
              </span>
            ))}
          </div>
        ) : null}
        <span className="font-label-sm text-label-sm text-outline">
          {formatRelative(ts)}
          {actor ? ` · by ${actor}` : ""}
        </span>
      </div>
    </div>
  );
}

const PIN: Record<Described["tone"], string> = {
  blue: "bg-primary text-on-primary",
  mint: "bg-primary-container text-on-primary",
  coral: "bg-error-container text-on-error-container",
  amber: "bg-secondary-fixed text-on-secondary-fixed",
  grey: "bg-surface-container-high text-on-surface-variant",
  lavender: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
};

/** One entry of the "Ledger chronicle" timeline (explain_my_balance style): pin on the spine + card. */
export function ChronicleItem({ d, ts, actor }: { d: Described; ts: number; actor?: string }) {
  return (
    <div className="relative flex items-start gap-space-md">
      <span className={cx("relative z-10 mt-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full shadow-sm", PIN[d.tone])}>
        <Icon name={symbol(d.icon)} className="text-[14px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-start justify-between gap-space-sm">
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {formatRelative(ts)}
            {actor ? ` · ${actor}` : ""}
          </span>
          {d.amountPaise !== undefined ? <Money paise={d.amountPaise} className="shrink-0 text-currency-md text-on-surface" /> : null}
        </div>
        <span className="font-title-lg text-title-lg text-on-surface">{d.title}</span>
        <span className="font-body-md text-body-md text-on-surface-variant">{d.detail}</span>
        {d.changes?.length ? (
          <div className="mt-1 flex flex-col gap-0.5 rounded-lg bg-surface-container-low px-space-md py-space-sm">
            {d.changes.map((c, i) => (
              <span key={i} className="flex items-center justify-between gap-space-sm font-label-md text-label-md text-on-surface-variant">
                <span>{c.label}</span>
                <span>
                  <span className="line-through opacity-70">{c.before}</span> → <span className="text-on-surface">{c.after}</span>
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A member photo (design portraits, stable per name). */
export function Portrait({ name, size = 56, className, ring }: { name: string; size?: number; className?: string; ring?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={name} src={portrait(name)} className={cx("shrink-0 rounded-full object-cover shadow-sm", ring && "ring-2 ring-surface-container-lowest", className)} style={{ width: size, height: size }} />
  );
}

/** Overlapping member photos with a "+N" chip, as on the design's itinerary cards. */
export function PortraitStack({ names, max = 4, size = 28 }: { names: string[]; max?: number; size?: number }) {
  return (
    <span className="flex items-center -space-x-2">
      {names.slice(0, max).map((n, i) => (
        <Portrait key={`${n}-${i}`} name={n} size={size} ring />
      ))}
      {names.length > max ? (
        <span className="flex items-center justify-center rounded-full bg-surface-container-high font-label-sm text-[10px] font-semibold text-on-surface-variant ring-2 ring-surface-container-lowest" style={{ width: size, height: size }}>
          +{names.length - max}
        </span>
      ) : null}
    </span>
  );
}

/** Full-bleed photo hero with a dark scrim and content at the bottom (my_trips / trip_day heroes). */
export function PhotoHero({ image, children, top, className }: { image: string; children: ReactNode; top?: ReactNode; className?: string }) {
  return (
    <div className={cx("relative w-full overflow-hidden bg-surface-container shadow-sm", className)}>
      <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${image}")` }} />
      <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface via-inverse-surface/40 to-transparent" />
      {top ? <div className="relative z-10 flex items-center justify-between gap-2 p-4">{top}</div> : null}
      <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 p-4 text-on-primary">{children}</div>
    </div>
  );
}

/** Glass badge used on photo heroes. */
export function HeroBadge({ children, tone = "light", icon }: { children: ReactNode; tone?: "light" | "teal" | "amber"; icon?: string }) {
  const t = { light: "bg-surface/90 text-on-surface", teal: "bg-primary-container/90 text-on-primary", amber: "bg-secondary-fixed/95 text-on-secondary-fixed" }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-label-md text-label-md shadow-sm backdrop-blur-md", t)}>
      {icon ? <Icon name={icon} filled className="text-[15px]" /> : null}
      {children}
    </span>
  );
}

/** Timeline pin on the itinerary spine. */
export function TimelinePin({ icon, tone = "idle" }: { icon: string; tone?: "done" | "active" | "idle" | "warn" }) {
  const t = {
    done: "bg-surface-container-lowest text-primary shadow-sm",
    active: "bg-primary text-on-primary shadow",
    idle: "bg-surface-container-high text-on-surface-variant",
    warn: "bg-secondary-container text-on-secondary-container shadow-sm",
  }[tone];
  return (
    <span className={cx("relative z-10 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", t)}>
      <Icon name={icon} filled={tone === "done"} className="text-[14px]" />
    </span>
  );
}

export function ProgressBar({ value, tone = "primary" }: { value: number; tone?: "primary" | "secondary" | "error" }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const c = { primary: "bg-primary", secondary: "bg-secondary-container", error: "bg-error" }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high">
      <div className={cx("h-full rounded-full", c)} style={{ width: `${pct}%` }} />
    </div>
  );
}

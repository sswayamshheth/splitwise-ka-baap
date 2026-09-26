"use client";

import type { ReactNode } from "react";

import { Chip, cx, Field, inputCls } from "@/components/app/kit";
import { useTrip } from "@/lib/client/trip";
import { portrait } from "@/lib/covers";
import { formatMoney, parseAmount, type Paise } from "@/lib/money";

/** A member's portrait (design photography, stable per name). */
export function Face({ name, size = 40, className, ring }: { name: string; size?: number; className?: string; ring?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={name}
      src={portrait(name)}
      width={size}
      height={size}
      className={cx("shrink-0 rounded-full bg-surface-container-high object-cover", ring && "ring-2 ring-surface-container-lowest", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Overlapping portraits, as in the design's settle rows. */
export function FacePair({ names, size = 32 }: { names: string[]; size?: number }) {
  return (
    <span className="flex -space-x-2">
      {names.map((n, i) => (
        <Face key={`${n}-${i}`} name={n} size={size} ring className="shadow-sm" />
      ))}
    </span>
  );
}

/** Design eyebrow: small uppercase primary label. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("font-label-sm text-label-sm font-semibold uppercase tracking-widest text-primary", className)}>{children}</p>;
}

/** Pick one member. */
export function MemberPicker({ value, onChange, ids, label }: { value: string | null; onChange: (id: string) => void; ids?: string[]; label: string }) {
  const trip = useTrip();
  const people = (ids ?? trip.state.participants.filter((p) => !p.leftOn).map((p) => p.id)).map((id) => trip.participant(id)).filter(Boolean);
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-space-sm">
        {people.map((p) => (
          <Chip key={p!.id} selected={value === p!.id} onClick={() => onChange(p!.id)}>
            <span className="inline-flex items-center gap-1">
              <Face name={p!.name} size={18} />
              {trip.short(p!.id)}
            </span>
          </Chip>
        ))}
      </div>
    </Field>
  );
}

/** Pick several members. */
export function MembersPicker({ value, onChange, label, hint }: { value: string[]; onChange: (ids: string[]) => void; label: string; hint?: string }) {
  const trip = useTrip();
  const people = trip.state.participants.filter((p) => !p.leftOn);
  const all = people.length > 0 && people.every((p) => value.includes(p.id));
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-wrap gap-space-sm">
        <Chip selected={all} onClick={() => onChange(all ? [] : people.map((p) => p.id))} icon="groups">
          Everyone
        </Chip>
        {people.map((p) => (
          <Chip key={p.id} selected={value.includes(p.id)} onClick={() => onChange(value.includes(p.id) ? value.filter((x) => x !== p.id) : [...value, p.id])}>
            <span className="inline-flex items-center gap-1">
              <Face name={p.name} size={18} />
              {trip.short(p.id)}
            </span>
          </Chip>
        ))}
      </div>
    </Field>
  );
}

export function AmountField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const parsed = value.trim() ? parseAmount(value) : null;
  return (
    <Field label={label} error={parsed && parsed.error ? parsed.error : undefined} hint={hint}>
      <div className="relative">
        <span className="pointer-events-none absolute left-space-md top-1/2 -translate-y-1/2 font-title-md text-on-surface-variant">₹</span>
        <input className={cx(inputCls, "pl-9")} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" />
      </div>
    </Field>
  );
}

export function paiseOf(text: string): Paise | null {
  const p = parseAmount(text);
  return p.paise !== undefined && p.paise > 0 ? p.paise : null;
}

/**
 * Diverging bars: debtors to the left in coral, creditors to the right in
 * teal, scaled to the largest absolute balance.
 */
export function BalanceBars({ rows }: { rows: { id: string; label: ReactNode; net: Paise }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const sum = rows.reduce((s, r) => s + r.net, 0);
  return (
    <div className="flex flex-col gap-space-sm">
      {rows.map((r) => {
        const w = `${(Math.abs(r.net) / max) * 50}%`;
        return (
          <div key={r.id} className="grid grid-cols-[88px_1fr_84px] items-center gap-space-sm">
            <span className="truncate font-label-md text-label-md text-on-surface">{r.label}</span>
            <div className="relative h-3 rounded-full bg-surface-container">
              <div className="absolute inset-y-0 left-1/2 w-px bg-outline-variant" />
              {r.net < 0 ? <div className="absolute inset-y-0 rounded-l-full bg-error/80" style={{ right: "50%", width: w }} /> : null}
              {r.net > 0 ? <div className="absolute inset-y-0 rounded-r-full bg-primary-container" style={{ left: "50%", width: w }} /> : null}
            </div>
            <span className={cx("text-right font-label-md text-label-md tabular-nums", r.net > 0 ? "text-primary" : r.net < 0 ? "text-error" : "text-on-surface-variant")}>
              {formatMoney(r.net, { signed: true })}
            </span>
          </div>
        );
      })}
      <div className="flex justify-between font-label-sm text-label-sm text-on-surface-variant">
        <span>◀ owes</span>
        <span>Σ = {formatMoney(sum)}</span>
        <span>is owed ▶</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "teal" | "amber" | "coral" }) {
  return (
    <div className={cx("flex flex-col gap-0.5 rounded-lg p-space-sm", tone === "teal" ? "bg-primary-fixed/40" : tone === "amber" ? "bg-secondary-fixed/50" : tone === "coral" ? "bg-error-container/70" : "bg-surface-container-low")}>
      <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</span>
      <span className="font-currency-md text-currency-md text-on-surface">{value}</span>
      {sub ? <span className="font-label-sm text-label-sm text-on-surface-variant">{sub}</span> : null}
    </div>
  );
}

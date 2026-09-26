"use client";

import { cx, Icon } from "@/components/app/kit";
import { ACTIVITIES, CUISINES, DIETS, PACES, type Diet, type Interests, type Pace } from "@/lib/interests";

/**
 * Travel preferences in the Stitch chip/card language. Controlled: the parent
 * owns the value and decides when to save (onboarding page, Profile section).
 */

export const EMPTY_INTERESTS: Interests = { cuisines: [], activities: [] };

export function InterestsForm({ value, onChange, compact }: { value: Interests; onChange: (v: Interests) => void; compact?: boolean }) {
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className={cx("flex flex-col", compact ? "gap-space-md" : "gap-space-lg")}>
      {/* Activities */}
      <section className="flex flex-col gap-space-sm">
        <Heading icon="hiking" title="What do you love doing?" hint="Pick as many as you like" />
        <div className="grid grid-cols-2 gap-2">
          {ACTIVITIES.map((a) => {
            const on = value.activities.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...value, activities: toggle(value.activities, a.id) })}
                className={cx(
                  "relative flex min-h-[84px] flex-col items-start gap-1 rounded-xl p-3 text-left transition-all active:scale-[0.98]",
                  on ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-lowest text-on-surface shadow-sm hover:bg-surface-container-low",
                )}
              >
                <span className={cx("flex h-8 w-8 items-center justify-center rounded-full", on ? "bg-on-primary/15" : "bg-surface-container")}>
                  <Icon name={a.icon} className={cx("text-[18px]", on ? "text-on-primary" : "text-primary")} />
                </span>
                <span className="font-title-md text-title-md leading-tight">{a.label}</span>
                <span className={cx("font-label-sm text-label-sm leading-snug", on ? "text-primary-fixed" : "text-on-surface-variant")}>{a.hint}</span>
                {on ? <Icon name="check_circle" filled className="absolute right-2.5 top-2.5 text-[18px] text-primary-fixed" /> : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* Diet */}
      <section className="flex flex-col gap-space-sm">
        <Heading icon="restaurant" title="How do you eat?" hint="Helps pick restaurants everyone can enjoy" />
        <div className="flex flex-wrap gap-2">
          {DIETS.map((d) => (
            <Pick key={d.id} on={value.diet === d.id} onClick={() => onChange({ ...value, diet: value.diet === d.id ? undefined : (d.id as Diet) })}>
              {d.label}
            </Pick>
          ))}
        </div>
      </section>

      {/* Cuisines */}
      <section className="flex flex-col gap-space-sm">
        <Heading icon="ramen_dining" title="Favourite cuisines" hint="Optional" />
        <div className="flex flex-wrap gap-2">
          {CUISINES.map((c) => (
            <Pick key={c} on={value.cuisines.includes(c)} onClick={() => onChange({ ...value, cuisines: toggle(value.cuisines, c) })}>
              {c}
            </Pick>
          ))}
        </div>
      </section>

      {/* Pace */}
      <section className="flex flex-col gap-space-sm">
        <Heading icon="speed" title="Trip pace" hint="How full should the days be?" />
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-container-low p-1">
          {PACES.map((p) => {
            const on = value.pace === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...value, pace: on ? undefined : (p.id as Pace) })}
                className={cx("rounded-lg py-2.5 font-title-md text-title-md transition-colors", on ? "bg-surface-container-lowest text-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface")}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Heading({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <h3 className="flex items-center gap-2 font-headline-sm text-headline-sm text-on-surface">
        <Icon name={icon} className="text-[20px] text-primary" /> {title}
      </h3>
      {hint ? <span className="shrink-0 font-label-sm text-label-sm text-on-surface-variant">{hint}</span> : null}
    </div>
  );
}

function Pick({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-3.5 py-2 font-label-md text-label-md transition-colors",
        on ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-lowest text-on-surface-variant shadow-sm hover:bg-surface-container-low",
      )}
    >
      {on ? <Icon name="check" className="text-[14px]" /> : null}
      {children}
    </button>
  );
}

export function interestsSummary(i?: Interests): string {
  if (!i) return "Not set";
  const bits: string[] = [];
  if (i.activities.length) bits.push(i.activities.map((a) => ACTIVITIES.find((x) => x.id === a)?.label ?? a).slice(0, 3).join(", ") + (i.activities.length > 3 ? ` +${i.activities.length - 3}` : ""));
  if (i.diet) bits.push(DIETS.find((d) => d.id === i.diet)?.label ?? i.diet);
  if (i.pace) bits.push(`${PACES.find((p) => p.id === i.pace)?.label} pace`);
  return bits.join(" · ") || "Not set";
}

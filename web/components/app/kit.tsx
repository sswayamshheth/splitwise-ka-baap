"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { formatMoney, type Paise } from "@/lib/money";

/**
 * Shared building blocks in the "Serene Voyage" design language (the Stitch
 * exports in /ui): teal primary, Playfair headlines, Plus Jakarta body,
 * Material Symbols icons, soft rounded cards on a mint surface.
 */

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Icon({ name, className, filled }: { name: string; className?: string; filled?: boolean }) {
  return (
    <span className={cx("material-symbols-outlined select-none leading-none", className)} style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined} aria-hidden>
      {name}
    </span>
  );
}

export function Card({ children, className, tone = "default", onClick }: { children: ReactNode; className?: string; tone?: "default" | "soft" | "ink" | "amber" | "lavender"; onClick?: () => void }) {
  const tones = {
    default: "bg-surface-container-lowest shadow-sm",
    soft: "bg-surface-container-low",
    ink: "bg-inverse-surface text-inverse-on-surface",
    amber: "bg-secondary-fixed/40",
    lavender: "bg-tertiary-fixed/60",
  } as const;
  return (
    <div onClick={onClick} className={cx("rounded-xl p-space-md", tones[tone], onClick && "cursor-pointer transition-shadow hover:shadow-md", className)}>
      {children}
    </div>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant", className)}>{children}</span>;
}

export function Headline({ children, className, size = "md" }: { children: ReactNode; className?: string; size?: "sm" | "md" | "lg" | "display" }) {
  const s = { sm: "font-headline-sm text-headline-sm", md: "font-headline-md text-headline-md", lg: "font-headline-lg text-headline-lg", display: "font-display-lg-mobile text-display-lg-mobile" }[size];
  return <h2 className={cx(s, "text-on-surface", className)}>{children}</h2>;
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mt-space-lg flex flex-col gap-space-sm", className)}>
      <div className="flex items-center justify-between">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: string;
  disabled?: boolean;
  full?: boolean;
  small?: boolean;
  type?: "button" | "submit";
  className?: string;
};

export function Button({ children, onClick, href, variant = "primary", icon, disabled, full, small, type = "button", className }: ButtonProps) {
  const v = {
    primary: "bg-primary-container text-on-primary hover:bg-primary",
    secondary: "bg-surface-container text-primary hover:bg-surface-container-high",
    ghost: "bg-transparent text-primary hover:bg-surface-container-low",
    danger: "bg-error text-on-error hover:opacity-90",
  }[variant];
  const cls = cx(
    "inline-flex items-center justify-center gap-space-xs rounded-xl font-title-md transition-colors disabled:opacity-40 disabled:pointer-events-none",
    small ? "h-9 px-space-md text-label-md" : "h-12 px-space-lg text-title-md",
    full && "w-full",
    v,
    className,
  );
  const inner = (
    <>
      {icon ? <Icon name={icon} className={small ? "text-[18px]" : "text-[20px]"} /> : null}
      {children}
    </>
  );
  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {inner}
    </button>
  );
}

export function Pill({ children, tone = "grey", icon }: { children: ReactNode; tone?: "grey" | "teal" | "amber" | "coral" | "lavender" | "ink"; icon?: string }) {
  const t = {
    grey: "bg-surface-container text-on-surface-variant",
    teal: "bg-primary-fixed/60 text-on-primary-fixed-variant",
    amber: "bg-secondary-fixed text-on-secondary-fixed-variant",
    coral: "bg-error-container text-on-error-container",
    lavender: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
    ink: "bg-inverse-surface text-inverse-on-surface",
  }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-space-sm py-0.5 font-label-sm text-label-sm whitespace-nowrap", t)}>
      {icon ? <Icon name={icon} className="text-[14px]" /> : null}
      {children}
    </span>
  );
}

/** Money in rupees from integer paise. `tone="auto"`: green if positive, red if negative. */
export function Money({ paise, className, signed, tone }: { paise: Paise; className?: string; signed?: boolean; tone?: "auto" }) {
  const color = tone === "auto" ? (paise > 0 ? "text-primary" : paise < 0 ? "text-error" : "text-on-surface-variant") : "";
  return <span className={cx("font-currency-md tabular-nums", color, className)}>{formatMoney(paise, { signed })}</span>;
}

const AVATAR_TONES = ["bg-primary-fixed text-on-primary-fixed", "bg-secondary-fixed text-on-secondary-fixed", "bg-tertiary-fixed text-on-tertiary-fixed", "bg-surface-variant text-on-surface", "bg-error-container text-on-error-container"];

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function Avatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-label-md", AVATAR_TONES[h % AVATAR_TONES.length], className)} style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 4, size = 26 }: { names: string[]; max?: number; size?: number }) {
  return (
    <span className="flex -space-x-2">
      {names.slice(0, max).map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size={size} className="ring-2 ring-surface-container-lowest" />
      ))}
      {names.length > max ? (
        <span className="inline-flex items-center justify-center rounded-full bg-inverse-surface text-inverse-on-surface ring-2 ring-surface-container-lowest font-label-sm" style={{ width: size, height: size, fontSize: 10 }}>
          +{names.length - max}
        </span>
      ) : null}
    </span>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-label-md text-label-md text-on-surface-variant">{label}</span>
      {children}
      {error ? <span className="font-label-sm text-label-sm text-error">{error}</span> : hint ? <span className="font-label-sm text-label-sm text-on-surface-variant">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "h-12 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-space-md font-body-lg text-body-lg text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export function Chip({ children, selected, onClick, icon }: { children: ReactNode; selected?: boolean; onClick?: () => void; icon?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-space-md py-space-xs font-label-md text-label-md whitespace-nowrap transition-colors",
        selected ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
      )}
    >
      {icon ? <Icon name={icon} className="text-[16px]" /> : null}
      {children}
    </button>
  );
}

export function Empty({ icon, title, message, action }: { icon: string; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
      <Icon name={icon} className="text-[40px] text-primary" />
      <p className="font-title-md text-title-md text-on-surface">{title}</p>
      {message ? <p className="font-body-md text-body-md text-on-surface-variant">{message}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-space-sm py-space-xl text-on-surface-variant">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      {label ? <span className="font-body-md text-body-md">{label}</span> : null}
    </div>
  );
}

export function Notice({ tone = "teal", icon = "info", title, children }: { tone?: "teal" | "amber" | "coral" | "lavender"; icon?: string; title?: string; children: ReactNode }) {
  const t = { teal: "bg-surface-container text-on-surface", amber: "bg-secondary-fixed/50 text-on-secondary-fixed", coral: "bg-error-container text-on-error-container", lavender: "bg-tertiary-fixed/70 text-on-tertiary-fixed" }[tone];
  return (
    <div className={cx("flex gap-space-sm rounded-xl p-space-md", t)}>
      <Icon name={icon} className="text-[20px]" />
      <div className="flex flex-col gap-0.5">
        {title ? <span className="font-title-md text-title-md">{title}</span> : null}
        <div className="font-body-md text-body-md">{children}</div>
      </div>
    </div>
  );
}

/** Top bar used inside trips and full-screen flows. */
export function TopBar({ title, eyebrow, back, right }: { title: string; eyebrow?: string; back?: string | true; right?: ReactNode }) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-40 w-full bg-surface/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(16,32,28,0.03)]">
      <div className="mx-auto flex h-16 w-full max-w-[520px] items-center justify-between gap-space-sm px-margin">
        <div className="flex min-w-0 items-center gap-space-sm">
          {back ? (
            <button aria-label="Back" onClick={() => (back === true ? router.back() : router.push(back))} className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full hover:bg-surface-variant">
              <Icon name="arrow_back" className="text-[24px] text-on-surface" />
            </button>
          ) : (
            <Icon name="explore" className="text-[28px] text-primary" />
          )}
          <div className="flex min-w-0 flex-col">
            {eyebrow ? <span className="font-label-sm text-label-sm uppercase tracking-wider text-primary">{eyebrow}</span> : null}
            <h1 className="truncate font-headline-sm text-headline-sm leading-tight tracking-tight text-on-surface">{title}</h1>
          </div>
        </div>
        {right}
      </div>
    </header>
  );
}

/** A centred phone-width column: the app is mobile-first and stays readable on a laptop. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cx("mx-auto w-full max-w-[520px] flex-1 px-margin pb-32 pt-space-md", className)}>{children}</main>;
}

// ------------------------------------------------------------------ toasts & confirm

type Toast = { id: number; text: string; tone: "ok" | "error" };
type ConfirmReq = { title: string; message?: string; confirm?: string; danger?: boolean; resolve: (v: boolean) => void };
const FeedbackCtx = createContext<{ toast: (text: string, tone?: "ok" | "error") => void; confirm: (o: Omit<ConfirmReq, "resolve">) => Promise<boolean> } | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<ConfirmReq | null>(null);
  const seq = useRef(0);
  const toast = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  const confirm = useCallback((o: Omit<ConfirmReq, "resolve">) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);
  return (
    <FeedbackCtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-28 z-[70] flex flex-col items-center gap-2 px-margin">
        {toasts.map((t) => (
          <div key={t.id} className={cx("pointer-events-auto max-w-[480px] rounded-xl px-space-md py-space-sm font-body-md text-body-md shadow-lg", t.tone === "error" ? "bg-error text-on-error" : "bg-inverse-surface text-inverse-on-surface")}>
            {t.text}
          </div>
        ))}
      </div>
      {ask ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-inverse-surface/50 px-margin" role="dialog" aria-modal>
          <div className="w-full max-w-[400px] rounded-xl bg-surface-container-lowest p-space-lg shadow-xl">
            <p className="font-title-lg text-title-lg text-on-surface">{ask.title}</p>
            {ask.message ? <p className="mt-space-xs font-body-md text-body-md text-on-surface-variant">{ask.message}</p> : null}
            <div className="mt-space-lg flex justify-end gap-space-sm">
              <Button
                variant="ghost"
                small
                onClick={() => {
                  ask.resolve(false);
                  setAsk(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant={ask.danger ? "danger" : "primary"}
                small
                onClick={() => {
                  ask.resolve(true);
                  setAsk(null);
                }}
              >
                {ask.confirm ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </FeedbackCtx.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackCtx);
  if (!ctx) throw new Error("useFeedback needs FeedbackProvider");
  return ctx;
}

/** Bottom sheet for forms on top of a screen. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-inverse-surface/40" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-[520px] overflow-y-auto rounded-t-[28px] bg-surface-container-lowest p-space-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-space-md h-1.5 w-12 rounded-full bg-outline-variant" />
        <div className="mb-space-md flex items-center justify-between">
          <h2 className="font-headline-md text-headline-md text-on-surface">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-container hover:bg-surface-variant">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

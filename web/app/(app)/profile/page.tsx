"use client";

import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { cx, Icon, initials, Spinner, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";

type Me = { profile: { userId: string; name: string; email?: string; phone?: string; upiId?: string }; onboarded: boolean };
type Status = { store: "file" | "supabase"; auth: string; ai: string };

/** Travel-style preferences. Saved on this device only (not shared with the group yet). */
const STYLE_GROUPS: { key: string; icon: string; title: string; options: string[] }[] = [
  { key: "pace", icon: "schedule", title: "Pace & Rhythm", options: ["Slow mornings", "Fast-paced & early", "Flexible flow", "Night owl"] },
  { key: "vibe", icon: "forest", title: "Interests & Vibe", options: ["Nature trails", "Specialty coffee", "High adventure", "Wellness & spas", "Local food heritage", "Historical walks"] },
  { key: "budget", icon: "account_balance_wallet", title: "Budget Comfort Zone", options: ["Thoughtful mid-range", "Value & backpacker", "Splurge on unique stays", "Strict split tracker"] },
];
const STYLE_KEY = "gt.travelStyle";

export default function ProfilePage() {
  const router = useRouter();
  const { signOut } = useClerk();
  const { toast, confirm } = useFeedback();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState("");
  const [upi, setUpi] = useState("");
  const [saving, setSaving] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [style, setStyle] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/me")
      .then((r) => {
        setMe(r);
        setName(r.profile.name ?? "");
        setUpi(r.profile.upiId ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your profile"));
    api<Status>("/api/status")
      .then(setStatus)
      .catch(() => undefined);
    try {
      const raw = localStorage.getItem(STYLE_KEY);
      if (raw) setStyle(JSON.parse(raw) as Record<string, string[]>);
    } catch {
      /* storage unavailable: preferences just don't persist */
    }
  }, []);

  function toggleStyle(group: string, option: string) {
    setStyle((prev) => {
      const cur = prev[group] ?? [];
      const next = { ...prev, [group]: cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option] };
      try {
        localStorage.setItem(STYLE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const dirty = me && (name.trim() !== (me.profile.name ?? "") || upi.trim() !== (me.profile.upiId ?? ""));

  async function save() {
    setSaving(true);
    try {
      const r = await api<Me>("/api/me", { method: "PUT", body: { name, upiId: upi || undefined } });
      setMe(r);
      toast("Profile saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "error");
    } finally {
      setSaving(false);
    }
  }

  async function demo() {
    const ok = await confirm({ title: "Load the Goa demo trip?", message: "Adds the six-person Goa trip to your account with you as the organiser. If you already have it, it is reset to its starting state.", confirm: "Load demo" });
    if (!ok) return;
    setDemoBusy(true);
    try {
      const r = await api<{ tripId: string }>("/api/demo", { method: "POST", body: {} });
      router.push(`/trips/${r.tripId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load the demo", "error");
      setDemoBusy(false);
    }
  }

  async function logout() {
    const ok = await confirm({ title: "Sign out?", confirm: "Sign out" });
    if (ok) await signOut({ redirectUrl: "/login" });
  }

  if (error)
    return (
      <main className="mx-auto w-full max-w-[520px] px-margin pb-32 pt-space-lg">
        <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
          <Icon name="cloud_off" className="text-[36px] text-primary" />
          <p className="font-title-md text-title-md text-on-surface">Couldn&apos;t load your profile</p>
          <p className="font-body-md text-body-md text-on-surface-variant">{error}</p>
        </div>
      </main>
    );
  if (!me) return <Spinner label="Loading your profile" />;

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-col gap-space-lg px-margin pb-32 pt-space-sm">
      {/* Identity card */}
      <section className="relative flex flex-col items-center overflow-hidden rounded-xl bg-surface-container-lowest px-space-lg pb-space-lg pt-space-xl text-center shadow-sm">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-surface-container to-transparent" />
        <div className="relative">
          <span className="flex h-24 w-24 items-center justify-center rounded-full bg-primary-container font-headline-md text-headline-md text-on-primary shadow-sm ring-4 ring-surface-container">{initials(me.profile.name || "?")}</span>
          <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm">
            <Icon name="verified_user" className="text-[16px]" />
          </span>
        </div>
        <h1 className="mt-space-md font-headline-md text-headline-md text-on-surface">{me.profile.name || "Your profile"}</h1>
        <p className="font-body-md text-body-md text-on-surface-variant">{me.profile.email ?? "No email on file"}</p>
        <div className="mt-space-sm flex flex-wrap justify-center gap-1.5">
          {me.profile.email ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-container px-2.5 py-0.5 font-label-sm text-label-sm text-primary">
              <Icon name="verified" className="text-[14px]" /> Verified email
            </span>
          ) : null}
          {!me.profile.phone ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary-fixed/60 px-2.5 py-0.5 font-label-sm text-label-sm text-on-secondary-fixed-variant">
              <Icon name="workspace_premium" className="text-[14px]" /> Phone login · Pro
            </span>
          ) : null}
        </div>
      </section>

      {/* Details */}
      <section className="flex flex-col gap-space-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Your Details</h2>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Shared with your trips</span>
        </div>
        <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-2 font-title-md text-title-md text-on-surface">
              <Icon name="badge" className="text-[20px] text-primary" /> Name
            </span>
            <input className="h-11 rounded-lg border border-outline-variant/60 bg-surface-container-low px-3 font-body-lg text-body-lg text-on-surface outline-none focus:border-primary" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <span className="font-label-sm text-label-sm text-on-surface-variant">Shown on shared expenses and settlements.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-2 font-title-md text-title-md text-on-surface">
              <Icon name="qr_code_2" className="text-[20px] text-primary" /> UPI ID
            </span>
            <input className="h-11 rounded-lg border border-outline-variant/60 bg-surface-container-low px-3 font-body-lg text-body-lg text-on-surface outline-none focus:border-primary" value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" autoCapitalize="none" />
            <span className="font-label-sm text-label-sm text-on-surface-variant">Friends settle up with you through their own UPI app.</span>
          </label>
          <button
            disabled={!dirty || !name.trim() || saving}
            onClick={() => void save()}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary transition-colors hover:bg-primary disabled:opacity-40"
          >
            <Icon name="check" className="text-[20px]" /> {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      {/* Travel style */}
      <section className="flex flex-col gap-space-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Your Travel Style</h2>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">On this device</span>
        </div>
        <p className="font-body-md text-body-md text-on-surface-variant">Pick what makes a trip great for you. Saved on this device for now.</p>
        {STYLE_GROUPS.map((g) => (
          <div key={g.key} className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
            <span className="flex items-center gap-2 font-title-md text-title-md text-on-surface">
              <Icon name={g.icon} className="text-[20px] text-primary" /> {g.title}
            </span>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => {
                const on = (style[g.key] ?? []).includes(o);
                return (
                  <button
                    key={o}
                    onClick={() => toggleStyle(g.key, o)}
                    className={cx(
                      "inline-flex items-center gap-1 rounded-full px-3 py-1.5 font-label-md text-label-md transition-colors",
                      on ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
                    )}
                  >
                    {on ? <Icon name="check" className="text-[14px]" /> : null}
                    {o}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Cards notice */}
      <section className="flex flex-col gap-space-sm">
        <h2 className="font-headline-sm text-headline-sm text-on-surface">Cards You Use</h2>
        <div className="flex items-start gap-3 rounded-xl bg-surface-container-low p-space-md">
          <Icon name="lock" className="text-[20px] text-primary" />
          <p className="font-body-md text-body-md text-on-surface-variant">
            We never ask for card numbers, CVVs or bank logins — only the card&apos;s name, bank and last four digits, to suggest which card saves the group most. The offer list is a curated estimate.
          </p>
        </div>
      </section>

      {/* Settings rows */}
      <section className="flex flex-col overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
        <button onClick={() => void demo()} disabled={demoBusy} className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-space-md py-4 text-left transition-colors hover:bg-surface-container-low disabled:opacity-50">
          <span className="flex items-center gap-3 font-title-md text-title-md text-on-surface">
            <Icon name="bolt" className="text-[20px] text-primary" /> {demoBusy ? "Loading demo…" : "Load / reset the Goa demo trip"}
          </span>
          <Icon name="chevron_right" className="text-[20px] text-on-surface-variant/60" />
        </button>
        <div className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-space-md py-4">
          <span className="flex items-center gap-3 font-title-md text-title-md text-on-surface">
            <Icon name="database" className="text-[20px] text-primary" /> Data storage
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">{status ? (status.store === "supabase" ? "Supabase" : "Local file (dev)") : "…"}</span>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-space-md py-4">
          <span className="flex items-center gap-3 font-title-md text-title-md text-on-surface">
            <Icon name="lock" className="text-[20px] text-primary" /> Sign-in
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">{status ? (status.auth === "clerk" ? "Email code (Clerk)" : status.auth) : "…"}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-space-md py-4">
          <span className="flex items-center gap-3 font-title-md text-title-md text-on-surface">
            <Icon name="auto_awesome" className="text-[20px] text-primary" /> Ask the ledger (AI)
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">{status ? (status.ai === "claude" ? "Claude" : "Offline mode") : "…"}</span>
        </div>
      </section>

      <div className="flex items-start gap-3 rounded-xl bg-tertiary-fixed/60 p-space-md">
        <Icon name="shield" className="text-[20px] text-on-tertiary-fixed-variant" />
        <p className="font-body-md text-body-md text-on-tertiary-fixed">
          Prototype: payments and the trip pool are simulated (a simulated escrow tracked by the ledger) — no money moves through this app, and UPI payments open your own UPI app.
        </p>
      </div>

      <button onClick={() => void logout()} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-container font-title-md text-title-md text-error transition-colors hover:bg-surface-container-high">
        <Icon name="logout" className="text-[20px]" /> Sign out
      </button>

      <p className="text-center font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant/70">GroupTrip Ledger · event-sourced trip ledger</p>
    </main>
  );
}

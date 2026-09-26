"use client";

import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { EMPTY_INTERESTS, InterestsForm, interestsSummary } from "@/components/app/home/InterestsForm";
import { cx, Icon, initials, Spinner, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { CARD_SUGGESTIONS } from "@/lib/cards";
import { isEmpty, type Interests } from "@/lib/interests";

type Card = { id: string; label: string; bank: string; network?: string; kind: "credit-card" | "debit-card" | "netbanking" | "upi" };
type Me = { profile: { userId: string; name: string; email?: string; phone?: string; upiId?: string; interests?: Interests; cards?: Card[] }; onboarded: boolean };
type Status = { store: "file" | "supabase"; auth: string; ai: string };

const KIND_LABEL: Record<Card["kind"], string> = { "credit-card": "Credit card", "debit-card": "Debit card", netbanking: "Bank account", upi: "UPI" };
const KIND_ICON: Record<Card["kind"], string> = { "credit-card": "credit_card", "debit-card": "credit_card", netbanking: "account_balance", upi: "qr_code_2" };

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
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Interests>(EMPTY_INTERESTS);
  const [editPrefs, setEditPrefs] = useState(false);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [cardName, setCardName] = useState("");
  const [cardBusy, setCardBusy] = useState(false);

  const load = () =>
    api<Me>("/api/me")
      .then((r) => {
        setMe(r);
        setName(r.profile.name ?? "");
        setUpi(r.profile.upiId ?? "");
        setPrefs({ ...EMPTY_INTERESTS, ...(r.profile.interests ?? {}) });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your profile"));

  useEffect(() => {
    void load();
    api<Status>("/api/status")
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const dirty = me && (name.trim() !== (me.profile.name ?? "") || upi.trim() !== (me.profile.upiId ?? ""));
  const cards = me?.profile.cards ?? [];

  async function save() {
    setSaving(true);
    try {
      const r = await api<Me>("/api/me", { method: "PUT", body: { name, upiId: upi || null } });
      setMe(r);
      toast("Profile saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "error");
    } finally {
      setSaving(false);
    }
  }

  async function savePrefs() {
    setPrefsBusy(true);
    try {
      const r = await api<Me>("/api/me", { method: "PUT", body: { interests: isEmpty(prefs) ? null : prefs } });
      setMe(r);
      setEditPrefs(false);
      toast("Preferences saved · they sync into your trips next time you open them");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "error");
    } finally {
      setPrefsBusy(false);
    }
  }

  async function saveCards(names: string[]) {
    setCardBusy(true);
    try {
      const r = await api<Me>("/api/me", { method: "PUT", body: { cards: names } });
      setMe(r);
      setCardName("");
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "error");
      return false;
    } finally {
      setCardBusy(false);
    }
  }

  async function addCard(n: string) {
    const clean = n.trim();
    if (!clean) return;
    if (await saveCards([...cards.map((c) => c.label), clean])) toast(`Added ${clean}`);
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
          <button onClick={() => { setError(null); void load(); }} className="rounded-full bg-primary-container px-4 py-2 font-title-md text-title-md text-on-primary">
            Try again
          </button>
        </div>
      </main>
    );
  if (!me) return <Spinner label="Loading your profile" />;

  const suggestions = CARD_SUGGESTIONS.filter((s) => !cards.some((c) => s.toLowerCase().startsWith(c.label.toLowerCase())) && (!cardName || s.toLowerCase().includes(cardName.toLowerCase()))).slice(0, 5);

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
        <p className="max-w-full truncate font-body-md text-body-md text-on-surface-variant">{me.profile.email ?? "No email on file"}</p>
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

      {/* Travel preferences */}
      <section className="flex flex-col gap-space-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Travel Preferences</h2>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Harmony Score</span>
        </div>
        {!editPrefs ? (
          <button onClick={() => setEditPrefs(true)} className="flex items-center gap-3 rounded-xl bg-surface-container-lowest p-space-md text-left shadow-sm transition-colors hover:bg-surface-container-low">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
              <Icon name="interests" className="text-[22px]" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-title-md text-title-md text-on-surface">{isEmpty(me.profile.interests) ? "Tell us what you enjoy" : "Your preferences"}</span>
              <span className="truncate font-body-md text-body-md text-on-surface-variant">
                {isEmpty(me.profile.interests) ? "Optional — improves your trips' Harmony Score and AI plans" : interestsSummary(me.profile.interests)}
              </span>
            </span>
            <span className="font-label-md text-label-md font-semibold text-primary">Edit</span>
          </button>
        ) : (
          <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-low p-space-md">
            <InterestsForm value={prefs} onChange={setPrefs} compact />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setPrefs({ ...EMPTY_INTERESTS, ...(me.profile.interests ?? {}) });
                  setEditPrefs(false);
                }}
                className="h-11 flex-1 rounded-xl bg-surface-container-lowest font-title-md text-title-md text-on-surface-variant shadow-sm"
              >
                Cancel
              </button>
              <button disabled={prefsBusy} onClick={() => void savePrefs()} className="flex h-11 flex-[2] items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40">
                <Icon name="check" className="text-[20px]" /> {prefsBusy ? "Saving…" : "Save preferences"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Cards & accounts */}
      <section className="flex flex-col gap-space-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Cards &amp; Accounts</h2>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Card optimiser</span>
        </div>
        <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
          {cards.length ? (
            <div className="flex flex-col divide-y divide-outline-variant/30">
              {cards.map((c) => (
                <div key={c.id} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary-container to-primary text-on-primary">
                    <Icon name={KIND_ICON[c.kind]} className="text-[20px]" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-title-md text-title-md text-on-surface">{c.label}</span>
                    <span className="flex flex-wrap gap-1 pt-0.5">
                      <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">{c.bank}</span>
                      {c.network ? <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">{c.network}</span> : null}
                      <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">{KIND_LABEL[c.kind]}</span>
                    </span>
                  </span>
                  <button
                    aria-label={`Remove ${c.label}`}
                    disabled={cardBusy}
                    onClick={() => void saveCards(cards.filter((x) => x.id !== c.id).map((x) => x.label))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                  >
                    <Icon name="delete" className="text-[20px]" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="font-body-md text-body-md text-on-surface-variant">Add the cards or accounts you pay with — the optimiser then suggests who in the group should pay each booking to save the most.</p>
          )}
          <div className="flex gap-2">
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-outline-variant/60 bg-surface-container-low px-3 font-body-md text-body-md text-on-surface outline-none focus:border-primary"
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addCard(cardName)}
              placeholder="Card name, e.g. HDFC Regalia Visa"
              maxLength={60}
            />
            <button disabled={!cardName.trim() || cardBusy || cards.length >= 10} onClick={() => void addCard(cardName)} className="h-11 shrink-0 rounded-lg bg-primary-container px-4 font-title-md text-title-md text-on-primary disabled:opacity-40">
              Add
            </button>
          </div>
          {suggestions.length ? (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button key={s} disabled={cardBusy} onClick={() => void addCard(s)} className="rounded-full bg-surface-container px-3 py-1 font-label-md text-label-md text-primary hover:bg-surface-container-high disabled:opacity-40">
                  + {s}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-start gap-2 rounded-lg bg-surface-container-low p-3">
            <Icon name="lock" className="text-[18px] text-primary" />
            <p className="font-label-md text-label-md text-on-surface-variant">Name only — we never ask for card numbers, CVVs or bank logins. Offers come from a curated list and are estimates.</p>
          </div>
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
        <Row icon="database" label="Data storage" value={status ? (status.store === "supabase" ? "Supabase" : "Local file (dev)") : "…"} />
        <Row icon="lock" label="Sign-in" value={status ? (status.auth === "clerk" ? "Email code (Clerk)" : status.auth) : "…"} />
        <Row icon="auto_awesome" label="Ask the ledger (AI)" value={status ? (status.ai === "claude" ? "Claude" : "Offline mode") : "…"} last />
      </section>

      <div className="flex items-start gap-3 rounded-xl bg-tertiary-fixed/60 p-space-md">
        <Icon name="shield" className="text-[20px] text-on-tertiary-fixed-variant" />
        <p className="font-body-md text-body-md text-on-tertiary-fixed">
          Prototype: the trip pool is a simulated escrow tracked by the ledger. Card payments use Razorpay test mode (or a labelled demo checkout) — no real money moves.
        </p>
      </div>

      <button onClick={() => void logout()} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-surface-container font-title-md text-title-md text-error transition-colors hover:bg-surface-container-high">
        <Icon name="logout" className="text-[20px]" /> Sign out
      </button>

      <p className="text-center font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant/70">GroupTrip Ledger · event-sourced trip ledger</p>
    </main>
  );
}

function Row({ icon, label, value, last }: { icon: string; label: string; value: string; last?: boolean }) {
  return (
    <div className={cx("flex items-center justify-between gap-3 px-space-md py-4", !last && "border-b border-outline-variant/30")}>
      <span className="flex items-center gap-3 font-title-md text-title-md text-on-surface">
        <Icon name={icon} className="text-[20px] text-primary" /> {label}
      </span>
      <span className="font-label-sm text-label-sm text-on-surface-variant">{value}</span>
    </div>
  );
}

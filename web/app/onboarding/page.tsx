"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Icon } from "@/components/app/kit";
import { AuthHero } from "@/components/app/home/AuthHero";
import { api } from "@/lib/client/api";

function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/home";
  const [name, setName] = useState("");
  const [upi, setUpi] = useState("");
  const [identity, setIdentity] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ profile: { name: string; email?: string; phone?: string; upiId?: string }; onboarded: boolean }>("/api/me")
      .then((me) => {
        setName(me.profile.name ?? "");
        setUpi(me.profile.upiId ?? "");
        setIdentity(me.profile.email ?? me.profile.phone);
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me", { method: "PUT", body: { name, upiId: upi || undefined } });
      router.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const darkInput =
    "h-14 w-full rounded-xl border border-white/15 bg-white/10 px-4 font-body-lg text-body-lg text-surface-bright outline-none backdrop-blur-md transition-colors placeholder:text-surface-bright/50 focus:border-primary-fixed-dim focus:bg-white/15";

  return (
    <AuthHero
      eyebrow={`Welcome${identity ? ` · ${identity}` : ""}`}
      title="Who's travelling?"
      subtitle="Your name appears on shared expenses and settlements."
      footer={
        <span className="inline-flex items-center gap-1">
          <Icon name="lock" className="text-[14px]" /> We never store card numbers or bank passwords.
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="font-label-md text-label-md uppercase tracking-widest text-surface-bright/70">Your name</span>
          <input className={darkInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aarav Shah" autoFocus maxLength={40} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-label-md text-label-md uppercase tracking-widest text-surface-bright/70">UPI ID (optional)</span>
          <input className={darkInput} value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" autoCapitalize="none" />
          <span className="font-label-sm text-label-sm text-surface-bright/60">So friends can pay you back in one tap from their own UPI app.</span>
        </label>
        {error ? <p className="rounded-lg bg-error-container/90 px-3 py-2 font-body-md text-body-md text-on-error-container">{error}</p> : null}
        <button
          disabled={!name.trim() || busy}
          onClick={() => void save()}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-surface-container-lowest font-title-lg text-title-lg text-on-surface shadow-md transition-transform active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Continue"}
          <Icon name="arrow_forward" className="text-[22px] text-primary" />
        </button>
      </div>
    </AuthHero>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}

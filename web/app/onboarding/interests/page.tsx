"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { EMPTY_INTERESTS, InterestsForm } from "@/components/app/home/InterestsForm";
import { Icon } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { tripCover } from "@/lib/covers";
import { isEmpty, type Interests } from "@/lib/interests";

/**
 * Optional "interest customizer", shown once after sign-up (editable later in
 * Profile). Preferences feed each trip's Harmony Score and the AI itinerary.
 */
function InterestsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next")?.startsWith("/") && !params.get("next")!.startsWith("/onboarding") ? params.get("next")! : "/home";
  const [value, setValue] = useState<Interests>(EMPTY_INTERESTS);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ profile: { name: string; interests?: Interests }; onboarded: boolean; needsInterests: boolean }>("/api/me")
      .then((r) => {
        // Asked once: skip this page if the name isn't saved yet (onboard first) or preferences were already answered.
        if (!r.onboarded) {
          router.replace(`/onboarding?next=${encodeURIComponent(next)}`);
          return;
        }
        if (!r.needsInterests) {
          router.replace(next);
          return;
        }
        setName(r.profile.name?.split(" ")[0] ?? "");
        if (r.profile.interests) setValue({ ...EMPTY_INTERESTS, ...r.profile.interests });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(kind: "save" | "skip") {
    setBusy(kind);
    setError(null);
    try {
      await api("/api/me", { method: "PUT", body: kind === "save" && !isEmpty(value) ? { interests: value } : { interestsAsked: true } });
      router.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(null);
    }
  }

  const picked = value.activities.length + value.cuisines.length + (value.diet ? 1 : 0) + (value.pace ? 1 : 0);

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      {/* Hero */}
      <div className="relative h-52 w-full overflow-hidden bg-inverse-surface">
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${tripCover("forest river Dandeli", "interests")}")` }} />
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-inverse-surface/30 to-inverse-surface/10" />
        <div className="relative z-10 mx-auto flex h-full max-w-[520px] items-start justify-between px-margin pt-6">
          <span className="flex items-center gap-2 font-headline-sm text-headline-sm text-surface-bright">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 backdrop-blur-md">
              <Icon name="explore" className="text-[22px]" />
            </span>
            GroupTrip
          </span>
          <button onClick={() => void submit("skip")} disabled={!!busy} className="rounded-full bg-white/20 px-4 py-1.5 font-label-md text-label-md text-surface-bright backdrop-blur-md hover:bg-white/30">
            Skip for now
          </button>
        </div>
      </div>

      <main className="relative z-10 mx-auto -mt-16 flex w-full max-w-[520px] flex-1 flex-col gap-space-lg px-margin pb-40">
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container-lowest p-5 shadow-sm">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-secondary">Optional · takes a minute</span>
          <h1 className="font-headline-lg text-headline-lg text-on-surface">{name ? `What makes a trip great for you, ${name}?` : "What makes a trip great for you?"}</h1>
          <p className="font-body-md text-body-md text-on-surface-variant">
            We use this to score each trip&apos;s <span className="font-semibold text-primary">Harmony</span> — how well the group&apos;s tastes and the plan fit together — and to suggest itineraries
            everyone enjoys. Change it anytime in Profile.
          </p>
        </div>

        <InterestsForm value={value} onChange={setValue} />
        {error ? <p className="rounded-lg bg-error-container px-3 py-2 font-body-md text-body-md text-on-error-container">{error}</p> : null}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-40 bg-surface/90 shadow-[0_-2px_12px_rgba(16,32,28,0.05)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-[520px] flex-col gap-2 px-margin py-4">
          <button
            onClick={() => void submit("save")}
            disabled={!!busy || picked === 0}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-lg text-title-lg text-on-primary shadow-sm transition-colors hover:bg-primary disabled:opacity-40"
          >
            {busy === "save" ? "Saving…" : picked ? `Save my preferences (${picked})` : "Pick a few to continue"}
            <Icon name="arrow_forward" className="text-[22px]" />
          </button>
          <button onClick={() => void submit("skip")} disabled={!!busy} className="font-label-md text-label-md text-on-surface-variant hover:text-primary">
            {busy === "skip" ? "One moment…" : "Skip — I'll do it later in Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <InterestsPage />
    </Suspense>
  );
}

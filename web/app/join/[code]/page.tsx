"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, Spinner, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { portrait, tripCover } from "@/lib/covers";
import { formatDateRange } from "@/lib/dates";

type Preview = {
  trip: { name: string; destination: string; startDate: string; endDate: string; status: "active" | "closed" };
  members: { id: string; name: string; claimed: boolean }[];
};

export default function JoinPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const { toast } = useFeedback();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Preview>(`/api/join/${code}`)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not find that trip"));
  }, [code]);

  async function join(claimParticipantId?: string) {
    setBusy(true);
    try {
      const r = await api<{ tripId: string }>(`/api/join/${code}`, { body: claimParticipantId ? { claimParticipantId } : {} });
      router.push(`/trips/${r.tripId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not join", "error");
      setBusy(false);
    }
  }

  const unclaimed = preview?.members.filter((m) => !m.claimed) ?? [];
  const organiser = preview?.members.find((m) => m.claimed) ?? preview?.members[0];
  const cover = tripCover(preview?.trip.destination ?? "rainforest river", code);

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      {/* Hero */}
      <div className="relative h-72 w-full overflow-hidden">
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${cover}")` }} />
        <div className="absolute inset-0 bg-gradient-to-b from-inverse-surface/40 via-transparent to-inverse-surface/60" />
        <div className="relative z-10 mx-auto flex max-w-[520px] items-center justify-between px-margin pt-6">
          <Link href="/home" className="flex items-center gap-2 text-surface-bright">
            <Icon name="explore" className="text-[24px]" />
            <span className="font-headline-sm text-headline-sm">GroupTrip</span>
          </Link>
          <span className="rounded-full bg-surface/20 px-4 py-1.5 font-label-md text-label-md uppercase tracking-widest text-surface-bright backdrop-blur-md">Invitation</span>
        </div>
      </div>

      <main className="relative z-10 mx-auto -mt-16 flex w-full max-w-[520px] flex-1 flex-col gap-space-md px-margin pb-16">
        {error ? (
          <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-lowest p-space-xl text-center shadow-sm">
            <Icon name="link_off" className="text-[36px] text-primary" />
            <p className="font-title-lg text-title-lg text-on-surface">Invite not found</p>
            <p className="font-body-md text-body-md text-on-surface-variant">{error}</p>
            <Link href="/home" className="font-title-md text-title-md text-primary">
              Go home
            </Link>
          </div>
        ) : !preview ? (
          <div className="rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
            <Spinner label="Looking up the trip" />
          </div>
        ) : (
          <>
            {/* Invitation card */}
            <div className="flex items-start gap-4 rounded-xl bg-surface-container-lowest p-5 shadow-md">
              {organiser ? (
                <div className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={portrait(organiser.name)} alt="" className="h-16 w-16 rounded-full bg-surface-container object-cover" />
                  <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary-container text-on-primary ring-2 ring-surface-container-lowest">
                    <Icon name="flight_takeoff" className="text-[14px]" />
                  </span>
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">
                  {organiser ? `${organiser.name.split(" ")[0]}'s group invited you to` : "You're invited to"}
                </span>
                <h1 className="font-headline-md text-headline-md text-on-surface">{preview.trip.name}</h1>
                <span className="flex flex-wrap items-center gap-1 font-body-md text-body-md text-on-surface-variant">
                  <Icon name="location_on" className="text-[16px]" /> {preview.trip.destination} · {formatDateRange(preview.trip.startDate, preview.trip.endDate)}
                </span>
                <span className="mt-1 w-fit rounded-full bg-surface-container px-3 py-0.5 font-label-md text-label-md text-on-surface">
                  {preview.members.length} going · code {code}
                </span>
                {preview.trip.status === "closed" ? <span className="w-fit rounded-full bg-inverse-surface px-3 py-0.5 font-label-md text-label-md text-inverse-on-surface">This trip is closed</span> : null}
              </div>
            </div>

            {/* Who's in */}
            <div className="flex flex-col gap-3 rounded-xl bg-surface-container-lowest p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="rounded-full bg-primary-fixed/50 px-3 py-1 font-label-md text-label-md uppercase tracking-wider text-on-primary-fixed-variant">Who&apos;s going</span>
                <span className="flex items-center gap-1 font-label-md text-label-md text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {preview.members.length} travellers
                </span>
              </div>
              <div className="flex flex-col divide-y divide-outline-variant/30">
                {preview.members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 py-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={portrait(m.name)} alt="" className="h-10 w-10 rounded-full bg-surface-container object-cover" />
                    <span className="flex-1 font-title-md text-title-md text-on-surface">{m.name}</span>
                    <span className={`rounded-full px-2.5 py-0.5 font-label-sm text-label-sm ${m.claimed ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : "bg-surface-container text-on-surface-variant"}`}>
                      {m.claimed ? "On GroupTrip" : "Spot reserved"}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-surface-container-low p-3">
                <Icon name="shield" className="text-[18px] text-secondary" />
                <span className="font-label-md text-label-md text-on-surface-variant">Fair split: you only share costs for the bookings you&apos;re part of, and every change to your share is explained in the trip&apos;s ledger.</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3 rounded-t-[28px] bg-surface-container-lowest p-5 shadow-[0_-8px_24px_rgba(16,32,28,0.06)]">
              <div className="mx-auto h-1.5 w-12 rounded-full bg-outline-variant/60" />
              <h2 className="font-headline-md text-headline-md text-on-surface">Join the trip</h2>
              {!isLoaded ? (
                <Spinner />
              ) : !isSignedIn ? (
                <>
                  <p className="font-body-md text-body-md text-on-surface-variant">Log in with your email to join {preview.trip.name}.</p>
                  <Link
                    href={`/login?next=${encodeURIComponent(`/join/${code}`)}`}
                    className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary transition-colors hover:bg-primary"
                  >
                    <Icon name="login" className="text-[20px]" /> Log in to join
                  </Link>
                </>
              ) : preview.trip.status === "closed" ? (
                <p className="font-body-md text-body-md text-on-surface-variant">This trip is closed and can&apos;t take new members.</p>
              ) : (
                <>
                  {unclaimed.length ? (
                    <>
                      <p className="font-body-md text-body-md text-on-surface-variant">Already added by the organiser? Pick yourself to take over that spot — including anything already split with you.</p>
                      <div className="grid grid-cols-2 gap-2">
                        {unclaimed.map((m) => (
                          <button
                            key={m.id}
                            disabled={busy}
                            onClick={() => void join(m.id)}
                            className="flex items-center gap-2 rounded-xl bg-surface-container px-3 py-2.5 text-left transition-colors hover:bg-surface-container-high disabled:opacity-40"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={portrait(m.name)} alt="" className="h-8 w-8 rounded-full object-cover" />
                            <span className="truncate font-title-md text-title-md text-primary">I&apos;m {m.name.split(" ")[0]}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                  <button
                    disabled={busy}
                    onClick={() => void join()}
                    className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary transition-colors hover:bg-primary disabled:opacity-40"
                  >
                    <Icon name="person_add" className="text-[20px]" /> {busy ? "Joining…" : "Join as a new member"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

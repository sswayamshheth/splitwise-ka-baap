"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Icon, Spinner } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import type { ExploreListing } from "@/lib/explore";
import { formatMoney } from "@/lib/money";

const CATEGORY_ICONS: Record<string, string> = { Stay: "cottage", Transport: "train", Activity: "kayaking", Food: "restaurant", "Local travel": "local_taxi", Shopping: "shopping_bag", Other: "receipt_long" };

export default function ExplorePage() {
  const [data, setData] = useState<{ listings: ExploreListing[]; disclosure: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);

  useEffect(() => {
    api<{ listings: ExploreListing[]; disclosure: string }>("/api/catalog")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load Explore"));
  }, []);

  const tags = useMemo(() => [...new Set((data?.listings ?? []).flatMap((l) => l.tags))], [data]);
  const listings = (data?.listings ?? []).filter((l) => !tag || l.tags.includes(tag));

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-col gap-space-md px-margin pb-32 pt-space-sm">
      {/* Search-style context card */}
      <div className="flex items-center gap-3 rounded-xl bg-surface-container-lowest p-3 shadow-sm">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-container text-primary">
          <Icon name="travel_explore" className="text-[22px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-title-md text-title-md text-on-surface">Trips from travel advisors</span>
          <span className="truncate font-label-sm text-label-sm text-on-surface-variant">Curated packages · prices per person</span>
        </div>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-low text-primary">
          <Icon name="tune" className="text-[20px]" />
        </span>
      </div>

      {/* Filter pills */}
      {tags.length ? (
        <div className="no-scrollbar -mx-margin flex gap-space-sm overflow-x-auto px-margin">
          <button
            onClick={() => setTag(null)}
            className={`flex shrink-0 items-center gap-1 rounded-full px-space-md py-2 font-label-md text-label-md transition-colors ${!tag ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant"}`}
          >
            <Icon name="home_work" className="text-[16px]" /> All packages
          </button>
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? null : t)}
              className={`shrink-0 rounded-full px-space-md py-2 font-label-md text-label-md transition-colors ${tag === t ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant"}`}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}

      {data ? (
        <div className="flex items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2">
          <Icon name="campaign" className="text-[18px] text-secondary" />
          <span className="font-label-md text-label-md text-on-surface-variant">
            {data.disclosure} &ldquo;Plan this trip&rdquo; only pre-fills your plan — nothing is booked or charged.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
          <Icon name="cloud_off" className="text-[36px] text-primary" />
          <p className="font-title-md text-title-md text-on-surface">Couldn&apos;t load Explore</p>
          <p className="font-body-md text-body-md text-on-surface-variant">{error}</p>
        </div>
      ) : !data ? (
        <Spinner label="Loading packages" />
      ) : (
        listings.map((l) => (
          <article key={l.id} className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
            <div className="relative h-56 w-full bg-surface-container">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={l.image} alt={l.title} className="h-full w-full object-cover" loading="lazy" />
              <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/70 via-transparent to-transparent" />
              <span className="absolute left-3 top-3 rounded-md bg-surface/90 px-2 py-1 font-label-sm text-label-sm uppercase tracking-wider text-on-surface shadow-sm">Sponsored</span>
              <span className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-inverse-surface/40 text-surface-bright backdrop-blur-sm">
                <Icon name="favorite" className="text-[18px]" />
              </span>
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-between">
                <span className="flex items-center gap-1 font-title-md text-title-md text-surface-bright">
                  <Icon name="nights_stay" className="text-[18px]" /> {l.nights} nights
                </span>
                <span className="rounded-md bg-inverse-surface/60 px-2 py-0.5 font-label-md text-label-md text-surface-bright backdrop-blur-sm">{l.destination.split(",")[0]}</span>
              </div>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <h2 className="font-headline-sm text-headline-sm text-on-surface">{l.title}</h2>
              <p className="flex items-center gap-1.5 font-label-md text-label-md text-on-surface-variant">
                <Icon name="verified" className="text-[16px] text-primary" /> Sponsored · {l.advisor}
              </p>
              <p className="font-body-md text-body-md text-on-surface-variant">{l.blurb}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {l.items.map((i) => (
                  <span key={i.title} className="flex items-center gap-1.5 font-label-md text-label-md text-on-surface-variant">
                    <Icon name={CATEGORY_ICONS[i.category] ?? "check"} className="text-[16px] text-primary" />
                    {i.title} · {formatMoney(i.perPersonPaise)}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {l.tags.map((t) => (
                  <span key={t} className="rounded-full bg-surface-container px-2.5 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                    {t}
                  </span>
                ))}
              </div>
              <div className="mt-1 flex items-end justify-between gap-3">
                <div className="flex flex-col">
                  <span className="flex items-baseline gap-1">
                    <span className="font-currency-display text-currency-display text-on-surface">{formatMoney(l.fromPerPersonPaise)}</span>
                    <span className="font-label-md text-label-md text-on-surface-variant">/ person</span>
                  </span>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">Advisor estimate · {l.nights} nights</span>
                </div>
                <Link
                  href={`/trips/new?from=${l.id}`}
                  className="flex shrink-0 items-center gap-2 rounded-xl bg-primary-container px-4 py-3 font-title-md text-title-md text-on-primary shadow-sm transition-colors hover:bg-primary"
                >
                  Plan this trip <Icon name="arrow_forward" className="text-[20px]" />
                </Link>
              </div>
            </div>
          </article>
        ))
      )}
    </main>
  );
}

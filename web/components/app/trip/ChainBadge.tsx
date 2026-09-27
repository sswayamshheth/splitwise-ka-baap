"use client";

import { useEffect, useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { commitment } from "@/lib/chain/blocks";
import { api } from "@/lib/client/api";
import { useTrip } from "@/lib/client/trip";

type Anchor = { blocks: number; headHash: string; merkleRoot: string };

let chainEnabled: Promise<boolean> | null = null;
/** Whether the server has blockchain sealing set up (from /api/status). Null while loading; the feature stays hidden until true. */
export function useChainEnabled() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    chainEnabled ??= fetch("/api/status")
      .then((r) => r.json() as Promise<{ chain?: boolean }>)
      .then((s) => !!s.chain)
      .catch(() => {
        chainEnabled = null; // retry on the next mount
        return false;
      });
    void chainEnabled.then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

/** Live seal status for the trip page card: checked in the browser against the anchors read from Ethereum. */
export function ChainBadge() {
  const trip = useTrip();
  const [state, setState] = useState<{ configured: boolean; anchors: Anchor[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ status: { configured: boolean }; anchors: Anchor[] }>(`/api/trips/${trip.tripId}/chain`)
      .then((r) => alive && setState({ configured: r.status.configured, anchors: r.anchors }))
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [trip.tripId, trip.events.length]);

  const total = trip.events.length;
  if (!state) return <span className="font-label-sm text-label-sm text-on-surface-variant">Checking Ethereum…</span>;
  if (!state.configured) return <span className="font-label-sm text-label-sm text-on-surface-variant">{total} blocks · not connected to Ethereum</span>;
  const ok = state.anchors.every((a) => {
    const c = commitment(trip.events.slice(0, a.blocks));
    return trip.events.length >= a.blocks && c.headHash === a.headHash && c.merkleRoot === a.merkleRoot;
  });
  const sealed = state.anchors.at(-1)?.blocks ?? 0;
  const label = !ok ? "History changed since it was sealed" : sealed === 0 ? `${total} blocks · not sealed yet` : sealed === total ? `Sealed on Ethereum ✓ ${sealed}/${total} blocks` : `Sealed ✓ ${sealed}/${total} · ${total - sealed} new to seal`;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-label-sm text-label-sm", !ok ? "bg-error-container text-on-error-container" : sealed ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : "bg-surface-container text-on-surface-variant")}>
      <Icon name={!ok ? "gpp_bad" : sealed ? "verified" : "schedule"} className="text-[14px]" />
      {label}
    </span>
  );
}

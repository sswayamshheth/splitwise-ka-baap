import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { anchorTrip, chainStatus, pendingAnchor, readAnchors, tripKey } from "@/lib/server/chain";
import { loadTripForUser, requireUserId, route } from "@/lib/server/trips";

type Ctx = { params: { id: string } };

/** The trip's on-chain anchors (read live from Sepolia) and the connection status. Blocks are computed in the browser. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { trip } = await loadTripForUser(params.id, userId);
  const status = await chainStatus();
  if (!status.configured) return NextResponse.json({ status, tripKey: null, anchors: [], pending: null, readError: null });
  let anchors: Awaited<ReturnType<typeof readAnchors>> = [];
  let readError: string | null = null;
  try {
    anchors = await readAnchors(trip.id);
  } catch (e) {
    console.error("[chain] read failed:", String((e as { code?: unknown })?.code ?? "unknown"));
    readError = "Couldn't read the seals from Ethereum right now";
  }
  return NextResponse.json({ status, tripKey: status.configured ? tripKey(trip.id) : null, anchors, pending: pendingAnchor(trip.id), readError });
});

/** Seal the trip's current chain on Sepolia (any member of the trip may do this). */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { trip, events } = await loadTripForUser(params.id, userId);
  return NextResponse.json(await anchorTrip(trip.id, events));
});

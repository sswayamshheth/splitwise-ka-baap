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
  let anchors: Awaited<ReturnType<typeof readAnchors>> = [];
  let readError: string | null = null;
  try {
    anchors = await readAnchors(trip.id);
  } catch (e) {
    readError = `Couldn't read the contract: ${(e as Error).message.slice(0, 140)}`;
  }
  return NextResponse.json({ status, tripKey: status.configured ? tripKey(trip.id) : null, anchors, pending: pendingAnchor(trip.id), readError });
});

/** Seal the trip's current chain on Sepolia (any member of the trip may do this). */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { trip, events } = await loadTripForUser(params.id, userId);
  return NextResponse.json(await anchorTrip(trip.id, events));
});

import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { repo } from "@/lib/server/repo";
import { HttpError, loadTripForUser, requireUserId, route, syncTripRow, validateAppend } from "@/lib/server/trips";

type Ctx = { params: { id: string } };

/**
 * Append to a trip's ledger. `baseSeq` is the log length the client built
 * its change on; if someone else wrote first the request gets 409 with the
 * current log, and the client rebuilds its change on top of it.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { member, events: existing } = await loadTripForUser(params.id, userId);
  const body = (await req.json().catch(() => null)) as { baseSeq?: number; events?: unknown } | null;
  if (typeof body?.baseSeq !== "number") throw new HttpError(400, "baseSeq is required");
  if (body.baseSeq !== existing.length) {
    throw new HttpError(409, "The trip changed — refresh and try again", { seq: existing.length, events: existing });
  }
  const { events, state } = validateAppend(existing, body.events, member);
  const r = await repo();
  const result = await r.appendEvents(params.id, body.baseSeq, events);
  if (!result.ok) {
    throw new HttpError(409, "The trip changed — refresh and try again", { seq: result.seq, events: await r.getEvents(params.id) });
  }
  await syncTripRow(params.id, state);
  return NextResponse.json({ seq: result.seq, events });
});

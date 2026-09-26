import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { createPaymentRequest, syncPaymentRequests } from "@/lib/server/payments";
import { requireUserId, route } from "@/lib/server/trips";

type Ctx = { params: { id: string } };

/** Open payment requests, checked against Razorpay right now — paid ones are recorded automatically. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  return NextResponse.json(await syncPaymentRequests(params.id, userId));
});

/** Ask a member to pay (their pool share, or what they owe me) through a Razorpay payment link. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(await createPaymentRequest(userId, { ...body, tripId: params.id }), { status: 201 });
});

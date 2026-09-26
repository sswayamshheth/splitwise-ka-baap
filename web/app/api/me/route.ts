import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { repo } from "@/lib/server/repo";
import { HttpError, requireProfile, route } from "@/lib/server/trips";

export const GET = route(async () => {
  const profile = await requireProfile();
  const stored = await (await repo()).getProfile(profile.userId);
  return NextResponse.json({ profile, onboarded: !!stored?.name });
});

export const PUT = route(async (req: Request) => {
  const profile = await requireProfile();
  const body = (await req.json().catch(() => ({}))) as { name?: string; upiId?: string };
  const name = (body.name ?? profile.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new HttpError(400, "Tell us your name");
  if (name.length > 40) throw new HttpError(400, "Keep your name under 40 characters");
  const upi = body.upiId?.trim() || undefined;
  if (upi && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(upi)) throw new HttpError(400, "UPI IDs look like name@bank");
  const saved = await (await repo()).upsertProfile({ ...profile, name, upiId: upi });
  return NextResponse.json({ profile: saved, onboarded: true });
});

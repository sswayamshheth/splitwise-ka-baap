import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { inferCard } from "@/lib/cards";
import { newId } from "@/lib/id";
import { normaliseInterests } from "@/lib/interests";
import { repo, type SavedCard } from "@/lib/server/repo";
import { HttpError, requireProfile, route } from "@/lib/server/trips";

export const GET = route(async () => {
  const profile = await requireProfile();
  const stored = await (await repo()).getProfile(profile.userId);
  return NextResponse.json({ profile, onboarded: !!stored?.name, needsInterests: !!stored?.name && !stored?.interestsAsked });
});

/**
 * Update my profile. Any subset of: name, upiId, interests (null clears),
 * interestsAsked (the optional preferences page was shown/skipped), cards
 * (names only — e.g. "HDFC Regalia Visa"; card numbers are never accepted).
 */
export const PUT = route(async (req: Request) => {
  const profile = await requireProfile();
  const body = (await req.json().catch(() => ({}))) as { name?: string; upiId?: string | null; interests?: unknown; interestsAsked?: boolean; cards?: unknown };
  const r = await repo();
  const stored = await r.getProfile(profile.userId);
  const next = { ...profile, ...(stored ?? {}) };

  if (body.name !== undefined || !next.name) {
    const name = (body.name ?? next.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) throw new HttpError(400, "Tell us your name");
    if (name.length > 40) throw new HttpError(400, "Keep your name under 40 characters");
    next.name = name;
  }
  if (body.upiId !== undefined) {
    const upi = body.upiId?.trim() || undefined;
    if (upi && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(upi)) throw new HttpError(400, "UPI IDs look like name@bank");
    next.upiId = upi;
  }
  if (body.interests !== undefined) {
    next.interests = body.interests === null ? undefined : normaliseInterests(body.interests);
    next.interestsAsked = true;
  }
  if (body.interestsAsked) next.interestsAsked = true;
  if (body.cards !== undefined) {
    if (!Array.isArray(body.cards) || body.cards.length > 10) throw new HttpError(400, "Up to 10 cards or accounts");
    const cards: SavedCard[] = [];
    for (const raw of body.cards) {
      const name = typeof raw === "string" ? raw : typeof raw === "object" && raw && typeof (raw as { name?: unknown }).name === "string" ? (raw as { name: string }).name : "";
      const clean = name.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (clean.length > 60) throw new HttpError(400, "Card names must be under 60 characters");
      // Refuse anything that looks like a card or account number — names only.
      if (/\d{6,}/.test(clean.replace(/[\s-]/g, ""))) throw new HttpError(400, "Enter the card's name only — never its number");
      const inferred = inferCard(clean);
      const existing = (next.cards ?? []).find((c) => c.label.toLowerCase() === inferred.label.toLowerCase());
      cards.push({ id: existing?.id ?? newId("card"), ...inferred });
    }
    next.cards = cards;
  }
  const saved = await r.upsertProfile(next);
  return NextResponse.json({ profile: saved, onboarded: true, needsInterests: !saved.interestsAsked });
});

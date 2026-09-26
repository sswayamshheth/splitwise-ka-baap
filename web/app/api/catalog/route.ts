import { NextResponse } from "next/server";

import { EXPLORE_LISTINGS } from "@/lib/explore";

/** Explore feed: paid placements from travel advisors (curated demo catalogue). */
export async function GET() {
  return NextResponse.json({ listings: EXPLORE_LISTINGS, disclosure: "Sponsored — advisors pay GroupTrip to appear here. Prices are the advisor's estimates." });
}

import type { ExpenseCategory } from "@/lib/ledger/types";

/**
 * Explore: packaged trips from travel advisors who pay for placement. This
 * is a curated demo catalogue (prototype) — every card is labelled as a paid
 * placement, and "Plan this trip" only pre-fills a new trip's itinerary with
 * the advisor's estimates; nothing is booked or charged.
 */

export type ExploreItem = { title: string; category: ExpenseCategory; day: number; perPersonPaise: number; vendor?: string; nights?: number };

export type ExploreListing = {
  id: string;
  advisor: string;
  title: string;
  destination: string;
  nights: number;
  fromPerPersonPaise: number;
  image: string;
  tags: string[];
  blurb: string;
  items: ExploreItem[];
};

const img = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=70`;

export const EXPLORE_LISTINGS: ExploreListing[] = [
  {
    id: "goa-north-4n",
    advisor: "Coastline Journeys",
    title: "North Goa beaches & scuba",
    destination: "Candolim, North Goa",
    nights: 4,
    fromPerPersonPaise: 18_900_00,
    image: img("photo-1512343879784-a960bf40e7f2"),
    tags: ["Beaches", "Scuba", "Nightlife"],
    blurb: "Pool villa in Candolim, a Grande Island dive, and a sunset cruise on the Mandovi.",
    items: [
      { title: "Villa with pool · 4 nights", category: "Stay", day: 0, perPersonPaise: 9_000_00, vendor: "Coastline Villas", nights: 4 },
      { title: "Airport transfers", category: "Local travel", day: 0, perPersonPaise: 600_00 },
      { title: "Scuba at Grande Island", category: "Activity", day: 1, perPersonPaise: 3_500_00, vendor: "Goa Dive Centre" },
      { title: "Mandovi sunset cruise", category: "Activity", day: 2, perPersonPaise: 1_200_00 },
      { title: "Meals & beach shacks", category: "Food", day: 1, perPersonPaise: 4_600_00 },
    ],
  },
  {
    id: "manali-5n",
    advisor: "Himalayan Trails Co.",
    title: "Manali snow & Solang adventure",
    destination: "Manali, Himachal Pradesh",
    nights: 5,
    fromPerPersonPaise: 21_500_00,
    image: img("photo-1626621341517-bbf3d9990a23"),
    tags: ["Mountains", "Paragliding", "Road trip"],
    blurb: "Old Manali homestay, paragliding at Solang, Rohtang day trip and a Beas rafting run.",
    items: [
      { title: "Volvo · Delhi ⇄ Manali", category: "Transport", day: 0, perPersonPaise: 3_600_00 },
      { title: "Homestay · 5 nights", category: "Stay", day: 1, perPersonPaise: 8_500_00, nights: 5 },
      { title: "Paragliding at Solang", category: "Activity", day: 2, perPersonPaise: 4_500_00 },
      { title: "Rohtang permits & cab", category: "Local travel", day: 3, perPersonPaise: 1_900_00 },
      { title: "Meals", category: "Food", day: 1, perPersonPaise: 3_000_00 },
    ],
  },
  {
    id: "coorg-3n",
    advisor: "Western Ghats Getaways",
    title: "Coorg coffee estate weekend",
    destination: "Madikeri, Coorg",
    nights: 3,
    fromPerPersonPaise: 12_400_00,
    image: img("photo-1596422846543-75c6fc197f07"),
    tags: ["Coffee estate", "Waterfalls", "Slow travel"],
    blurb: "Plantation stay with estate walks, Abbey Falls and a Dubare elephant camp morning.",
    items: [
      { title: "Estate bungalow · 3 nights", category: "Stay", day: 0, perPersonPaise: 7_200_00, nights: 3 },
      { title: "Estate walk & tasting", category: "Activity", day: 1, perPersonPaise: 900_00 },
      { title: "Dubare & Abbey Falls cab", category: "Local travel", day: 2, perPersonPaise: 1_300_00 },
      { title: "Kodava meals", category: "Food", day: 0, perPersonPaise: 3_000_00 },
    ],
  },
  {
    id: "rishikesh-3n",
    advisor: "Ganga Base Camps",
    title: "Rishikesh rafting & riverside camp",
    destination: "Shivpuri, Rishikesh",
    nights: 3,
    fromPerPersonPaise: 9_800_00,
    image: img("photo-1592897813934-cd1f1e1a64e1"),
    tags: ["Rafting", "Camping", "Budget"],
    blurb: "Grade III–IV rafting, a riverside tent camp and an evening Ganga aarti.",
    items: [
      { title: "Riverside camp · 3 nights", category: "Stay", day: 0, perPersonPaise: 4_500_00, nights: 3 },
      { title: "16 km rafting run", category: "Activity", day: 1, perPersonPaise: 1_800_00 },
      { title: "Train · Delhi ⇄ Haridwar", category: "Transport", day: 0, perPersonPaise: 1_600_00 },
      { title: "Meals at camp", category: "Food", day: 0, perPersonPaise: 1_900_00 },
    ],
  },
];

export function listingById(id: string) {
  return EXPLORE_LISTINGS.find((l) => l.id === id);
}

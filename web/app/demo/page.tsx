import Link from "next/link";

/** The team's converted Stitch design screens (static mockups), kept for reference. */
export default function DemoIndex() {
  const screens = ["ai-trip-builder", "settle", "expenses", "money-pool", "itinerary"];
  return (
    <div className="p-8">
      <h1 className="mb-4 text-2xl font-bold">GroupTrip design mockups (static)</h1>
      <ul className="space-y-2">
        {screens.map((s) => (
          <li key={s}>
            <Link href={`/demo/${s}`} className="text-primary hover:underline">
              {s}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

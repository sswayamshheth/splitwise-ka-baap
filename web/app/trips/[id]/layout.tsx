import { TripShell } from "@/components/app/TripShell";

export default function TripLayout({ children, params }: { children: React.ReactNode; params: { id: string } }) {
  return <TripShell tripId={params.id}>{children}</TripShell>;
}

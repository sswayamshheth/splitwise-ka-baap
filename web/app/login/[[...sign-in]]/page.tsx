import { EmailLogin } from "@/components/app/EmailLogin";
import { AuthHero } from "@/components/app/home/AuthHero";

export default function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = searchParams.next?.startsWith("/") ? searchParams.next : "/home";
  return (
    <AuthHero
      eyebrow="Shared journeys · one ledger"
      title="GroupTrip"
      subtitle="Plan it together. Split it fairly."
      footer="Prototype: payments are simulated — no money moves through this app."
    >
      <EmailLogin next={next} />
    </AuthHero>
  );
}

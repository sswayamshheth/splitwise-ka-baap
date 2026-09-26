import { MainShell } from "@/components/app/MainShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <MainShell>{children}</MainShell>;
}

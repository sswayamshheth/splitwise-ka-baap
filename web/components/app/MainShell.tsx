"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/client/api";
import { cx, Icon, initials, Spinner } from "./kit";

const TABS = [
  { href: "/home", label: "Home", icon: "explore" },
  { href: "/explore", label: "Explore", icon: "travel_explore" },
  { href: "/ledger", label: "Ledger", icon: "account_balance_wallet" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

type Me = { name: string; email?: string };
const MeContext = createContext<{ me: Me | null; refreshMe: () => void }>({ me: null, refreshMe: () => undefined });
export const useMe = () => useContext(MeContext);

/**
 * The signed-in app in the Stitch "Serene Voyage" chrome: frosted header with
 * the GroupTrip wordmark and avatar, frosted bottom bar with four tabs. The
 * floating "+" (new trip / join a trip) lives on Home only. The profile is
 * loaded ONCE per session — switching tabs never shows a spinner.
 */
export function MainShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState(false);
  const checked = useRef(false);

  const load = () =>
    api<{ onboarded: boolean; needsInterests: boolean; profile: Me }>("/api/me")
      .then((r) => {
        if (!r.onboarded) {
          router.replace(`/onboarding?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setMe(r.profile);
        setReady(true);
        // The preferences page is optional and asked once.
        if (r.needsInterests && !checked.current) router.push(`/onboarding/interests?next=${encodeURIComponent(window.location.pathname)}`);
        checked.current = true;
      })
      .catch(() => setReady(true));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setMenu(false), [pathname]);

  const current = TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
  const onHome = current?.href === "/home";

  return (
    <MeContext.Provider value={{ me, refreshMe: () => void load() }}>
      <div className="flex min-h-screen flex-col bg-surface">
        <header className="fixed top-0 z-50 w-full bg-surface/85 shadow-[0_1px_8px_rgba(16,32,28,0.03)] backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-[520px] items-center justify-between px-margin">
            <Link href="/home" className="flex items-center gap-space-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/30 text-primary">
                <Icon name="explore" className="text-[22px]" />
              </span>
              <span className="font-headline-sm text-headline-sm tracking-tight text-on-surface">GroupTrip</span>
            </Link>
            <div className="flex items-center gap-space-sm">
              {current ? <span className="font-title-md text-title-md text-primary">{current.label}</span> : null}
              <Link href="/profile" aria-label="Your profile" className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-surface-variant">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container font-label-md text-label-md text-on-primary ring-2 ring-primary/20">{me?.name ? initials(me.name) : "·"}</span>
              </Link>
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col pt-16">{ready ? children : <Spinner label="Loading" />}</div>

        {onHome ? (
          <div className="fixed bottom-24 z-50 flex flex-col items-end gap-2" style={{ right: "max(1.25rem, calc(50vw - 260px + 1.25rem))" }}>
            {menu ? (
              <div className="mb-1 flex flex-col gap-2">
                <Link href="/trips/new" className="flex items-center gap-2 rounded-full bg-surface-container-lowest px-4 py-2.5 font-title-md text-title-md text-on-surface shadow-lg hover:bg-surface-container-low">
                  <Icon name="add_location_alt" className="text-[20px] text-primary" /> New trip
                </Link>
                <Link href="/home?join=1" className="flex items-center gap-2 rounded-full bg-surface-container-lowest px-4 py-2.5 font-title-md text-title-md text-on-surface shadow-lg hover:bg-surface-container-low">
                  <Icon name="group_add" className="text-[20px] text-primary" /> Join with a code
                </Link>
              </div>
            ) : null}
            <button
              onClick={() => setMenu((m) => !m)}
              aria-label={menu ? "Close" : "New trip or join"}
              aria-expanded={menu}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-on-primary shadow-[0_8px_20px_rgba(30,111,100,0.35)] transition-all duration-200 hover:bg-primary active:scale-95"
            >
              <Icon name={menu ? "close" : "add"} className="text-[30px]" />
            </button>
          </div>
        ) : null}

        <nav className="fixed bottom-0 z-50 w-full bg-surface/85 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(16,32,28,0.04)] backdrop-blur-xl">
          <div className="mx-auto flex h-20 max-w-[520px] items-center justify-around px-space-xs">
            {TABS.map((t) => {
              const active = current?.href === t.href;
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  prefetch
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex min-h-[44px] min-w-[56px] flex-col items-center justify-center gap-space-xs transition-colors",
                    active ? "font-semibold text-primary-container" : "text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  <Icon name={t.icon} filled={active} className="text-[24px]" />
                  <span className="font-label-md text-label-md">{t.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </MeContext.Provider>
  );
}

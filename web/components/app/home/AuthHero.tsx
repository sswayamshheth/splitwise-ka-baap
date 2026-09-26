import type { ReactNode } from "react";

import { Icon } from "../kit";
import { SIGNUP_HERO } from "./signup-hero";

/**
 * Full-bleed misty-forest hero from the Stitch sign_up screen: brand mark at
 * the top, editorial title block and actions anchored at the bottom over a
 * deep green scrim. Used by login and onboarding.
 */
export function AuthHero({ eyebrow, title, subtitle, children, footer }: { eyebrow: string; title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-inverse-surface">
      <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${SIGNUP_HERO}")` }} />
      <div className="absolute inset-0 bg-gradient-to-b from-inverse-surface/10 via-inverse-surface/40 to-inverse-surface" />

      <header className="relative z-10 mx-auto flex w-full max-w-[520px] items-center justify-between px-margin pt-8">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20 text-surface-bright backdrop-blur-md">
            <Icon name="explore" className="text-[26px]" />
          </span>
          <span className="font-headline-md text-headline-md text-surface-bright">GroupTrip</span>
        </div>
        <span className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-1.5 font-label-md text-label-md uppercase tracking-widest text-surface-bright backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-primary-fixed-dim" /> Prototype
        </span>
      </header>

      <main className="relative z-10 mx-auto mt-auto flex w-full max-w-[520px] flex-col gap-6 px-margin pb-8 pt-24">
        <div className="flex flex-col gap-2">
          <span className="font-label-md text-label-md uppercase tracking-[0.2em] text-surface-bright/80">{eyebrow}</span>
          <h1 className="font-display-lg text-display-lg text-surface-bright">{title}</h1>
          <p className="font-body-lg text-body-lg text-surface-bright/90">{subtitle}</p>
          <span className="mt-3 h-0.5 w-16 rounded-full bg-surface-bright/40" />
        </div>
        {children}
        {footer ? <div className="text-center font-label-md text-label-md text-surface-bright/70">{footer}</div> : null}
      </main>
    </div>
  );
}

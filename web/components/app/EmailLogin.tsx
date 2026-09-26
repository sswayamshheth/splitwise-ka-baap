"use client";

import { useAuth, useSignIn, useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Icon } from "./kit";

/**
 * Email login with a real one-time code (Clerk email_code). One screen for new
 * and returning users: we try to sign in; if the address has no account yet we
 * sign it up with the same code flow. Phone-number login is a Pro feature
 * (see PhoneLogin.tsx) and is shown here as such.
 */

type ClerkErr = { errors?: { code?: string; message?: string; longMessage?: string }[] };
const clerkMessage = (e: unknown) => {
  const first = (e as ClerkErr)?.errors?.[0];
  return first?.longMessage || first?.message || (e instanceof Error ? e.message : "Something went wrong");
};
const clerkCode = (e: unknown) => (e as ClerkErr)?.errors?.[0]?.code;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function EmailLogin({ next = "/home" }: { next?: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = email.trim().toLowerCase();
  const valid = EMAIL_RE.test(address);
  const loaded = signInLoaded && signUpLoaded;

  // Client-side navigation can stall after sign-in (seen in the installed iOS PWA),
  // so fall back to a full page load if the route hasn't changed.
  const leaving = useRef(false);
  function go(to: string) {
    if (leaving.current) return;
    leaving.current = true;
    const from = window.location.pathname;
    router.replace(to);
    window.setTimeout(() => {
      if (window.location.pathname === from) window.location.assign(to);
    }, 1500);
  }

  // Already signed in (e.g. a retry after a stalled redirect): don't show the form.
  // Skipped while a code is being verified, so verify() picks the destination
  // (new accounts go to onboarding).
  useEffect(() => {
    if (authLoaded && isSignedIn && !busy) go(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn, busy, next]);

  async function sendCode() {
    if (!loaded || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: address });
      const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === "email_code") as { emailAddressId: string } | undefined;
      if (!factor) throw new Error("Email codes aren't enabled for sign-in on this account.");
      await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
      setMode("signin");
      setStep("code");
    } catch (e) {
      if (clerkCode(e) === "session_exists") {
        go(next);
      } else if (clerkCode(e) === "form_identifier_not_found") {
        // New address: create the account, verified by the same kind of code.
        try {
          await signUp.create({ emailAddress: address });
          await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
          setMode("signup");
          setStep("code");
        } catch (e2) {
          if (clerkCode(e2) === "session_exists") go(next);
          else setError(clerkMessage(e2));
        }
      } else {
        setError(clerkMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!loaded || code.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        const res = await signIn.attemptFirstFactor({ strategy: "email_code", code });
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
          go(next);
          return;
        }
        setError(`Sign-in needs another step (${res.status}).`);
      } else {
        const res = await signUp.attemptEmailAddressVerification({ code });
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
          go(`/onboarding?next=${encodeURIComponent(next)}`);
          return;
        }
        setError(
          res.status === "missing_requirements"
            ? `Your account still needs: ${res.missingFields.join(", ")}.`
            : `Sign-up needs another step (${res.status}).`,
        );
      }
    } catch (e) {
      if (clerkCode(e) === "session_exists") go(next);
      else setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") await signUp?.prepareEmailAddressVerification({ strategy: "email_code" });
      else await sendCode();
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const darkInput =
    "h-14 w-full rounded-xl border border-white/15 bg-white/10 px-4 font-body-lg text-body-lg text-surface-bright outline-none backdrop-blur-md transition-colors placeholder:text-surface-bright/50 focus:border-primary-fixed-dim focus:bg-white/15";

  return (
    <div className="flex w-full flex-col gap-3">
      {step === "email" ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="font-label-md text-label-md uppercase tracking-widest text-surface-bright/70">Email</span>
            <input
              className={darkInput}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void sendCode()}
              autoFocus
            />
          </label>
          <button
            disabled={!valid || busy || !loaded}
            onClick={() => void sendCode()}
            className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-surface-container-lowest font-title-lg text-title-lg text-on-surface shadow-md transition-transform active:scale-[0.99] disabled:opacity-50"
          >
            <Icon name="mail" className="text-[22px] text-primary" />
            {busy ? "Sending code…" : "Continue with email"}
          </button>
          <span className="text-center font-label-md text-label-md text-surface-bright/70">We&apos;ll email you a 6-digit code — no password needed.</span>
        </>
      ) : (
        <>
          <p className="font-body-md text-body-md text-surface-bright/80">
            Code sent to <span className="font-title-md text-surface-bright">{address}</span>
            {mode === "signup" ? " · new account" : ""}. Check spam if it isn&apos;t there in a minute.
          </p>
          <input
            className={`${darkInput} text-center font-title-lg tracking-[0.5em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            aria-label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void verify()}
            autoFocus
          />
          <button
            disabled={code.length < 6 || busy}
            onClick={() => void verify()}
            className="flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-surface-container-lowest font-title-lg text-title-lg text-on-surface shadow-md transition-transform active:scale-[0.99] disabled:opacity-50"
          >
            <Icon name="check_circle" className="text-[22px] text-primary" />
            {busy ? "Verifying…" : "Verify & continue"}
          </button>
          <div className="flex items-center justify-between">
            <button
              className="flex items-center gap-1 font-label-md text-label-md text-primary-fixed-dim"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              <Icon name="edit" className="text-[16px]" /> Change email
            </button>
            <button className="font-label-md text-label-md text-primary-fixed-dim disabled:opacity-40" disabled={busy} onClick={() => void resend()}>
              Resend code
            </button>
          </div>
        </>
      )}
      {error ? <p className="rounded-lg bg-error-container/90 px-3 py-2 font-body-md text-body-md text-on-error-container">{error}</p> : null}

      <div className="flex h-14 w-full cursor-not-allowed items-center justify-center gap-3 rounded-xl bg-white/10 font-title-lg text-title-lg text-surface-bright/80 backdrop-blur-md" aria-disabled="true" title="Phone login is a GroupTrip Pro feature">
        <Icon name="smartphone" className="text-[22px]" />
        Continue with phone
        <span className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2 py-0.5 font-label-sm text-label-sm text-on-secondary-container">
          <Icon name="workspace_premium" className="text-[14px]" /> Pro
        </span>
      </div>

      {/* Clerk's bot protection (enabled on this instance) mounts here during sign-up. */}
      <div id="clerk-captcha" />
    </div>
  );
}

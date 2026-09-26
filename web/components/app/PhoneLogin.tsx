"use client";

import { useSignIn, useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Field, Icon, inputCls, Notice } from "./kit";

/**
 * GroupTrip Pro: phone-number login with a real SMS one-time code (Clerk).
 * Not mounted in the free app (email login is the default); needs Phone
 * enabled in the Clerk dashboard. One screen for
 * both new and returning users: we try to sign in; if the number has no
 * account yet we sign it up instead — the user just types a number and a code.
 */

type ClerkErr = { errors?: { code?: string; message?: string; longMessage?: string }[] };
const clerkMessage = (e: unknown) => {
  const first = (e as ClerkErr)?.errors?.[0];
  return first?.longMessage || first?.message || (e instanceof Error ? e.message : "Something went wrong");
};
const clerkCode = (e: unknown) => (e as ClerkErr)?.errors?.[0]?.code;

export function PhoneLogin({ next = "/home" }: { next?: string }) {
  const router = useRouter();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupHint, setSetupHint] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  const e164 = digits.length === 10 ? `+91${digits}` : phone.trim().startsWith("+") ? `+${phone.replace(/\D/g, "")}` : "";
  const validPhone = /^\+\d{10,15}$/.test(e164);

  async function sendCode() {
    if (!signInLoaded || !signUpLoaded || !validPhone) return;
    setBusy(true);
    setError(null);
    setSetupHint(null);
    try {
      const attempt = await signIn.create({ identifier: e164 });
      const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === "phone_code") as { phoneNumberId: string } | undefined;
      if (!factor) {
        setSetupHint("Phone sign-in isn't enabled on this Clerk instance. In the Clerk dashboard turn on Phone number → sign in with SMS verification code.");
        return;
      }
      await signIn.prepareFirstFactor({ strategy: "phone_code", phoneNumberId: factor.phoneNumberId });
      setMode("signin");
      setStep("code");
    } catch (e) {
      if (clerkCode(e) === "form_identifier_not_found") {
        // New number: create the account and verify it with the same SMS code flow.
        try {
          await signUp.create({ phoneNumber: e164 });
          await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
          setMode("signup");
          setStep("code");
        } catch (e2) {
          const c = clerkCode(e2);
          if (c === "form_param_unknown" || c === "form_identifier_invalid" || /phone/i.test(clerkMessage(e2)))
            setSetupHint("Sign-up with a phone number is turned off in the Clerk dashboard (Configure → User & authentication → Phone).");
          setError(clerkMessage(e2));
        }
      } else {
        setError(clerkMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!signInLoaded || !signUpLoaded || code.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") {
        const res = await signIn.attemptFirstFactor({ strategy: "phone_code", code });
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
          router.replace(next);
          return;
        }
        setError(`Sign-in needs another step (${res.status}).`);
      } else {
        const res = await signUp.attemptPhoneNumberVerification({ code });
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
          router.replace(`/onboarding?next=${encodeURIComponent(next)}`);
          return;
        }
        if (res.status === "missing_requirements") {
          setSetupHint(`Clerk still requires: ${res.missingFields.join(", ")}. Make those optional in the Clerk dashboard so phone-only sign-up completes.`);
        }
        setError(`Sign-up needs another step (${res.status}).`);
      }
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-space-md">
      {step === "phone" ? (
        <>
          <Field label="Mobile number" hint="We'll text you a one-time code. Standard SMS rates apply.">
            <div className="flex gap-space-sm">
              <span className="flex h-12 items-center rounded-xl bg-surface-container px-space-md font-title-md text-on-surface">+91</span>
              <input
                className={inputCls}
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendCode()}
                autoFocus
              />
            </div>
          </Field>
          <Button full icon="sms" disabled={!validPhone || busy} onClick={() => void sendCode()}>
            {busy ? "Sending code…" : "Send code"}
          </Button>
        </>
      ) : (
        <>
          <p className="font-body-md text-body-md text-on-surface-variant">
            Code sent to <span className="font-title-md text-on-surface">{e164}</span>
            {mode === "signup" ? " · new account" : ""}
          </p>
          <Field label="6-digit code">
            <input
              className={`${inputCls} tracking-[0.5em] text-center font-title-lg`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && void verify()}
              autoFocus
            />
          </Field>
          <Button full icon="check" disabled={code.length < 6 || busy} onClick={() => void verify()}>
            {busy ? "Verifying…" : "Verify & continue"}
          </Button>
          <button
            className="flex items-center justify-center gap-1 font-label-md text-label-md text-primary"
            onClick={() => {
              setStep("phone");
              setCode("");
              setError(null);
            }}
          >
            <Icon name="edit" className="text-[16px]" /> Change number
          </button>
        </>
      )}
      {error ? <p className="font-body-md text-body-md text-error">{error}</p> : null}
      {setupHint ? (
        <Notice tone="amber" icon="settings" title="Setup needed">
          {setupHint}
        </Notice>
      ) : null}
      {/* Clerk's bot protection mounts here when enabled. */}
      <div id="clerk-captcha" />
    </div>
  );
}

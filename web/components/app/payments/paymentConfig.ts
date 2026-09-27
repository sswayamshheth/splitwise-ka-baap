"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import type { Config } from "./RazorpayPool";

// One request per page load, shared by every sheet (retried if it failed), so options don't flicker in and out.
let cached: Config | null = null;
let pending: Promise<Config | null> | null = null;
function loadConfig(): Promise<Config | null> {
  if (cached) return Promise.resolve(cached);
  pending ??= api<Config>("/api/payments/config")
    .then((c) => (cached = c))
    .catch(() => {
      pending = null; // try again next time
      return null;
    });
  return pending;
}

/** The server's payment mode (/api/payments/config); null while loading. */
export function usePaymentConfig() {
  const [config, setConfig] = useState<Config | null>(cached);
  useEffect(() => {
    let alive = true;
    void loadConfig().then((c) => alive && c && setConfig(c));
    return () => {
      alive = false;
    };
  }, []);
  return config;
}

/**
 * Whether real UPI payments (upi:// links that open the payer's own UPI app) may be offered.
 * They go bank to bank without Razorpay, so they're offered even when Razorpay has no keys
 * (a fresh deploy runs Razorpay in demo mode) — every screen labels them as real payments.
 */
export function useRealUpiAllowed() {
  return true;
}

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
 * They move real money, so they stay hidden while payments run in demo mode (and while loading).
 */
export function useRealUpiAllowed() {
  const config = usePaymentConfig();
  // Hidden only when the server has said payments run in demo mode — not while loading or after a network blip.
  return !config || config.mode !== "demo";
}

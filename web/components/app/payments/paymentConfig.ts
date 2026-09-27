"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import type { Config } from "./RazorpayPool";

/** The server's payment mode (/api/payments/config); null while loading. */
export function usePaymentConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    let alive = true;
    api<Config>("/api/payments/config")
      .then((c) => alive && setConfig(c))
      .catch(() => undefined);
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
  return !!config && config.mode !== "demo";
}

"use client";

import { useEffect } from "react";

/**
 * Suppresses errors from browser wallet extensions (Phantom, Solflare, etc.)
 * that try to inject providers into the page.
 * These errors are harmless — the dashboard doesn't use any wallet connection.
 */
export default function WalletGuard() {
  useEffect(() => {
    const originalError = console.error;
    console.error = (...args: any[]) => {
      const msg = args[0]?.toString?.() || "";
      // Suppress Phantom/wallet extension noise
      if (
        msg.includes("sender_getProviderState") ||
        msg.includes("getProviderState") ||
        msg.includes("solana") && msg.includes("provider")
      ) {
        return;
      }
      originalError.apply(console, args);
    };

    // Also catch unhandled errors from wallet injection
    const handler = (event: ErrorEvent) => {
      if (
        event.message?.includes("sender_getProviderState") ||
        event.message?.includes("getProviderState")
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("error", handler);

    return () => {
      console.error = originalError;
      window.removeEventListener("error", handler);
    };
  }, []);

  return null;
}

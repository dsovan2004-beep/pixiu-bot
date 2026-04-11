/**
 * PixiuBot — Smart Money Configuration
 * Shared between webhook (entry) and paper-trader (exits).
 */

// Tier 1 Smart Money wallet ADDRESSES — entry requires 1 of these
export const TOP_ELITE_ADDRESSES = new Set([
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", // Cented
  "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6", // Cooker
  "J3Ez1WjZMpcnMua4xA9nirZwWTurAxY7wqhm4vPeJ8k5", // GMGN_SM_2 90% WR
  "4gyFNL92hgMZUb87Nv4BgfasYTZ247M2GSf8d2LS1Q99", // GMGN_FW_1 95% WR
  "5BGiLEfrrrAHPdjomZXhXk8mu36xgSdoV38BPxwkB3mz", // GMGN_FW_2 100% WR
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk", // Jijo 55% WR
  "G45wKGBuuHbfh2tkkNhWchfFquLM1DQ7xKs3VfygXQ5F", // GMGN_FW_3 93% WR
  "Hrk1f2nEMme9tDY5yro4itW9cN7P8K7PKyReGatf5zRb", // GMGN_FW_4 85% WR
]);

// Entry filters
export const MAX_GAP_MINUTES = 30;
export const MAX_ENTRY_MC = 100_000;
export const RECENTLY_TRADED_COOLDOWN_MS = 120 * 60_000; // 120 min
export const POSITION_SIZE_PCT = 0.01; // 1% of bankroll
export const PLACEHOLDER_PRICE = 0.000001;

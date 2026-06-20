export const EXECUTION_MODES = ["stopped", "dry_run", "measure_live", "live"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function normalizeExecutionMode(mode: string | null | undefined): ExecutionMode {
  if (mode === "dry_run" || mode === "measure_live" || mode === "live") return mode;
  return "stopped";
}

export function modeAllowsBuyBroadcast(mode: ExecutionMode): boolean {
  return mode === "measure_live" || mode === "live";
}

export function modeIsDryRun(mode: ExecutionMode): boolean {
  return mode === "dry_run";
}

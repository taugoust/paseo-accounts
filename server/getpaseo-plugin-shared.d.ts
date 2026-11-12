// Types for the quota helpers in taugoust/paseo's @getpaseo/plugin/shared. The npm package
// installed here doesn't have that export, so tsc needs them spelled out. Tests and the
// bundled build resolve the real module from the host (see vitest.config.ts).
declare module "@getpaseo/plugin/shared" {
  export type QuotaWindowSlot = "primary_window" | "secondary_window";
  export interface QuotaWindowValues {
    used_percent?: number | null;
    reset_at?: number | null;
    limit_window_seconds?: number | null;
  }
  export interface QuotaWindowNormalizationOptions {
    usedPercent?: "finite" | "nonnegative" | "percentage";
    resetAt?: "finite" | "nonnegative" | "epoch-seconds";
    duration?: "finite" | "positive-safe-integer";
  }
  export function normalizeQuotaWindow(
    value: unknown,
    options?: QuotaWindowNormalizationOptions,
  ): Partial<Record<keyof QuotaWindowValues, number>> | undefined;
  export function extractQuotaWindows<T, U>(
    rateLimit: Partial<Record<QuotaWindowSlot, T | null | undefined>> | null | undefined,
    mapWindow: (window: NonNullable<T>, slot: QuotaWindowSlot, primary: boolean) => U | undefined,
  ): U[];
}

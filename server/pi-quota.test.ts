import { afterEach, expect, it, vi } from "vitest";
import { fetchPiQuota } from "./pi-quota";

afterEach(() => vi.unstubAllGlobals());

it("keeps Accounts window validation, IDs, duration labels, and omissions", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      Response.json({
        plan_type: "Plus",
        rate_limit: {
          primary_window: { used_percent: 101, limit_window_seconds: 3600 },
          secondary_window: {
            used_percent: 45,
            reset_at: 8_640_000_000_001,
            limit_window_seconds: 604800,
          },
        },
        additional_rate_limits: [
          {
            metered_feature: "code-review-feature",
            limit_name: "Review",
            rate_limit: { primary_window: { used_percent: 90 } },
          },
        ],
        code_review_rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 3600 },
        },
        credits: { balance: 42 },
      }),
  );

  const result = await fetchPiQuota(
    {
      kind: "oauth",
      access: "opaque-token",
      expires: Date.now() + 60_000,
      accountId: "account",
    },
    undefined,
    false,
    false,
    "openai-codex",
  );

  expect(result.usage?.windows).toEqual([
    {
      id: "secondary_window",
      label: "7-day",
      usedPercent: 45,
      resetsAt: null,
    },
    {
      id: "additional:0:primary_window",
      label: "Review · Primary",
      usedPercent: 90,
      resetsAt: null,
    },
  ]);
  expect(result.usage).not.toHaveProperty("balances");
});

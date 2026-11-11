import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { Usage } from "../shared/model";
import { extractQuotaWindows, normalizeQuotaWindow, type QuotaWindowSlot } from "@getpaseo/plugin/shared";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;

export type PiQuotaCredential =
  | { kind: "oauth"; access: string; expires: number; accountId?: string }
  | { kind: "api-key" };

export type QuotaAuthData = {
  codexDefaultCredential?: PiQuotaCredential;
};

export type QuotaResult = {
  usage: Usage | null;
  plan: string | null;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/([\p{Cc}\p{Cf}])/u.test(value)
    ? value
    : undefined;
}

function accountIdClaim(access: string): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const value =
      claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims?.chatgpt_account_id;
    return safeIdentity(value);
  } catch {
    return undefined;
  }
}

export function quotaCredential(
  value: unknown,
  allowDefaultAuthTypeOmission = false,
): PiQuotaCredential | undefined {
  const credential = record(value);
  if (!credential) return undefined;
  if (credential.type === "api_key") return { kind: "api-key" };
  if (
    (credential?.type !== "oauth" &&
      !(allowDefaultAuthTypeOmission && credential?.type === undefined)) ||
    typeof credential.access !== "string" ||
    credential.access.length === 0 ||
    credential.access.length > 65_536 ||
    typeof credential.expires !== "number" ||
    !Number.isFinite(credential.expires)
  )
    return undefined;
  const storedAccountId = safeIdentity(credential.accountId);
  const claimedAccountId = accountIdClaim(credential.access);
  if (
    storedAccountId &&
    claimedAccountId &&
    storedAccountId !== claimedAccountId
  )
    return undefined;
  const accountId = storedAccountId ?? claimedAccountId;
  return {
    kind: "oauth",
    access: credential.access,
    expires: credential.expires,
    ...(accountId ? { accountId } : {}),
  };
}

async function readAuthJson(
  directory: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    // Home Manager links host-local auth.json through the Nix store to the
    // private shared credential file. Resolve the link, then open the final
    // target without following further links and validate its ownership/mode.
    const path = await realpath(`${directory}/auth.json`);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (typeof process.getuid === "function" &&
          stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 1024 * 1024
      )
        return undefined;
      return record(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function readQuotaAuthData(
  directory: string,
): Promise<QuotaAuthData> {
  const auth = await readAuthJson(directory);
  return {
    codexDefaultCredential: quotaCredential(auth?.["openai-codex"], true),
  };
}

function usageError(message: string): Usage {
  return {
    fetchedAt: new Date().toISOString(),
    windows: [],
    error: message,
    cached: false,
    resets: null,
  };
}

function quotaText(value: unknown, fallback: string): string {
  return safeIdentity(value)?.trim() || fallback;
}

function usageWindow(
  value: unknown,
  id: string,
  label: string,
): Usage["windows"][number] | null {
  const normalized = normalizeQuotaWindow(value, {
    usedPercent: "percentage",
    resetAt: "epoch-seconds",
  });
  const usedPercent = normalized?.used_percent;
  const resetAt = normalized?.reset_at;
  if (usedPercent === undefined) return null;
  return {
    id,
    label,
    usedPercent,
    resetsAt:
      typeof resetAt === "number" &&
      Number.isFinite(resetAt) &&
      resetAt >= 0 &&
      resetAt <= 8_640_000_000_000
        ? new Date(resetAt * 1000).toISOString()
        : null,
  };
}

function windowLabel(value: unknown, fallback: string): string {
  const duration = normalizeQuotaWindow(value, {
    duration: "positive-safe-integer",
  })?.limit_window_seconds;
  if (duration === undefined) return fallback;
  if (duration === 604800) return "7-day";
  if (duration % 86400 === 0) return `${duration / 86400}-day`;
  if (duration % 3600 === 0) return `${duration / 3600}-hour`;
  return fallback;
}

async function chatgptJson(
  access: string,
  accountId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401 || response.status === 403
        ? "auth-rejected"
        : "quota-unavailable",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("quota-response-missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error("quota-response-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!result) throw new Error("quota-response-invalid");
  return result;
}

function mapQuota(body: Record<string, unknown>): QuotaResult {
  const rate = record(body.rate_limit);
  const windows: Usage["windows"] = [];
  windows.push(
    ...extractQuotaWindows(
      rate as Partial<Record<QuotaWindowSlot, unknown>> | undefined,
      (source, slot) =>
        usageWindow(
          source,
          slot,
          windowLabel(source, slot === "primary_window" ? "Primary" : "Secondary"),
        ) ?? undefined,
    ),
  );
  const additional = Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits.slice(0, 100)
    : [];
  for (const [index, item] of additional.entries()) {
    const row = record(item);
    const identity = quotaText(
      row?.limit_name ?? row?.metered_feature,
      `Additional ${index + 1}`,
    );
    const limits = record(row?.rate_limit);
    windows.push(
      ...extractQuotaWindows(
        limits as Partial<Record<QuotaWindowSlot, unknown>> | undefined,
        (source, slot) =>
          usageWindow(
            source,
            `additional:${index}:${slot}`,
            `${identity} · ${windowLabel(source, slot === "primary_window" ? "Primary" : "Secondary")}`,
          ) ?? undefined,
      ),
    );
  }
  if (!windows.length)
    return {
      usage: usageError(
        "The selected ChatGPT profile returned no quota windows.",
      ),
      plan: null,
    };
  return {
    usage: {
      fetchedAt: new Date().toISOString(),
      windows,
      error: null,
      cached: false,
      resets: null,
    },
    plan:
      typeof body.plan_type === "string"
        ? quotaText(body.plan_type, "ChatGPT")
        : null,
  };
}

/** Reads usage directly with the Codex credential's own ChatGPT account. */
export async function fetchPiQuota(
  credential: PiQuotaCredential | undefined,
): Promise<QuotaResult> {
  if (!credential) return { usage: null, plan: null };
  if (credential.kind === "api-key")
    return {
      usage: usageError(
        "OpenAI does not expose ChatGPT quota windows for API-key profiles.",
      ),
      plan: null,
    };
  if (credential.expires <= Date.now())
    return {
      usage: usageError(
        "ChatGPT login expired; sign in again in Pi to refresh quota.",
      ),
      plan: null,
    };
  const accountId = credential.accountId ?? accountIdClaim(credential.access);
  if (!accountId)
    return {
      usage: usageError(
        "ChatGPT account identity is unavailable for this profile.",
      ),
      plan: null,
    };
  try {
    return mapQuota(await chatgptJson(credential.access, accountId));
  } catch (error) {
    return {
      usage: usageError(
        error instanceof Error && error.message === "auth-rejected"
          ? "OpenAI rejected this saved login; sign in again in Pi."
          : "OpenAI quota is temporarily unavailable.",
      ),
      plan: null,
    };
  }
}

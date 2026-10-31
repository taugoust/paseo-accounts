import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const target = {
  agentId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  providerId: z.enum(["openai", "openai-codex"]).optional(),
};
const account = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(256),
    authKind: z.enum(["oauth", "api-key"]),
  })
  .strict();
export const piSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    serviceEpoch: z.string().min(1).max(256),
    selectionRevision: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(256),
    accounts: z.array(account).max(100),
    providerId: z.enum(["openai", "openai-codex"]).optional(),
    /** Atomic source-default guard supported by the installed Pi producer. */
    guardedDefaultSwitchVersion: z.literal(1).optional(),
    inheritance: z.enum(["inherited", "explicit"]).optional(),
    sessionRouting: z.object({
      version: z.literal(1),
      providerId: z.enum(["openai", "openai-codex"]),
      revision: z.number().int().nonnegative(),
    }).strict().optional(),
    supportedProviders: z.array(z.enum(["openai", "openai-codex"])).optional(),
    currentAccountId: z.string().min(1).max(256).nullable(),
    defaultSelected: z.boolean(),
    activationStatus: z.enum([
      "active",
      "inactive",
      "activation-pending",
      "activation-failed",
    ]),
    busy: z.boolean(),
    canSwitch: z.boolean(),
    pendingAccountNames: z.array(z.string().min(1).max(64)).max(20).optional(),
    usage: z
      .object({
        effectiveCredential: z.enum([
          "api-key-configured",
          "chatgpt-grant-configured",
          "chatgpt-grant-matched-refreshed",
          "unavailable",
          "unknown",
        ]),
        status: z.enum(["local-binding-confirmed", "unavailable", "unknown"]),
        remoteEntitlement: z.literal("not-queried"),
        accountKey: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        providerId: z.enum(["openai", "openai-codex"]).optional(),
        nativeRegistrationKey: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        nativeRegistrationVersion: z.literal(1).optional(),
        settingsUrl: z
          .enum([
            "https://platform.openai.com/settings/organization/usage",
            "https://chatgpt.com/settings/usage",
          ])
          .nullable(),
      })
      .strict(),
  })
  .strict();
const request = z
  .object({
    protocol: z.literal(1),
    requestId: z.string().uuid(),
    expectedSessionId: z.string().min(1).max(256),
    expectedServiceEpoch: z.string().min(1).max(256),
    expectedSelectionRevision: z.number().int().nonnegative(),
    expectedRoutingRevision: z.number().int().nonnegative().optional(),
    expectedDefaultSource: z.object({
      providerId: z.enum(["openai", "openai-codex"]),
      selectionRevision: z.number().int().nonnegative(),
    }).strict().optional(),
    accountId: z.string().min(1).max(256).nullable(),
    providerId: z.enum(["openai", "openai-codex"]).optional(),
  })
  .strict();
export const piSwitchResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      requestId: z.string().uuid(),
      snapshot: piSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      requestId: z.string().uuid(),
      reason: z.enum([
        "stale-session",
        "stale-service",
        "stale-selection",
        "busy",
        "unknown-account",
        "activation-failed",
        "request-id-conflict",
        "invalid-request",
      ]),
      snapshot: piSnapshotSchema,
    })
    .strict(),
]);
export const accountControlsStatusRpc = defineRpc({
  name: "paseo-accounts.pi.native.status",
  input: z.object(target).strict(),
  output: z
    .object({
      available: z.boolean(),
      sessionId: z.string().nullable(),
      runtimeEpoch: z.string().uuid().nullable(),
      snapshot: piSnapshotSchema.nullable(),
      reason: z.string().max(500).nullable(),
    })
    .strict(),
});
export const accountControlsSwitchRpc = defineRpc({
  name: "paseo-accounts.pi.native.switch",
  input: z
    .object({
      ...target,
      expectedSessionId: z.string().min(1).max(256),
      expectedRuntimeEpoch: z.string().uuid(),
      request,
    })
    .strict(),
  output: piSwitchResultSchema,
});
export const piAccountManageRpc = defineRpc({
  name: "paseo-accounts.pi.manage",
  input: z.object({
    operation: z.enum(["add", "cancel-login", "rename", "remove", "default"]),
    accountId: z.string().min(1).max(64).nullable().optional(),
    accountName: z.string().trim().max(64).optional(),
    label: z.string().trim().max(40).optional(),
    method: z.enum(["oauth", "api_key"]).optional(),
    providerId: z.enum(["openai", "openai-codex"]).optional(),
  }),
  output: z
    .object({ ok: z.literal(true), accountId: z.string().optional() })
    .strict(),
});
export type PiNativeSnapshot = z.infer<typeof piSnapshotSchema>;

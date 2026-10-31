import type { RpcInput } from "@getpaseo/plugin";
import type { accountControlsSwitchRpc, PiNativeSnapshot } from "../shared/pi-native";

type Input = RpcInput<typeof accountControlsSwitchRpc>;
/** Re-read both namespaces, then the CURRENT namespace last to protect account pins. */
export async function validateDefaultProviderSwitch(
  input: Input,
  read: (provider: "openai" | "openai-codex") => Promise<PiNativeSnapshot>,
) {
  const guard = input.request.expectedDefaultSource;
  if (!guard) return;
  const request = input.request;
  const provider = request.providerId;
  if (!provider || request.accountId !== null || request.expectedRoutingRevision === undefined)
    throw new Error("Default-only provider switch requires explicit provider and routing guards.");
  const check = (snapshot: PiNativeSnapshot, namespace: "openai" | "openai-codex", revision: number) => {
    if (snapshot.sessionId !== input.expectedSessionId ||
        snapshot.sessionId !== request.expectedSessionId ||
        snapshot.serviceEpoch !== request.expectedServiceEpoch ||
        snapshot.providerId !== namespace ||
        snapshot.selectionRevision !== revision ||
        snapshot.sessionRouting?.version !== 1 ||
        snapshot.guardedDefaultSwitchVersion !== 1 ||
        snapshot.sessionRouting.providerId !== guard.providerId ||
        snapshot.sessionRouting.revision !== request.expectedRoutingRevision ||
        !snapshot.supportedProviders?.includes(provider) ||
        !snapshot.canSwitch || snapshot.busy)
      throw new Error("Default-only Pi provider switch has stale identity, revisions or support.");
    if (namespace === guard.providerId && !snapshot.defaultSelected)
      throw new Error("Pi account is pinned; no provider switch was sent.");
  };
  check(await read(guard.providerId), guard.providerId, guard.selectionRevision);
  check(await read(provider), provider, request.expectedSelectionRevision);
  check(await read(guard.providerId), guard.providerId, guard.selectionRevision);
}

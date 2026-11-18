import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { subagentRoutingSetRpc, subagentRoutingStatusRpc, type SubagentRoutingStatus } from "../shared/pi-native";
import type { StateView } from "../shared/model";
import type { AccountsStore } from "./store";
import { Card, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];
export function SubagentRouting({ theme, session, store }: { theme: Theme; session: StateView["subagentSessions"][number]; store: AccountsStore }) {
  const text = useText(theme), colors = theme.colors;
  const [status, setStatus] = useState<SubagentRoutingStatus | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = async (request = generation.current, preserveError = false) => {
    if (!session.workspaceId) return;
    try {
      const next = await store.rpc(subagentRoutingStatusRpc, { agentId: session.agentId, workspaceId: session.workspaceId });
      if (request !== generation.current) return;
      setStatus(next); if (!preserveError) setError(next.reason);
    } catch { if (request === generation.current) setError("Subagent settings unavailable. Refresh to retry."); }
  };
  useEffect(() => {
    const request = ++generation.current; setStatus(null); setError(null); setBusy(false);
    void refresh(request);
    return () => { generation.current++; };
  }, [session.agentId, session.workspaceId]);
  const select = async (selection: { providerId: string; accountId: string | null } | null) => {
    if (!status?.available || !status.runtimeEpoch || !session.workspaceId || !status.snapshot || busy) return;
    const request = generation.current;
    setBusy(true); setError(null);
    try {
      await store.rpc(subagentRoutingSetRpc, {
        agentId: session.agentId, workspaceId: session.workspaceId, expectedRuntimeEpoch: status.runtimeEpoch,
        request: { expectedSessionId: status.snapshot.sessionId, expectedServiceEpoch: status.snapshot.serviceEpoch, expectedRevision: status.snapshot.revision, selection },
      });
      await refresh(request);
    } catch {
      if (request === generation.current) {
        setError("Session changed. Refresh to retry.");
        await refresh(request, true);
      }
    } finally { if (request === generation.current) setBusy(false); }
  };
  const active = status?.snapshot?.selection;
  const choices = (status?.providers ?? []).flatMap((provider) => [
    { providerId: provider, accountId: null, label: "default login" },
    ...(provider === "openai-codex" ? (status?.codexAccounts ?? []).map((account) => ({ providerId: provider, accountId: account.id, label: account.label })) : []),
  ]);
  if (!status?.available) return null;
  const option = (label: string, selected: boolean, onPress: () => void, key: string) => (
    <Pressable key={key} disabled={busy} accessibilityRole="button" accessibilityState={{ selected, disabled: busy }} onPress={onPress} style={{ paddingVertical: 7, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, opacity: busy ? 0.55 : 1 }}>
      <Text style={[text.small, { color: selected ? colors.foreground : colors.foregroundMuted }]}>{selected ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
  return <Card theme={theme}>
    <View style={{ gap: 8 }}>
      <Text style={text.heading}>Subagents · {session.title ?? session.agentId}</Text>
        <Text style={text.small}>{active ? `Using ${active.providerId} · ${status.codexAccounts.find(account => account.id === active.accountId)?.label ?? active.accountId ?? "default login"}` : "Following this session"}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {option("Follow session", !active, () => void select(null), "follow")}
          {choices.map((choice) => {
            const label = `${choice.providerId} · ${choice.label}`;
            return option(label, active?.providerId === choice.providerId && active?.accountId === choice.accountId, () => void select({ providerId: choice.providerId, accountId: choice.accountId }), `${choice.providerId}:${choice.accountId ?? "default"}`);
          })}
          {active?.accountId && active.providerId === "openai-codex" && !status.codexAccounts.some(account => account.id === active.accountId)
            ? option(`${active.providerId} · ${active.accountId} (saved)`, true, () => undefined, "saved") : null}
        </View>
        {error ? <Text accessibilityRole="alert" style={text.danger}>{error}</Text> : null}
    </View>
  </Card>;
}

import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { piApplyProviderRpc } from "../shared/pi-native";
import { Button, useText } from "./ui";
import { hostLease, hostLeaseCurrent, hostsRevision, subscribeHosts, usableHost, withHost } from "./host-registry";

type Provider = "openai" | "openai-codex";
type Host = ReturnType<typeof useHosts>[number];
type Results = { provider: Provider; selectedCount: number; rows: string[] };
export function MultiHostActions({ theme, sourceHostId }: Pick<PluginSurfaceProps, "theme"> & { sourceHostId: string }) {
  const hosts = useHosts();
  useSyncExternalStore(subscribeHosts, hostsRevision, hostsRevision);
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [provider, setProvider] = useState<Provider>("openai");
  const [providerOpen, setProviderOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const mounted = useRef(false);
  const sourceRef = useRef(sourceHostId);
  const sourceLease = hostLease(sourceHostId);
  const sourceLeaseRef = useRef(sourceLease);
  const operationRevision = useRef(0);
  const operationInFlight = useRef(false);
  sourceRef.current = sourceHostId;
  sourceLeaseRef.current = sourceLease;
  const connected = hosts.filter((host) => host.status === "online" && usableHost(host.serverId));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operationRevision.current++; };
  }, []);
  useEffect(() => {
    operationRevision.current++;
    setOpen(false); setBusy(operationInFlight.current); setResults(null); setProviderOpen(false); setSelected([]);
  }, [sourceHostId, sourceLease]);
  useEffect(() => {
    const valid = new Set(connected.map((host) => host.serverId));
    setSelected((ids) => ids.filter((id) => valid.has(id)));
  }, [connected.map((host) => host.serverId).join("\n")]);
  const close = () => { if (!busy) { setOpen(false); setResults(null); } };
  const apply = async () => {
    const targets = selected.filter((id) => connected.some((host) => host.serverId === id));
    if (!targets.length || operationInFlight.current) return;
    const chosenProvider = provider;
    const chosenSource = sourceHostId;
    const chosenLease = sourceLeaseRef.current;
    const operation = operationRevision.current;
    const isCurrentOperation = () => mounted.current && sourceRef.current === chosenSource && operationRevision.current === operation && hostLeaseCurrent(chosenSource, chosenLease);
    const labels = new Map(hosts.map((host) => [host.serverId, host.label]));
    operationInFlight.current = true;
    setBusy(true); setProviderOpen(false); setResults(null);
    const rows = await Promise.all(targets.map(async (id) => {
      const label = labels.get(id) ?? id;
      let dispatchAttempted = false;
      try {
        const report = await withHost(id, async (store, current) => {
          if (!isCurrentOperation()) throw new Error("Accounts view changed.");
          await store.refresh({ fresh: true }); current();
          if (store.current.error || !store.current.state) throw new Error("Accounts unavailable");
          if (!isCurrentOperation()) throw new Error("Accounts view changed.");
          current();
          // Once RPC dispatch starts, a transport/lifetime failure cannot prove
          // whether the remote host committed. Never retry automatically.
          dispatchAttempted = true;
          const result = await store.rpc(piApplyProviderRpc, { providerId: chosenProvider, apply: true });
          current();
          if (!isCurrentOperation()) throw new Error("Accounts view changed.");
          return result;
        });
        if (!report.discoveryComplete) return `${label}: Discovery incomplete; no changes made.`;
        const details = [
          `${report.applied.length} changed`,
          ...(report.alreadySelectedCount ? [`${report.alreadySelectedCount} already using ${chosenProvider === "openai" ? "OpenAI" : "Codex"}`] : []),
          ...(report.pinnedCount ? [`${report.pinnedCount} pinned, unchanged`] : []),
          ...((report.skipped?.length ?? 0) ? [`${report.skipped!.length} skipped (busy, stale, or unavailable)`] : []),
          ...(report.failed.length ? [`${report.failed.length} failed or unconfirmed`] : []),
        ];
        return `${label}: ${details.join(" · ")}`;
      } catch {
        return dispatchAttempted
          ? `${label}: Outcome unavailable; refresh before retrying.`
          : `${label}: Unavailable; no change was sent.`;
      }
    }));
    if (isCurrentOperation()) setResults({ provider: chosenProvider, selectedCount: targets.length, rows });
    operationInFlight.current = false;
    if (mounted.current) setBusy(false);
  };
  if (hosts.length < 2) return null;
  return <>
    <Button theme={theme} size="small" label="Change provider across hosts…" disabled={busy} onPress={() => {
      setSelected(connected.map((host) => host.serverId)); setResults(null); setOpen(true);
    }} />
    <Modal title={results ? "Provider change complete" : "Change provider across hosts"} open={open} onOpenChange={(value) => { if (!value) close(); }}>
      {results ? <Modal.Content>
        <View style={{ gap: 10 }}>
          <Text style={text.small}>{results.provider === "openai" ? "OpenAI" : "Codex"} · {results.selectedCount} selected hosts</Text>
          {results.rows.map((result) => <Text key={result} style={text.small}>{result}</Text>)}
          <Text style={text.small}>Each host used its own default account. Skipped sessions were not queued.</Text>
        </View>
        <View style={{ alignItems: "flex-end", marginTop: 16 }}><Button theme={theme} label="Done" onPress={close} /></View>
      </Modal.Content> : <Modal.Content>
        <View style={{ gap: 12 }}>
          <Text style={text.small}>Choose hosts and a provider for this change.</Text>
          <Text style={text.strong}>Hosts</Text>
          {hosts.map((host: Host) => {
            const online = host.status === "online" && usableHost(host.serverId);
            const status = host.status !== "online" ? "Offline" : online ? "Connected" : "Accounts unavailable";
            const checked = selected.includes(host.serverId);
            return <HostOption key={host.serverId} theme={theme} host={host} online={online} status={status} checked={checked} disabled={!online || busy}
              onPress={() => setSelected((ids) => checked ? ids.filter((id) => id !== host.serverId) : [...ids, host.serverId])} />;
          })}
          <Text style={text.strong}>Provider</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Provider: ${provider === "openai" ? "OpenAI" : "Codex"}`} accessibilityHint="Choose a provider" disabled={busy} onPress={() => setProviderOpen((value) => !value)}
            style={{ minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, backgroundColor: theme.colors.surface0, opacity: busy ? 0.5 : 1 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{provider === "openai" ? "OpenAI" : "Codex"}</Text>
            <Icon name={providerOpen ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
          {providerOpen ? <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, overflow: "hidden" }}>
            {(["openai", "openai-codex"] as const).map((id) => <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: provider === id, disabled: busy }} disabled={busy} onPress={() => { setProvider(id); setProviderOpen(false); }}
              style={{ minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, backgroundColor: provider === id ? theme.colors.surface2 : theme.colors.surface0, opacity: busy ? 0.5 : 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{id === "openai" ? "OpenAI" : "Codex"}</Text>
              {provider === id ? <Icon name="Check" size={14} color={theme.colors.foregroundMuted} /> : null}
            </Pressable>)}
          </View> : null}
          <Text style={text.small}>Uses each host’s default account. Pinned and busy sessions are skipped.</Text>
          <Text style={text.small}>Targets chats following the provider default. Offline hosts are skipped.</Text>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button theme={theme} label="Cancel" disabled={busy} onPress={close} />
          <Button theme={theme} tone="primary" busy={busy} disabled={busy || selected.length === 0} label={`Apply to ${selected.length} hosts`} onPress={() => void apply()} />
        </View>
      </Modal.Content>}
    </Modal>
  </>;
}
function HostOption({ theme, host, online, status, checked, disabled, onPress }: {
  theme: PluginSurfaceProps["theme"]; host: Host; online: boolean; status: string; checked: boolean; disabled: boolean; onPress(): void;
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 38, flexDirection: "row", alignItems: "center", gap: 9, opacity: online ? 1 : 0.55 }}>
    <View style={{ width: 16, height: 16, borderRadius: 3, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: checked ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
      {checked ? <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>✓</Text> : null}
    </View>
    <Text style={{ color: theme.colors.foreground, flex: 1 }}>{host.label}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{status}</Text>
  </Pressable>;
}

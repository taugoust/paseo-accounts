import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { folderName, roomLeft, roomTone, shortLabel } from "../shared/format";
import {
	FAMILY_HEADING,
	type AccountView,
	type AgentRoute,
	type Family,
	type StateView,
} from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { bulkChangeAccounts, bulkChangeProvider, bulkGroup, compatibleAccounts, eligible } from "./bulk-accounts";
import { SectionLabel } from "./account-row";
import { describeReopen } from "./reopen-text";
import { describe, type AccountsStore } from "./store";
import { Button, Dot, toneColor, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** Every live agent with the account it runs on, and a quick way to move it. */
export function AgentsTab({
	theme,
	state,
	families,
	store,
	sourceId = "local",
	available = true,
	onOpenAgent,
}: {
	theme: Theme;
	state: StateView;
	families: readonly Family[];
	store: AccountsStore;
	sourceId?: string;
	available?: boolean;
	onOpenAgent?: (agentId: string) => void;
}) {
	const text = useText(theme);
	const colors = theme.colors;
	const [moving, setMoving] = useState<AgentRoute | null>(null);
	const [selecting, setSelecting] = useState(false);
	const [selected, setSelected] = useState<AgentRoute[]>([]);
	const [bulkOpen, setBulkOpen] = useState(false);
	const [providerOpen, setProviderOpen] = useState(false);
	const [bulkBusy, setBulkBusy] = useState(false);
	const [report, setReport] = useState<string | null>(null);
	const source = useRef({ store, sourceId, available });
	if (source.current.store !== store || source.current.sourceId !== sourceId || source.current.available !== available) {
		source.current = { store, sourceId, available };
	}
	useEffect(() => {
		setSelecting(false); setSelected([]); setMoving(null); setBulkOpen(false); setProviderOpen(false); setReport(null); setBulkBusy(false);
	}, [store, sourceId, available]);
	const groups = new Set(selected.map((agent) => bulkGroup(agent, state)));
	const compatible = selected.length > 0 && groups.size === 1 && !groups.has(null);
	const canChangeProvider = selected.length > 0 && selected.every((agent) => agent.family === "pi" && bulkGroup(agent, state) !== null);
	const anchor = selected[0];
	const changeSelected = async (accountId: string | null) => {
		if (accountId === null) return;
		const lifetime = source.current;
		setBulkBusy(true);
		try {
			const result = await bulkChangeAccounts(store, selected, accountId, () => source.current === lifetime && lifetime.available);
			if (source.current !== lifetime) return;
			setReport(`${result.changed} changed · ${result.skipped} skipped · ${result.failed} failed`);
			setBulkOpen(false); setSelected([]); setSelecting(false);
		} finally { if (source.current === lifetime) setBulkBusy(false); }
	};
	const changeSelectedProvider = async (providerId: "openai" | "openai-codex") => {
		const lifetime = source.current;
		setBulkBusy(true);
		try {
			const result = await bulkChangeProvider(store, selected, providerId, () => source.current === lifetime && lifetime.available);
			if (source.current !== lifetime) return;
			setReport(`${result.changed} changed · ${result.skipped} skipped · ${result.failed} failed`);
			setProviderOpen(false); setSelected([]); setSelecting(false);
		} finally { if (source.current === lifetime) setBulkBusy(false); }
	};
	const live = state.agents.filter((agent) => agent.status !== "closed");
	if (live.length === 0) {
		return (
			<Text style={text.muted}>
				No agents are running on these accounts right now.
			</Text>
		);
	}
	return (
		<View style={{ gap: 20 }}>
			<View style={{ gap: 8 }}>
				<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
					<Button theme={theme} size="small" label={selecting ? "Cancel selection" : "Select"} disabled={bulkBusy || !available} onPress={() => { setSelecting(!selecting); setSelected([]); setReport(null); }} />
					{selecting ? <>
						<Button theme={theme} size="small" label="Select all eligible" disabled={bulkBusy || !available} onPress={() => setSelected(live.filter((agent) => families.includes(agent.family) && eligible(agent, state)))} />
						<Button theme={theme} size="small" label={`Change account…${selected.length ? ` (${selected.length})` : ""}`} disabled={bulkBusy || !available || !compatible} onPress={() => setBulkOpen(true)} />
						<Button theme={theme} size="small" label={`Change provider…${selected.length ? ` (${selected.length})` : ""}`} disabled={bulkBusy || !available || !canChangeProvider} onPress={() => setProviderOpen(true)} />
					</> : null}
				</View>
				{selecting ? <Text style={text.small}>Bulk changes support idle Pi agents. Other agents can still be changed individually.</Text> : null}
				{selecting && selected.length > 0 && !compatible ? <Text style={text.small}>Change account needs one provider. Change provider supports mixed Pi providers.</Text> : null}
				{report ? <Text style={text.small}>{report}</Text> : null}
			</View>
			{families.map((family) => {
				const agents = live.filter((agent) => agent.family === family);
				if (agents.length === 0) return null;
				return (
					<View key={family} style={{ gap: 8 }}>
						<SectionLabel
							theme={theme}
							label={`${FAMILY_HEADING[family]} · ${agents.length}`}
						/>
						<View
							style={{
								borderRadius: 8,
                overflow: "hidden",
								borderWidth: 1,
								borderColor: colors.border,
								backgroundColor: colors.surface1,
							}}
						>
							{agents.map((agent, index) => (
								<AgentRow
									key={agent.agentId}
									theme={theme}
									agent={agent}
									account={state.accounts.find(
										(account) => account.id === agent.accountId,
									)}
									pending={state.accounts.find(
										(account) => account.id === agent.pendingAccountId,
									)}
									divided={index > 0}
									onOpen={
										onOpenAgent ? () => onOpenAgent(agent.agentId) : undefined
									}
									selecting={selecting}
									selected={selected.some((entry) => entry.agentId === agent.agentId)}
									selectionDisabled={bulkBusy || !available || !eligible(agent, state)}
									onSelect={() => setSelected((entries) => entries.some((entry) => entry.agentId === agent.agentId) ? entries.filter((entry) => entry.agentId !== agent.agentId) : [...entries, agent])}
									onMove={() => setMoving(agent)}
								/>
							))}
						</View>
					</View>
				);
			})}
			{providerOpen ? <Modal title={`Change provider for ${selected.length} agent${selected.length === 1 ? "" : "s"}`} open
				onOpenChange={(open) => { if (!open && !bulkBusy) setProviderOpen(false); }}>
				<Modal.Content>
					<View style={{ gap: 12 }}>
						<Text style={text.small}>Use the chosen provider’s default account for the selected agents, replacing their provider and account pins. Pi keeps the model ID/role; the destination must support it. Children following these sessions inherit the change.</Text>
						<Button theme={theme} label="OpenAI" disabled={bulkBusy} onPress={() => void changeSelectedProvider("openai")} />
						<Button theme={theme} label="Codex" disabled={bulkBusy} onPress={() => void changeSelectedProvider("openai-codex")} />
					</View>
				</Modal.Content>
			</Modal> : null}
			{bulkOpen && anchor ? <MoveModal theme={theme} agent={anchor} state={state} store={store}
				title={`Change account for ${selected.length} agent${selected.length === 1 ? "" : "s"}`} accountsOverride={compatibleAccounts(anchor, state)}
				onChoose={changeSelected} bulk onClose={() => { if (!bulkBusy) setBulkOpen(false); }} /> : null}
			{moving ? (
				<MoveModal
					theme={theme}
					agent={moving}
					state={state}
					store={store}
					onClose={() => setMoving(null)}
				/>
			) : null}
		</View>
	);
}

function AgentRow({
	theme,
	agent,
	account,
	pending,
	divided,
	onOpen,
	onMove,
	selecting = false, selected = false, selectionDisabled = false, onSelect,
}: {
	theme: Theme;
	agent: AgentRoute;
	account: AccountView | undefined;
	pending: AccountView | undefined;
	divided: boolean;
	onOpen?: () => void;
	onMove(): void;
	selecting?: boolean; selected?: boolean; selectionDisabled?: boolean; onSelect?(): void;
}) {
	const text = useText(theme);
	const colors = theme.colors;
	const running = agent.status === "running";
	return (
		<View
			style={{
				flexDirection: "row",
				alignItems: "center",
				gap: 10,
				paddingHorizontal: 12,
				paddingVertical: 10,
				borderTopWidth: divided ? 1 : 0,
				borderTopColor: colors.border,
			}}
		>
			{selecting ? <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select ${agent.title ?? "agent"}`}
				accessibilityState={{ checked: selected, disabled: selectionDisabled }} disabled={selectionDisabled} onPress={onSelect}
				style={{ minWidth: 32, minHeight: 40, alignItems: "center", justifyContent: "center", opacity: selectionDisabled ? 0.35 : 1 }}>
				<Icon name={selected ? "SquareCheck" : "Square"} size={20} color={selected ? colors.accent : colors.foregroundMuted} />
			</Pressable> : null}
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Open ${agent.title ?? "agent"}`}
				disabled={!onOpen}
				onPress={onOpen}
				style={({ pressed }) => ({
					flex: 1,
					minWidth: 0,
					flexDirection: "row",
					alignItems: "center",
					gap: 10,
					opacity: pressed ? 0.6 : 1,
				})}
			>
				<Dot
					color={
						running
							? colors.accent
							: agent.status === "error"
								? colors.statusDanger
								: colors.border
					}
				/>
				<View style={{ flex: 1, minWidth: 0, gap: 1 }}>
					<Text
						style={text.strong}
						numberOfLines={1}
					>
						{agent.title ?? "Untitled agent"}
					</Text>
					<Text style={[text.small, { fontSize: 11 }]} numberOfLines={1}>
						{[
							agent.cwd ? folderName(agent.cwd) : null,
							running
								? "working"
								: agent.status === "error"
									? "stopped with an error"
									: "idle",
							pending ? `still on ${pending.label} until it restarts` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</Text>
				</View>
			</Pressable>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Account: ${account?.label ?? "none"}. Change`}
				disabled={selecting}
				onPress={onMove}
				style={({ pressed }) => ({
					flexDirection: "row",
					alignItems: "center",
					gap: 6,
					maxWidth: 160,
					paddingHorizontal: 10,
					minHeight: 30,
					borderRadius: 8,
					borderWidth: 1,
					borderColor: colors.border,
					backgroundColor: colors.surface2,
					opacity: pressed ? 0.7 : 1,
				})}
			>
				{account ? (
					<Dot color={toneColor(theme, roomTone(account))} size={6} />
				) : null}
				<Text
					style={{
						flexShrink: 1,
						color: colors.foreground,
						fontSize: 12,
						fontWeight: "600",
					}}
					numberOfLines={1}
				>
					{account ? shortLabel(account, 14) : "Choose"}
				</Text>
				{agent.pinned ? (
					<Icon name="Pin" size={11} color={colors.foregroundMuted} />
				) : null}
				<Icon name="ChevronsUpDown" size={12} color={colors.foregroundMuted} />
			</Pressable>
		</View>
	);
}

function MoveModal({
	theme,
	agent,
	state,
	store,
	onClose,
	title, accountsOverride, onChoose, bulk = false,
}: {
	theme: Theme;
	agent: AgentRoute;
	state: StateView;
	store: AccountsStore;
	onClose(): void;
	title?: string;
	accountsOverride?: AccountView[];
	onChoose?: (accountId: string | null) => Promise<void>;
	bulk?: boolean;
}) {
	const text = useText(theme);
	const toast = useToast();
	const colors = theme.colors;
	const [saving, setSaving] = useState<string | null>(null);
	const accounts = accountsOverride ?? state.accounts.filter(
		(account) => account.family === agent.family,
	);
	const choose = async (accountId: string | null) => {
		setSaving(accountId ?? "default");
		try {
			if (onChoose) { await onChoose(accountId); return; }
			const result = await store.rpc(setAgentAccount, {
				agentId: agent.agentId,
				accountId,
			});
			const target = accountId
				? accounts.find((account) => account.id === accountId)?.label
				: "the default";
			toast.show(describeReopen(`Moved to ${target}`, result), {
				variant: "success",
				durationMs: 5_000,
			});
			onClose();
		} catch (error) {
			toast.error(describe(error));
		} finally {
			setSaving(null);
		}
	};
	const option = (
		key: string,
		label: string,
		detail: string,
		selected: boolean,
		onPress: () => void,
		color?: string,
	) => (
		<Pressable
			key={key}
			accessibilityRole="radio"
			accessibilityState={{ selected }}
			disabled={
				saving !== null || (agent.family === "pi" && agent.canSwitch === false)
			}
			onPress={onPress}
			style={({ pressed }) => ({
				flexDirection: "row",
				alignItems: "center",
				gap: 10,
				paddingHorizontal: 12,
				minHeight: 44,
				borderRadius: 8,
				borderWidth: 1,
				borderColor: selected ? colors.accent : colors.border,
				backgroundColor: colors.surface2,
				opacity: pressed || (saving !== null && saving !== key) ? 0.6 : 1,
			})}
		>
			{color ? (
				<Dot color={color} />
			) : (
				<Icon name="Star" size={12} color={colors.foregroundMuted} />
			)}
			<Text style={[text.strong, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
				{label}
			</Text>
			<Text style={[text.small, { fontVariant: ["tabular-nums"] }]}>
				{saving === key ? "Moving…" : detail}
			</Text>
		</Pressable>
	);
	return (
		<Modal
			title={title ?? `Move “${agent.title ?? "agent"}”`}
			open
			onOpenChange={(open) => (open ? undefined : onClose())}
		>
			<Modal.Content>
				{!bulk && !agent.movable ? (
					<Text style={text.muted}>
						This ChatGPT conversation can't change accounts in place; picking
						one continues it in a new agent.
					</Text>
				) : null}
				<View style={{ gap: 6 }}>
					{!bulk && agent.family !== "pi"
						? option(
								"default",
								"Follow the default",
								"",
								!bulk && !agent.pinned,
								() => void choose(null),
							)
						: null}
					{accounts.map((account) => {
						const left = roomLeft(account);
						const detail =
							account.status === "ready"
								? left === null
									? ""
									: `${Math.round(100 - left)}% used`
								: account.status.replace("_", " ");
						return option(
							account.id,
							account.label,
							detail,
							!bulk && (agent.family === "pi" || agent.pinned) &&
								agent.accountId === account.id,
							() => void choose(account.id),
							toneColor(theme, roomTone(account)),
						);
					})}
				</View>
			</Modal.Content>
		</Modal>
	);
}

// Real host-compiled UI and React hooks; all host data/actions are synthetic.
import * as React from 'react';
import * as ReactJSX from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as Native from 'react-native';
import * as zod from 'zod';
import * as sdkRoot from '../../preview/mocks/plugin-root';
import * as sdkClient from '../../preview/mocks/plugin-client';
import * as sdkUI from '../../preview/mocks/plugin-ui';
import * as sdkRN from '../../preview/mocks/plugin-rn';
import { PreviewColors } from '../../preview/mocks/colors';
import { sample } from '../../preview/sample';
import factory from './artifacts/bulk/factory.js';

let hosts = [{ serverId: 'bulk-fixture', label: 'Synthetic workstation', status: 'online' }];
const modules = { react: React, 'react/jsx-runtime': ReactJSX, 'react-native': Native, zod,
  '@getpaseo/plugin': sdkRoot, '@getpaseo/plugin/client': { ...sdkClient, useHosts: () => hosts },
  '@getpaseo/plugin/client/ui': sdkUI, '@getpaseo/plugin/client/react-native': sdkRN };
const compiled = factory((name: string) => {
  if (!(name in modules)) throw Error(`Unapproved fixture module: ${name}`);
  return modules[name];
});
const baseAccount = { ...sample.accounts[0], usage: null, trend: [], forecast: null, folders: [], email: null, plan: null, agentCount: 0 };
const account = (id: string, family: string, label: string, status = 'ready') => ({ ...baseAccount, id, family, label, kind: 'managed', status, isDefault: false });
const baseAgent = { ...sample.agents[1], family: 'pi', provider: 'pi', status: 'idle', canSwitch: true, pinned: false, pendingAccountId: null, movable: true };
const agent = (agentId: string, title: string, extra = {}) => ({ ...baseAgent, agentId, title, accountId: 'pi-native:default', ...extra });
const state = compiled.parseState({ ...sample,
  accounts: [account('claude-work', 'claude', 'Work'), account('claude-personal', 'claude', 'Personal'), account('claude-limited', 'claude', 'Unavailable team', 'limited'),
    account('pi-native:default', 'pi', 'OpenAI Default'), account('pi-native:profile:Work', 'pi', 'OpenAI Work'), account('pi-native:profile:personal', 'pi', 'OpenAI Personal'), account('pi-native:profile:limited', 'pi', 'OpenAI Unavailable', 'limited'), account('pi-native:codex:default', 'pi', 'ChatGPT Personal')],
  agents: [
    agent('pinned', 'Review API integration', { pinned: true, accountId: 'pi-native:profile:Work' }),
    agent('pi-codex', 'Pi ChatGPT review', { family: 'pi', provider: 'pi', accountId: 'pi-native:codex:default' }),
    agent('becomes-busy', 'Write onboarding guide'),
    agent('fails', 'Refactor settings page'),
    agent('busy', 'Working checkout fix', { status: 'running' }),
    agent('pending', 'Pending account restart', { pendingAccountId: 'pi-native:profile:personal' }),
    agent('blocked', 'Unavailable live switcher', { canSwitch: false }),
    agent('unknown', 'Missing source account', { accountId: 'missing' }),
    agent('fork-only', 'Requires new conversation', { movable: false }),
    agent('closed', 'Closed conversation', { status: 'closed' }),
    agent('claude-idle', 'Claude individual change', { family: 'claude', provider: 'claude', accountId: 'claude-work' }),
  ], installed: ['claude', 'pi'], providers: { claude: 'claude', pi: 'pi' }, nextUp: { claude: 'claude-work', pi: 'pi-native:default' },
  activity: [], warnings: [], hostTimeZone: { name: 'UTC', offsetMinutes: 0 },
});
const calls: unknown[] = [], refreshes: unknown[] = [];
let release: (() => void) | undefined;
let pauseNext = false;
function makeStore(id: string) {
  let snapshot = { state: structuredClone(state), error: null };
  const listeners = new Set<() => void>();
  return {
    get current() { return snapshot; }, getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: async (options: { fresh?: boolean }) => {
      refreshes.push({ store: id, options });
      if (options?.fresh && calls.some((call: any) => call.store === id)) {
        snapshot = { ...snapshot, state: { ...snapshot.state, agents: snapshot.state.agents.map(row => row.agentId === 'becomes-busy' ? { ...row, status: 'running' } : row) } };
        listeners.forEach(fn => fn());
      }
    },
    watch: () => () => {}, start() {}, stop() {}, watchClosely: () => () => {},
    setError(error: string | null) { snapshot = { ...snapshot, error }; listeners.forEach(fn => fn()); },
    rpc: async (contract: { name: string }, input: { agentId: string; accountId?: string | null; onlyIfIdle?: boolean; providerId?: 'openai' | 'openai-codex'; expectedAccountId?: string }) => {
      calls.push({ store: id, rpc: contract.name, input });
      const providerChange = contract.name === 'paseo-accounts.agents.provider';
      if ((!providerChange && contract.name !== 'paseo-accounts.agents.account') || !state.agents.some(a => a.agentId === input.agentId)) throw Error('Fixture blocks non-local agent RPCs');
      const current = snapshot.state.agents.find(row => row.agentId === input.agentId)!;
      if (providerChange && (current.family !== 'pi' || input.expectedAccountId !== current.accountId)) throw Error('Synthetic fixture: stale provider source');
      if (pauseNext) { pauseNext = false; await new Promise<void>(resolve => { release = resolve; }); }
      const targetId = providerChange ? input.providerId === 'openai-codex' ? 'pi-native:codex:default' : 'pi-native:default' : input.accountId;
      const alreadySelected = providerChange && current.accountId === targetId && !current.pinned;
      const changed = input.agentId !== 'fails' && !alreadySelected;
      if (changed) {
        snapshot = { ...snapshot, state: { ...snapshot.state, agents: snapshot.state.agents.map(row => row.agentId === input.agentId ? { ...row, accountId: targetId, pinned: !providerChange } : row) } };
        listeners.forEach(fn => fn());
      }
      return { reopened: changed ? [input.agentId] : [], deferred: [], continuedIn: null,
        failed: input.agentId === 'fails' ? [{ agentId: input.agentId, error: 'Synthetic fixture: session became unavailable' }] : [] };
    },
  };
}
const stores = [makeStore('store-a'), makeStore('store-b')];
const colors = { surface0: '#0e0e10', surface1: '#17171a', surface2: '#202024', border: 'rgba(255,255,255,0.08)', foreground: '#ececef', foregroundMuted: '#8c8c94', accent: '#7c93ff', accentForeground: '#0e0e10', statusSuccess: '#51cf66', statusWarning: '#fcc419', statusDanger: '#ff6b6b' };
const disclosure = 'TEST FIXTURE · compiled Accounts UI · synthetic single host · no live changes';
function Fixture() {
  const [hostId, setHostId] = React.useState('bulk-fixture');
  const [storeIndex, setStoreIndex] = React.useState(0);
  const [available, setAvailable] = React.useState(true);
  const [sourceId, setSourceId] = React.useState('direct-source-a');
  const [direct, setDirect] = React.useState(false);
  hosts = [{ serverId: hostId, label: 'Synthetic workstation', status: available ? 'online' : 'offline' }];
  window.__bulkFixture = { disclosure, calls, refreshes, setHostId, setStoreIndex, setAvailable, setSourceId, setDirect,
    setError: (error: string | null) => stores[storeIndex].setError(error),
    pauseNext: () => { pauseNext = true; }, release: () => { release?.(); release = undefined; } };
  return <PreviewColors.Provider value={colors}>
    <div style={{ color: colors.foregroundMuted, font: '12px system-ui', padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>{disclosure}</div>
    <Native.View style={{ flex: 1 }}>{direct
      ? <compiled.AgentsTab theme={{ colors }} state={state} families={['claude', 'pi']} store={stores[storeIndex]} sourceId={sourceId} available={available} />
      : <compiled.AccountsSurface theme={{ colors }} layout={{ compact: innerWidth < 600, platform: 'web' }} host={{ id: hostId, label: 'Synthetic workstation' }} isFocused store={stores[storeIndex]} />}
    </Native.View>
  </PreviewColors.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

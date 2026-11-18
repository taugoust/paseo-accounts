import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { readFile, cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'PASEO_PLUGIN_COMPILER must identify the installed host compiler');
const require = createRequire(resolve(compilerPath));
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const jsx = (type, props) => ({ type, props: props ?? {} });
let slots = [], cursor = 0;
const hooks = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(initial) { const [value] = hooks.useState(() => ({ current: initial })); return value; },
  useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
};
const Modal = Object.assign('Modal', { Content: 'ModalContent' });
const load = name => {
  if (name === 'react') return hooks;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
  if (name === 'react-native') return Object.fromEntries(['View','Text','Pressable','ActivityIndicator','ScrollView'].map(n => [n,n]));
  if (name === '@getpaseo/plugin/client/react-native') return { Icon:'Icon', Modal, TextInput:'TextInput', useToast: () => ({ show() {} }), copyText: async () => {} };
  if (name === '@getpaseo/plugin/client/ui') return Object.fromEntries(['SettingsSection','SettingsGroup','SettingsCard','SettingsRow','SettingsAction','SettingsSwitch','SettingsSelect','SettingsInput','SidebarRow'].map(n => [n,n]));
  if (name === '@getpaseo/plugin') return { defineRpc: value => value, defineSettings: value => value };
  if (name === '@getpaseo/plugin/client') return { useHosts: () => [{serverId:'fixture',status:'online'}], useRpc: () => async () => { throw Error('No remote action is authorized in presentation tests'); } };
  return require(name);
};
// Real compiler boundaries are relative to index.client.tsx, not a nested module.
// Copy unmodified production modules and use a root-only export entry for each view.
const fixtureRoot = await mkdtemp(join(tmpdir(), 'accounts-native-presentation-'));
after(() => rm(fixtureRoot, { recursive:true, force:true }));
for (const directory of ['client','shared']) await cp(fileURLToPath(new URL(`../${directory}`, import.meta.url)), join(fixtureRoot,directory), {recursive:true});
async function compile(relative) {
  await writeFile(join(fixtureRoot,'index.client.tsx'), `export * from '${relative.replace('../','./')}';\n`);
  const { clientBundle } = await compilePlugin({ client: join(fixtureRoot,'index.client.tsx') });
  return (0, eval)(clientBundle)(load);
}
const ui = await compile('../client/ui.tsx');
const surface = await compile('../client/accounts-surface.tsx');
const activity = await compile('../client/activity-tab.tsx');
const agents = await compile('../client/agents-tab.tsx');
const projects = await compile('../client/projects-tab.tsx');
const addAccount = await compile('../client/add-account.tsx');
const subagents = await compile('../client/subagent-routing.tsx');
const sampleSource = stripTypeScriptTypes(await readFile(new URL('../preview/sample.ts', import.meta.url), 'utf8'), { mode:'transform' });
const { sample } = await import(`data:text/javascript;base64,${Buffer.from(sampleSource).toString('base64')}`);
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : typeof value.type === 'function' ? nodes(value.type(value.props)) : [value, ...nodes(value.props.children)];
const text = value => nodes(value).filter(n => n.type === 'Text').map(n => [n.props.children].flat(Infinity).filter(v => typeof v === 'string' || typeof v === 'number').join('')).join(' ');
const style = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
function render(Component, props, reset = true) { if (reset) slots = []; cursor = 0; return Component(props); }
const palettes = [
  { foreground:'#eeeeee', foregroundMuted:'#999999', surface0:'#151619', surface1:'#1d1e22', surface2:'#28292d', border:'#333438', statusDanger:'#ef8888', statusWarning:'#e7b35c', statusSuccess:'#68b981', accent:'#5caaf6', accentForeground:'#111111' },
  { foreground:'#202124', foregroundMuted:'#6b6e76', surface0:'#ffffff', surface1:'#f7f7f8', surface2:'#ededf0', border:'#dddddf', statusDanger:'#b73030', statusWarning:'#a16c18', statusSuccess:'#26783f', accent:'#268ae0', accentForeground:'#ffffff' },
];
const snapshot = { state:sample, error:null, offline:false, refreshing:false };
const store = { subscribe:() => () => {}, getSnapshot:() => snapshot, refresh:async () => {}, watch:() => () => {}, rpc:async () => { throw Error('Unexpected account action'); } };

for (const colors of palettes) {
  const theme = { colors };
  for (const compact of [false,true]) {
    test(`compiled Accounts uses native hierarchy and spacing (${colors.surface0}, compact=${compact})`, () => {
      const tree = render(surface.AccountsSurface, { theme, layout:{compact,platform:compact?'ios':'web'}, host:{id:'fixture',label:'Local host'}, isFocused:true, store });
      const all = nodes(tree);
      assert.match(text(tree), /Accounts/);
      assert.match(text(tree), /Add account/);
      const scroll = all.find(n => n.type === 'ScrollView');
      assert.equal(scroll.props.contentContainerStyle.padding, compact?12:24);
      const heading = all.find(n => n.type === 'Text' && n.props.accessibilityRole === 'header');
      assert.equal(style(heading.props.style).fontSize,18);
      assert.equal(style(heading.props.style).fontWeight,'600');
      assert.ok(all.some(n => n.props.accessibilityRole === 'tablist'));
      assert.ok(!all.some(n => n.type==='View' && style(n.props.style).borderRadius===10), 'no bespoke 10px card geometry');
    });
  }
  test(`compiled shared buttons, cards and tabs use host geometry (${colors.surface0})`, () => {
    let calls = 0;
    const props = { theme,label:'Refresh',onPress:() => calls++ };
    let button = render(ui.Button,props);
    let press = nodes(button).find(n => n.type === 'Pressable');
    assert.equal(style(press.props.style({pressed:false})).borderRadius,8);
    assert.equal(style(press.props.style({pressed:true})).opacity,0.85);
    press.props.onPress(); assert.equal(calls,1);
    const body = nodes(button).find(n => n.type==='Text');
    assert.equal(body.props.style.fontSize,14);
    assert.equal(body.props.style.lineHeight,20);
    const disabled = nodes(render(ui.Button,{...props,disabled:true})).find(n => n.type==='Pressable');
    assert.equal(disabled.props.disabled,true);
    assert.equal(style(disabled.props.style({pressed:false})).opacity,0.5);
    const card = render(ui.Card,{theme,children:'Content'});
    assert.equal(card.props.style.borderRadius,8);
    assert.equal(card.props.style.backgroundColor,colors.surface1);
    let chosen;
    const tabs = render(ui.Tabs,{theme,tabs:[{id:'a',label:'Accounts'},{id:'b',label:'Agents'}],value:'a',onChange:id=>{chosen=id;},fill:true});
    const tab = nodes(tabs).find(n=>n.props.accessibilityRole==='tab' && n.props.accessibilityState.selected);
    assert.equal(style(tab.props.style({pressed:false})).borderBottomColor,colors.accent);
    const second = nodes(tabs).filter(n=>n.props.accessibilityRole==='tab')[1];
    second.props.onPress(); assert.equal(chosen,'b');
  });
}

test('compiled Pi account setup adds Codex profiles only, no provider choice', async () => {
  const calls = [];
  const props = { theme:{colors:palettes[0]}, layout:{compact:true,platform:'ios'}, host:{id:'fixture',label:'Local host'}, multiHost:false, family:'pi', onClose() {}, store:{...store,rpc:async (rpc,input)=>{calls.push({rpc,input});return {accountId:'same-name'};}} };
  let tree = render(addAccount.AddAccountModal, props);
  const all = nodes(tree);
  assert.equal(all.some(n=>n.type==='SettingsSelect'),false);
  assert.match(text(tree),/Codex profile/);
  assert.doesNotMatch(text(tree),/API key/);
  all.find(n=>n.type==='TextInput').props.onChangeText('same-name');
  tree = render(addAccount.AddAccountModal, props, false);
  const signIn = nodes(tree).find(n=>n.type==='Pressable'&&n.props.accessibilityLabel==='ChatGPT sign-in');
  assert.equal(Boolean(signIn.props.disabled),false);
  signIn.props.onPress();
  await Promise.resolve();
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].input,{operation:'add',accountName:'same-name',method:'oauth'});
});

test('compiled Accounts remains compatible with state views without subagent sessions', () => {
  const legacy = structuredClone(sample); delete legacy.subagentSessions;
  const legacyStore = { ...store, getSnapshot:() => ({state:legacy,error:null}) };
  const tree = render(surface.AccountsSurface,{theme:{colors:palettes[0]},layout:{compact:true,platform:'ios'},host:{id:'fixture',label:'Local host'},isFocused:true,store:legacyStore});
  assert.ok(tree, 'older state views still render without routing metadata');
});

test('compiled Subagents hides when the routing service is missing', async () => {
  const mounted = await mountSubagents({ available:false, sessionId:null, runtimeEpoch:null, snapshot:null, providers:[], codexAccounts:[], reason:'unavailable' });
  assert.equal(mounted.tree, null);
  assert.equal(mounted.calls.some(call => call.rpc.name.includes('.switch')), false);
  mounted.restore();
});

test('compiled Subagents offers follow, provider defaults and named native account IDs', async () => {
  let finishSet, holdFirst = true;
  const mounted = await mountSubagents(routingStatus(), () => holdFirst ? (holdFirst = false, new Promise(resolve => { finishSet = resolve; })) : undefined);
  let tree = mounted.tree;
  const defaultChoice = nodes(tree).find(node => node.type === 'Pressable' && text(node).includes('openai') && !text(node).includes('openai-codex'));
  assert.ok(defaultChoice);
  defaultChoice.props.onPress();
  tree = mounted.draw();
  assert.ok(nodes(tree).filter(node => node.type==='Pressable').every(node => node.props.disabled), 'all choices disable while saving');
  finishSet(); await settle(); tree = mounted.draw();
  assert.deepEqual(mounted.calls.find(call => call.rpc.name.endsWith('.set')).input.request.selection, {providerId:'openai',accountId:null});
  pressWith(tree, 'Work label').props.onPress(); await settle(); tree = mounted.draw();
  assert.deepEqual(mounted.calls.filter(call => call.rpc.name.endsWith('.set'))[1].input.request.selection, {providerId:'openai-codex',accountId:'native-account-id'});
  followChoice(tree).props.onPress(); await settle();
  assert.equal(mounted.calls.filter(call => call.rpc.name.endsWith('.set'))[2].input.request.selection, null);
  assert.equal(mounted.calls.some(call => call.rpc.name.includes('.switch')), false, 'subagent settings never invoke parent account switching');
  mounted.restore();
});

test('compiled Subagents shows a saved named selection and can reset it', async () => {
  const status = routingStatus({ providerId:'openai-codex', accountId:'saved-native-id' });
  const mounted = await mountSubagents(status);
  assert.ok(text(mounted.tree).includes('saved-native-id'));
  followChoice(mounted.tree).props.onPress(); await settle();
  assert.equal(mounted.calls.find(call => call.rpc.name.endsWith('.set')).input.request.selection, null);
  mounted.restore();
});

test('compiled Subagents refreshes after stale set and retains a short error', async () => {
  const mounted = await mountSubagents(routingStatus(), async (_input, current) => { throw Error('stale-selection'); });
  pressWith(mounted.tree, 'Work label').props.onPress(); await settle();
  const tree = mounted.draw();
  const alert = nodes(tree).find(node => node.props.accessibilityRole === 'alert');
  const error = text(alert);
  assert.ok(error && error.length < 100);
  assert.equal(error.includes('stale-selection'), false, 'service rejection codes are not exposed as UI copy');
  assert.equal(mounted.calls.filter(call => call.rpc.name.endsWith('.status')).length, 2);
  assert.equal(mounted.calls.some(call => call.rpc.name.includes('.switch')), false);
  mounted.restore();
});

function routingStatus(selection = null) {
  return { available:true, sessionId:'session', runtimeEpoch:'11111111-1111-4111-8111-111111111111', snapshot:{protocol:1,sessionId:'session',serviceEpoch:'service',revision:2,selection}, providers:['openai','openai-codex'], codexAccounts:[{id:'native-account-id',label:'Work label'}], reason:null };
}
function followChoice(tree) {
  const choices = nodes(tree).filter(node => node.type === 'Pressable');
  assert.ok(choices.length);
  return choices[0];
}
function pressWith(tree, value) {
  const button = nodes(tree).find(node => node.type==='Pressable' && text(node).includes(value));
  assert.ok(button, `missing action containing ${value}`);
  return button;
}
async function settle() { for (let i=0;i<8;i++) await new Promise(resolve => setImmediate(resolve)); }
async function mountSubagents(initial, onSet = async () => {}) {
  const previousEffect = hooks.useEffect;
  let effects = [], dependencies = [];
  hooks.useEffect = (effect, deps) => {
    const index = cursor++;
    if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) { dependencies[index] = deps; effects.push(effect); }
  };
  slots = []; cursor = 0;
  const calls = [];
  let current = structuredClone(initial);
  const props = { theme:{colors:palettes[0]}, session:{agentId:'pi-agent',workspaceId:'workspace',title:'Test session',status:'idle'}, store:{rpc:async (rpc,input) => {
    calls.push({rpc,input});
    if (rpc.name.endsWith('.status')) return structuredClone(current);
    await onSet(input,current);
    current = {...current,snapshot:{...current.snapshot,revision:current.snapshot.revision+1,selection:input.request.selection}};
    return current.snapshot;
  }} };
  const draw = () => render(subagents.SubagentRouting,props,false);
  let tree = draw();
  const queued = effects; effects = []; queued.forEach(effect => effect()); await settle(); tree = draw();
  return { tree, draw, calls, restore:() => { hooks.useEffect = previousEffect; } };
}

test('compiled activity, agent and project views retain content and callbacks with native surfaces', () => {
  const theme = {colors:palettes[0]};
  for (const [Component, props] of [[activity.ActivityTab,{state:sample,onOpenAgent() {}}],[agents.AgentsTab,{state:sample,families:['claude'],store,onOpenAgent() {}}],[projects.ProjectsTab,{state:sample,store}]]) {
    const tree = render(Component,{theme,...props});
    const all = nodes(tree);
    assert.ok(all.length>0);
    assert.ok(!all.some(n=>n.type==='View' && style(n.props.style).borderRadius===12), 'grouped rows use native 8px surfaces');
  }
});

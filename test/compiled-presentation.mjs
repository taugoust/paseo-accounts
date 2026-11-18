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
const pills = await compile('../client/pills.ts');
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

test('compiled Pi pill offers only usable Claude and Codex subagent routes', async () => {
  const status = routingStatus();
  status.providers.push('amazon-bedrock', 'groq', 'openai', 'xiaomi');
  const mounted = await mountPills(status);
  try {
    const choices = mounted.items().filter(item => item.id.startsWith('subagent-'));
    // The session already runs on the default Claude login, so that login is listed once.
    assert.deepEqual(choices.map(item => item.id), ['subagent-follow','subagent-codex','subagent-codex-native-account-id','subagent-codex-second-native-id']);
    assert.equal(new Set(choices.map(item => item.title)).size, choices.length, 'every account name appears once');
    assert.equal(mounted.item('subagent-follow').icon, 'CircleCheck');
    const base = mounted.button.label;
    await mounted.item('subagent-codex-native-account-id').behavior.onPress();
    assert.deepEqual(mounted.sets()[0].input.request.selection, {providerId:'openai-codex',accountId:'native-account-id'});
    assert.equal(mounted.item('subagent-codex-native-account-id').icon, 'CircleCheck');
    assert.notEqual(mounted.button.label, base, 'non-default routing stays visible on the pill');
    assert.ok(mounted.button.title.includes('Work label'));
    await mounted.item('subagent-follow').behavior.onPress();
    assert.equal(mounted.sets()[1].input.request.selection, null);
    assert.equal(mounted.button.label, base);
    assert.ok(mounted.calls.every(call => call.rpc.name.includes('.subagent-routing.')), 'subagent choices never switch the parent account');
  } finally { mounted.stop(); }
});

test('compiled Pi pill omits unavailable families and keeps a saved choice visible with one account', async () => {
  const status = routingStatus({providerId:'openai-codex',accountId:'saved-native-id'});
  status.providers = ['openai-codex'];
  const mounted = await mountPills(status, {family:'pi'});
  try {
    assert.ok(mounted.button);
    assert.equal(mounted.items().some(item => item.id === 'subagent-claude'), false);
    assert.ok(mounted.button.title.includes('saved-native-id'));
    assert.equal(mounted.item('subagent-saved').icon, 'CircleCheck');
    assert.equal(mounted.item('subagent-saved').disabled, true, 'missing saved accounts are informational, not usable choices');
    await mounted.item('subagent-follow').behavior.onPress();
    assert.equal(mounted.sets()[0].input.request.selection, null);
  } finally { mounted.stop(); }
});

test('compiled Pi pill on Codex offers the default Claude login by name', async () => {
  const mounted = await mountPills(routingStatus(), {family:'pi'});
  try {
    const choices = mounted.items().filter(item => item.id.startsWith('subagent-'));
    assert.ok(choices.some(item => item.id === 'subagent-claude'));
    assert.equal(choices.some(item => item.id === 'subagent-codex'), false, 'the session already names the default Codex login');
    assert.equal(new Set(choices.map(item => item.title)).size, choices.length);
    const base = mounted.button.label;
    await mounted.item('subagent-codex-native-account-id').behavior.onPress();
    assert.equal(mounted.button.label, base, 'subagents on the same provider keep the provider name');
    await mounted.item('subagent-claude').behavior.onPress();
    assert.deepEqual(mounted.sets()[1].input.request.selection, {providerId:'claude-bridge',accountId:null}, 'Claude only supports its default login');
    assert.notEqual(mounted.button.label, base, 'subagents on another provider mark the pill as mixed');
    assert.ok(mounted.button.title.includes('Claude'), 'the title still names the subagent provider');
  } finally { mounted.stop(); }
});

test('compiled Pi pill works when the session has no managed account route', async () => {
  const mounted = await mountPills(routingStatus({providerId:'claude-bridge',accountId:null}), {unrouted:true});
  try {
    assert.ok(mounted.button);
    assert.equal(mounted.item('subagent-claude').icon, 'CircleCheck');
    await mounted.item('subagent-follow').behavior.onPress();
    assert.equal(mounted.sets()[0].input.request.selection, null);
  } finally { mounted.stop(); }
});

test('compiled Pi pill hides unsupported controls and leaves native agents unchanged', async () => {
  const mounted = await mountPills({...routingStatus(),available:false,snapshot:null});
  try {
    assert.equal(mounted.items().some(item => item.id.startsWith('subagent-')), false);
  } finally { mounted.stop(); }
  const native = await mountPills(routingStatus(), {provider:'claude'});
  try {
    assert.equal(native.button, null, 'single-account native agents retain the hidden pill');
    assert.equal(native.calls.length, 0);
  } finally { native.stop(); }
});

test('compiled Pi pill disables duplicate saves and refreshes stale routing before retry', async () => {
  let finishSet;
  const mounted = await mountPills(routingStatus(), {onSet:async (_input,current) => {
    await new Promise(resolve => { finishSet = resolve; });
    current.snapshot.revision = 7;
    throw Error('stale-selection');
  }});
  try {
    const action = mounted.item('subagent-codex-native-account-id').behavior.onPress;
    const pending = action();
    assert.ok(mounted.items().filter(item => item.id.startsWith('subagent-')).every(item => item.disabled));
    await action();
    assert.equal(mounted.sets().length, 1);
    finishSet();
    await assert.rejects(pending, error => error.message.length < 100 && !error.message.includes('stale-selection'));
    assert.equal(mounted.calls.filter(call => call.rpc.name.endsWith('.status')).length, 2);
    assert.equal(mounted.item('subagent-codex-native-account-id').disabled, false);
    const retry = mounted.item('subagent-codex-native-account-id').behavior.onPress();
    assert.equal(mounted.sets()[1].input.request.expectedRevision, 7);
    finishSet(); await assert.rejects(retry);
  } finally { mounted.stop(); }
});

test('compiled Pi pill ignores a late poll after saving a newer choice', async () => {
  let finishRead;
  const mounted = await mountPills(routingStatus(), {onStatus:async (current,read) => {
    const status = structuredClone(current);
    if (read === 2) await new Promise(resolve => {finishRead=resolve;});
    return status;
  }});
  try {
    const now = Date.now;
    try { Date.now = () => now()+16_000; mounted.poll(); } finally { Date.now = now; }
    await mounted.item('subagent-codex-native-account-id').behavior.onPress();
    finishRead(); await settle();
    assert.equal(mounted.item('subagent-codex-native-account-id').icon, 'CircleCheck');
    await mounted.item('subagent-follow').behavior.onPress();
    assert.equal(mounted.sets()[1].input.request.expectedRevision, 3);
  } finally { mounted.stop(); }
});

test('compiled Pi pill ignores status replies after disposal', async () => {
  let finishRead;
  const mounted = await mountPills(routingStatus(), {onStatus:current => new Promise(resolve => {finishRead=()=>resolve(current);})});
  mounted.stop(); finishRead(); await settle();
  assert.equal(mounted.button, null);
  assert.equal(mounted.calls.length, 1);
});

test('compiled Accounts does not render session provider choices', () => {
  const state = {...sample,subagentSessions:[{agentId:'pi-agent',workspaceId:'workspace',title:'Unique session title',status:'idle'}]};
  const tree = render(surface.AccountsSurface,{theme:{colors:palettes[0]},layout:{compact:true,platform:'ios'},host:{id:'fixture',label:'Local host'},isFocused:true,store:{...store,getSnapshot:()=>({state,error:null})}});
  assert.equal(text(tree).includes('Unique session title'), false);
});

function routingStatus(selection = null) {
  return { available:true, sessionId:'session', runtimeEpoch:'11111111-1111-4111-8111-111111111111', snapshot:{protocol:1,sessionId:'session',serviceEpoch:'service',revision:2,selection}, providers:['claude-bridge','openai-codex'], codexAccounts:[{id:'native-account-id',label:'Work label'},{id:'second-native-id',label:'Personal label'}], reason:null };
}
async function settle() { for (let i=0;i<8;i++) await new Promise(resolve => setImmediate(resolve)); }
async function mountPills(initial, {family='claude',provider='pi',unrouted=false,onSet=async()=>{},onStatus=async current=>structuredClone(current)} = {}) {
  const calls = [], listeners = new Set();
  let current = structuredClone(initial), button = null;
  const account = {...sample.accounts[0],family,id:family==='pi'?'pi-native:codex:default':'claude-default',status:'ready',isDefault:true,usage:null};
  const state = {...sample,showComposerPill:true,accounts:[account],providers:{pi:'pi',claude:'claude'},agents:unrouted?[]:[{agentId:'pi-agent',family,accountId:account.id,movable:true,canSwitch:true}]};
  const client = {
    rpc:async (rpc,input) => {
      calls.push({rpc,input});
      if (rpc.name.endsWith('.status')) return onStatus(current,calls.filter(call=>call.rpc.name.endsWith('.status')).length);
      await onSet(input,current);
      current = {...current,snapshot:{...current.snapshot,revision:current.snapshot.revision+1,selection:input.request.selection}};
      return current.snapshot;
    },
    paseo:{agents:{list:async()=>({subscription:{subscribe(observer) { observer.snapshot({entries:[{agent:{id:'pi-agent',workspaceId:'workspace',provider}}],pageInfo:{hasMore:false}}); }}})}},
    addComposerPill(contribution) { button=contribution.button; return {update(next) {button=next;},remove() {button=null;}}; },
    openSurface() {},
  };
  const fixtureStore = {current:{state,error:null},subscribe(listener) {listeners.add(listener);return()=>listeners.delete(listener);},refresh:async()=>{},rpc:client.rpc};
  const stop = pills.contributePills(client,fixtureStore);
  await settle();
  const items = () => button?.behavior.items ?? [];
  return {get button() {return button;},items,item:id=>{const item=items().find(item=>item.id===id);assert.ok(item,`missing ${id}`);return item;},calls,sets:()=>calls.filter(call=>call.rpc.name.endsWith('.set')),poll:()=>listeners.forEach(listener=>listener()),stop};
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

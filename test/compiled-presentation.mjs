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

test('compiled activity, agent and project views retain content and callbacks with native surfaces', () => {
  const theme = {colors:palettes[0]};
  for (const [Component, props] of [[activity.ActivityTab,{state:sample,onOpenAgent() {}}],[agents.AgentsTab,{state:sample,families:['claude'],store,onOpenAgent() {}}],[projects.ProjectsTab,{state:sample,store}]]) {
    const tree = render(Component,{theme,...props});
    const all = nodes(tree);
    assert.ok(all.length>0);
    assert.ok(!all.some(n=>n.type==='View' && style(n.props.style).borderRadius===12), 'grouped rows use native 8px surfaces');
  }
});

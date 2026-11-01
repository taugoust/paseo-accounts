import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = resolve(new URL('..', import.meta.url).pathname);
const host = '/nix/store/p8ighw60sbcns3p4clxxsf5yms7w5fk4-paseo-0.14.0/lib/paseo';
const compilerPath = process.env.PASEO_PLUGIN_COMPILER ?? join(host,'packages/server/dist/server/server/plugins/compiler.js');
const esbuildPath = join(host,'packages/server/node_modules/esbuild/lib/main.js');
const { build } = await import(pathToFileURL(esbuildPath));
const root = await mkdtemp(join(tmpdir(),'accounts-provider-unit-'));
let provider;
try {
  await build({ stdin: { contents: `export { applyPiProvider } from ${JSON.stringify(join(repo,'server/pi-provider.ts'))}; export { piApplyProviderRpc } from ${JSON.stringify(join(repo,'shared/pi-native.ts'))};`, resolveDir: repo, loader: 'ts' },
    outfile: join(root,'provider.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name:'nix-sdk', setup(b) {
      b.onResolve({ filter:/^(@getpaseo\/plugin(?:\/server)?|zod)$/ }, ({path}) => ({path:path === 'zod' ? join(host,'node_modules/zod/index.js') : join(host,'packages/plugin/dist/index.js')}));
    }}] });
  provider = await import(pathToFileURL(join(root,'provider.mjs')));
} catch (error) { await rm(root,{recursive:true,force:true}); throw error; }
test.after(async () => { await rm(root,{recursive:true,force:true}); });
const uuid = '11111111-1111-4111-8111-111111111111';
function snapshot(agentId, requestedProvider, config = {}) {
  const route = config.route ?? 'openai';
  return { protocol:1, serviceEpoch:`service-${agentId}`, selectionRevision:config.revision ?? (requestedProvider === route ? 7 : 12), sessionId:`session-${agentId}`,
    accounts:[], providerId:requestedProvider, guardedDefaultSwitchVersion:config.capability === false ? undefined : 1,
    sessionRouting:{version:1,providerId:route,revision:config.routeRevision ?? 3}, supportedProviders:config.supportedProviders ?? ['openai','openai-codex'],
    currentAccountId:config.pinned ? 'LocalPin' : null, defaultSelected:!config.pinned, activationStatus:'active', busy:!!config.busy, canSwitch:config.canSwitch !== false,
    usage:{effectiveCredential:'unknown',status:'unknown',remoteEntitlement:'not-queried',settingsUrl:null} };
}
function agent(id, provider='openai') { return { id, provider:'pi', workspaceId:`workspace-${id}`, archivedAt:null,status:'idle',model:`${provider}/fixture-model` }; }
function harness(options={}) {
  const agents = options.agents ?? [agent('default')];
  const reads = new Map(), switches = [];
  const list = options.list ?? (async () => ({entries:agents.map(agent=>({agent})),pageInfo:{hasMore:false}}));
  const context = { paseo:{ agents:{ list, ref:id=>({refresh:async()=>({agent:agents.find(row=>row.id===id)})}) } } };
  const controls = {
    async status({agentId,providerId}) {
      const count=(reads.get(`${agentId}:${providerId}`)??0)+1; reads.set(`${agentId}:${providerId}`,count);
      if (options.unavailable?.has(agentId)) return {available:false,sessionId:null,runtimeEpoch:null,snapshot:null,reason:'offline'};
      const config=options.state?.(agentId,providerId,count) ?? {};
      if (config.unavailable) return {available:false,sessionId:null,runtimeEpoch:null,snapshot:null,reason:'offline'};
      const value=snapshot(agentId,providerId,config);
      return {available:true,sessionId:value.sessionId,runtimeEpoch:uuid,snapshot:value,reason:null};
    },
    async switch(input) {
      switches.push(structuredClone(input));
      if (options.switchResult) return options.switchResult(input);
      const request=input.request;
      const value=snapshot(input.agentId,request.providerId,{route:request.providerId,routeRevision:4,revision:request.expectedSelectionRevision});
      return {ok:true,requestId:request.requestId,snapshot:value};
    },
  };
  return { context,controls,reads,switches,async apply(apply=true){return provider.applyPiProvider({providerId:'openai-codex',apply},context,controls);} };
}
test('provider-wide switch changes only default followers and classifies pins/busy/unavailable/unsupported as skips', async()=>{
  const h=harness({agents:[agent('default'),agent('pin'),agent('busy'),agent('unsupported'),agent('offline')],state:(id,requested)=>({pinned:id==='pin',busy:id==='busy',unavailable:id==='offline',supportedProviders:id==='unsupported'&&requested==='openai-codex'?['openai']:undefined})});
  const result=await h.apply();
  provider.piApplyProviderRpc.output.parse(result);
  assert.equal(result.discoveryComplete,true); assert.deepEqual(result.applied,['default']); assert.equal(result.pinnedCount,1);
  assert.deepEqual(result.skipped.map(row=>row.agentId).sort(),['busy','offline','unsupported']); assert.deepEqual(result.failed,[]);
  assert.equal(h.switches.length,1);
  assert.deepEqual(h.switches[0].request.expectedDefaultSource,{providerId:'openai',selectionRevision:7});
  assert.equal(h.switches[0].request.accountId,null); assert.equal('expectedDefaultSelection' in h.switches[0],false);
});
test('selection races after preflight are explicitly skipped without switch dispatch',async()=>{
  const h=harness({state:(id,requested,count)=>({revision:id==='default'&&requested==='openai'&&count>=2?8:7})});
  const result=await h.apply();
  assert.deepEqual(result.applied,[]); assert.equal(result.skipped.length,1); assert.match(result.skipped[0].reason,/selection changed/); assert.equal(h.switches.length,0);
});
test('producer busy/stale result is a skip, not an operational failure',async()=>{
  const h=harness({switchResult:async input=>({ok:false,requestId:input.request.requestId,reason:'busy',snapshot:snapshot(input.agentId,input.request.providerId,{route:'openai'})})});
  const result=await h.apply();
  assert.deepEqual(result.applied,[]); assert.equal(result.skipped.length,1); assert.match(result.skipped[0].reason,/became busy/); assert.deepEqual(result.failed,[]);
});
test('old strict host output without optional skipped remains parse-compatible',()=>{
  const result={providerId:'openai-codex',apply:true,eligibleCount:0,defaultAccountCount:0,currentProvider:null,applied:[],failed:[],pinnedCount:0,alreadySelectedCount:0,discoveryComplete:true};
  assert.deepEqual(provider.piApplyProviderRpc.output.parse(result),result);
});
test('more than 2000 discovered entries fail closed with no status reads or mutations',async()=>{
  let calls=0;
  const h=harness({list:async()=>{calls++; return {entries:Array.from({length:200},(_,index)=>({agent:agent(`candidate-${calls}-${index}`)})),pageInfo:{hasMore:true,nextCursor:`cursor-${calls}`}};}});
  const result=await h.apply();
  assert.equal(calls,10); assert.equal(result.discoveryComplete,false); assert.equal(h.reads.size,0); assert.equal(h.switches.length,0);
});
test('cursor cycles stop discovery early and never partially apply',async()=>{
  let calls=0;
  const h=harness({list:async()=>{calls++;return {entries:[{agent:agent('candidate')}],pageInfo:{hasMore:true,nextCursor:'repeat'}};}});
  const result=await h.apply();
  assert.equal(calls,2); assert.equal(result.discoveryComplete,false); assert.equal(h.reads.size,0); assert.equal(h.switches.length,0);
});

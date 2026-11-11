import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativePillProvider} from '../client/pill-provider.ts';
test('pill names Codex for the Codex default and named profiles only',()=>{
 assert.equal(nativePillProvider('pi-native:codex:default'),'Codex');
 assert.equal(nativePillProvider('pi-native:codex:profile:work'),'Codex');
 assert.equal(nativePillProvider('pi-native:default'),null);
 assert.equal(nativePillProvider('pi-native:profile:work'),null);
 assert.equal(nativePillProvider('unknown'),null);
});

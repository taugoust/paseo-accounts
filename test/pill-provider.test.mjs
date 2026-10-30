import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativePillProvider} from '../client/pill-provider.ts';
test('pill follows current native route provider, including default and named accounts',()=>{
 assert.equal(nativePillProvider('pi-native:default'),'OpenAI');
 assert.equal(nativePillProvider('pi-native:profile:work'),'OpenAI');
 assert.equal(nativePillProvider('pi-native:codex:default'),'Codex');
 assert.equal(nativePillProvider('pi-native:codex:profile:work'),'Codex');
 assert.equal(nativePillProvider('unknown'),null);
});

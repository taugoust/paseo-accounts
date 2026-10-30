import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const compiler='/nix/store/0ja39zawk3hix1rkfqzm5qrlsjzqlgih-paseo-0.14.0/lib/paseo/packages/server/dist/server/server/plugins/compiler.js';
const require=createRequire(compiler);
test('quota auth accepts managed links but rejects unsafe targets and broken links',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'quota-auth-links-'));
 try {
  const bundle=join(dir,'quota.mjs');
  await require('esbuild').build({entryPoints:[new URL('../server/pi-quota.ts',import.meta.url).pathname],outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@getpaseo/plugin/shared':'/nix/store/0ja39zawk3hix1rkfqzm5qrlsjzqlgih-paseo-0.14.0/lib/paseo/packages/plugin/dist/shared/index.js'}});
  const {readQuotaAuthData}=await import(pathToFileURL(bundle));
  const target=join(dir,'private.json'), link=join(dir,'auth.json');
  await writeFile(target,JSON.stringify({openai:{type:'oauth',access:'test-openai',expires:Date.now()+60000},'openai-codex':{type:'oauth',access:'test-codex',expires:Date.now()+60000}}),{mode:0o600});
  await symlink(target,join(dir,'managed'));await symlink(join(dir,'managed'),link);
  let auth=await readQuotaAuthData(dir);
  assert.equal(auth.defaultCredential.access,'test-openai');assert.equal(auth.codexDefaultCredential.access,'test-codex');
  await chmod(target,0o644);auth=await readQuotaAuthData(dir);assert.equal(auth.defaultCredential,undefined);assert.equal(auth.codexDefaultCredential,undefined);
  await rm(target);assert.equal((await readQuotaAuthData(dir)).defaultCredential,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

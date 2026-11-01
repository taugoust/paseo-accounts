// Immutable installed Paseo/Nix dependencies for the real-producer integration test.
// Override only when validating against a different explicitly installed host build.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const host = process.env.PASEO_NIX_ROOT ?? '/nix/store/p8ighw60sbcns3p4clxxsf5yms7w5fk4-paseo-0.14.0/lib/paseo';
export const compilerPath = process.env.PASEO_PLUGIN_COMPILER ?? join(host,'packages/server/dist/server/server/plugins/compiler.js');
export const esbuildPath = join(host,'packages/server/node_modules/esbuild/lib/main.js');
export const zodPath = join(host,'node_modules/zod/index.js');
export const pluginPath = join(host,'packages/plugin/dist/index.js');
export const pluginSharedPath = join(host,'packages/plugin/dist/shared/index.js');
export const esbuild = await import(pathToFileURL(esbuildPath));
export function paseoResolverPlugin(){
  return {name:'pinned-paseo-nix-dependencies',setup(build){
    build.onResolve({filter:/^(@getpaseo\/plugin(?:\/shared)?|zod)$/},({path})=>({
      path:path==='zod'?zodPath:path.endsWith('/shared')?pluginSharedPath:pluginPath,
    }));
  }};
}

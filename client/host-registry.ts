import type { AccountsStore } from "./store";

/** Shared by separately evaluated plugin bundles in this Paseo renderer realm. */
const KEY = "__paseo_accounts_hosts_v1__";
type Entry = { owner: object; generation: number; store: AccountsStore; online: boolean };
type Registry = { entries: Map<string, Entry>; listeners: Set<() => void>; revision: number; generation: number };
const realm = globalThis as typeof globalThis & { [KEY]?: Registry };
const registry = realm[KEY] ??= { entries: new Map(), listeners: new Set(), revision: 0, generation: 0 };
const emit = () => { registry.revision++; for (const listener of registry.listeners) listener(); };
export const subscribeHosts = (listener: () => void) => { registry.listeners.add(listener); return () => { registry.listeners.delete(listener); }; };
export const hostsRevision = () => registry.revision;
export function createHostBinding(store: AccountsStore) {
  const owner = {};
  const generation = ++registry.generation;
  let disposed = false;
  const owned = new Set<string>();
  return {
    bind(id: string, online: boolean) {
      if (disposed) return;
      const previous = registry.entries.get(id);
      // Delayed effects from an older mount cannot reclaim an ID after replacement.
      if ((previous && previous.generation > generation) || (owned.has(id) && previous?.owner !== owner)) return;
      owned.add(id);
      if (previous?.owner === owner && previous.online === online) return;
      registry.entries.set(id, { owner, generation, store, online }); emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of owned) if (registry.entries.get(id)?.owner === owner) registry.entries.delete(id);
      emit();
    },
  };
}
export function usableHost(id: string) { return registry.entries.get(id)?.online === true; }
/** Opaque per-binding lease used to fence a UI operation to its source instance. */
export function hostLease(id: string): object | null {
  const entry = registry.entries.get(id);
  return entry?.online ? entry : null;
}
export function hostLeaseCurrent(id: string, lease: object | null): boolean {
  return lease !== null && registry.entries.get(id) === lease && registry.entries.get(id)?.online === true;
}
/** Capture one host-local store, fencing replacement/offline both before and after async work. */
export async function withHost<T>(id: string, action: (store: AccountsStore, current: () => void) => Promise<T>): Promise<T> {
  const entry = registry.entries.get(id);
  const current = () => {
    if (!entry || !entry.online || registry.entries.get(id) !== entry) throw new Error("Accounts instance unavailable; refresh and retry.");
  };
  current();
  const result = await action(entry!.store, current);
  current();
  return result;
}

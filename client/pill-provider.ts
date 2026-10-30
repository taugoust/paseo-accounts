/** Resolve native Pi provider from the authenticated current account route, never a default. */
export function nativePillProvider(accountId: string): string | null {
  if (accountId === "pi-native:codex:default" || accountId.startsWith("pi-native:codex:profile:")) return "Codex";
  if (accountId === "pi-native:default" || accountId.startsWith("pi-native:profile:")) return "OpenAI";
  return null;
}

/** Pi accounts are Codex logins; name that provider on the pill of an agent routed to one. */
export function nativePillProvider(accountId: string): string | null {
  return accountId === "pi-native:codex:default" ||
    accountId.startsWith("pi-native:codex:profile:")
    ? "Codex"
    : null;
}

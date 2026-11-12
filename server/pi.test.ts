import { describe, expect, it } from "vitest";
import { PiAdapter } from "./pi";

// Pi manages its own accounts, so the adapter only keeps Pi out of the plugin's account handling.
describe("Pi", () => {
  it("is never available for plugin-managed accounts", async () => {
    const adapter = new PiAdapter();
    expect(await adapter.available()).toMatchObject({ ok: false });
    expect((await adapter.identity(null)).signedIn).toBe(false);
    expect(await adapter.env("/some/home")).toEqual({});
  });

  it("refuses to create, sign in or sign out accounts", async () => {
    const adapter = new PiAdapter();
    const refused = /\/accounts in the Pi terminal/;
    await expect(adapter.prepareHome("/some/home")).rejects.toThrow(refused);
    await expect(adapter.login(null, "oauth" as never)).rejects.toThrow(refused);
    await expect(adapter.logout(null)).rejects.toThrow(refused);
  });
});

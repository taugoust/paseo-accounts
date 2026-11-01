import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HostBinding } from "./client/host-binding";
import { createHostBinding } from "./client/host-registry";
import { AccountsSurface } from "./client/accounts-surface";
import { contributeCommands } from "./client/commands";
import { contributePills } from "./client/pills";
import { PreferencesScreen } from "./client/settings-screen";
import { AccountsSidebarRow } from "./client/sidebar-row";
import { createStore } from "./client/store";
import { SwitchRowView } from "./client/switch-row";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, SwitchRowSchema } from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  const store = createStore(client);
  store.start();
  const binding = createHostBinding(store);

  client.addSurface("accounts", (props) => <HostBinding host={props.host} binding={binding}><AccountsSurface {...props} store={store} /></HostBinding>);
  // Paseo 0.12+ lets the row show a badge; older hosts only take the plain item.
  if (typeof client.addSidebarHeaderItem === "function") {
    client.addSidebarHeaderItem({ id: "accounts", title: "Accounts", Component: (props) => <HostBinding host={props.host} binding={binding}><AccountsSidebarRow {...props} store={store} /></HostBinding> });
  } else {
    client.addSidebarItem({ id: "accounts", title: "Accounts", icon: "Users", surface: "accounts" });
  }
  client.addSettingsScreen({
    id: "preferences",
    title: "Account preferences",
    icon: "SlidersHorizontal",
    Component: (props) => (
      <PreferencesScreen {...props} store={store} onOpenAccounts={() => client.openSurface("accounts")} />
    ),
  });
  client.addTimelineRenderer({
    kind: SWITCH_ROW_KIND,
    version: SWITCH_ROW_VERSION,
    schema: SwitchRowSchema,
    Component: SwitchRowView,
  });

  const stopCommands = contributeCommands(client, store);
  const stopPills = contributePills(client, store);

  return () => {
    binding.dispose();
    stopPills();
    stopCommands();
    store.stop();
  };
}

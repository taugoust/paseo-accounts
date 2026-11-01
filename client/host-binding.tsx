import { useHosts, type PluginHostProps } from "@getpaseo/plugin/client";
import { useEffect, type ReactNode } from "react";
import type { createHostBinding } from "./host-registry";

export function HostBinding({ host, binding, children }: {
  host: PluginHostProps["host"];
  binding: ReturnType<typeof createHostBinding>;
  children: ReactNode;
}) {
  const hosts = useHosts();
  const online = hosts.find((entry) => entry.serverId === host.id)?.status === "online";
  useEffect(() => { binding.bind(host.id, online); }, [binding, host.id, online]);
  return <>{children}</>;
}

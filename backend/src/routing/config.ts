// Master Router configuration. Lives in the routing module rather than store.ts because it's only
// ever read by this feature, and it's one small file rather than a slice of shared board state.
import { readFile } from "node:fs/promises";
import { ROUTING_CONFIG_PATH } from "../constants.ts";

export type RoutingConfig = {
  /**
   * Projects the router must never target. Exclusion matters more than an inclusion picker here:
   * test/dummy sessions are commonly launched dangerous-mode, so a task misrouted into one gets
   * acted on with no permission prompt. Set once, stays correct — whereas an inclusion list has to
   * be remembered on every routing action.
   */
  excludedProjects: string[];
  /** Global kill switch — stops both /api/route itself and the background digest worker. */
  enabled: boolean;
};

const DEFAULTS: RoutingConfig = { excludedProjects: [], enabled: true };

// Mirrors the on-disk `enabled` flag for isRouterEnabled()'s synchronous callers — fsWatcher fires
// on every transcript write, so that hot path can't afford an async file read per call.
let enabledCache = DEFAULTS.enabled;

export async function loadRoutingConfig(): Promise<RoutingConfig> {
  let cfg: RoutingConfig;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(await readFile(ROUTING_CONFIG_PATH, "utf-8")) };
  } catch {
    cfg = { ...DEFAULTS };
  }
  enabledCache = cfg.enabled;
  return cfg;
}

export async function saveRoutingConfig(cfg: RoutingConfig): Promise<void> {
  enabledCache = cfg.enabled;
  await Bun.write(ROUTING_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Synchronous — safe to call from the fsWatcher hot path. Reflects the last loaded/saved config. */
export function isRouterEnabled(): boolean {
  return enabledCache;
}

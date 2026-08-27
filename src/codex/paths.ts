import { homedir } from "node:os";
import { join } from "node:path";

export type CobPaths = {
  codexHome: string;
  rootConfig: string;
  profile: string;
  catalog: string;
  catalogMeta: string;
  cobConfig: string;
  pid: string;
  log: string;
  runtime: string;
  lock: string;
  startLease: string;
  stateDir: string;
};

export function resolveCodexHome(override = process.env.COB_CODEX_HOME): string {
  return override && override.length > 0 ? override : join(homedir(), ".codex");
}

export function resolvePaths(codexHome = resolveCodexHome()): CobPaths {
  return {
    codexHome,
    rootConfig: join(codexHome, "config.toml"),
    profile: join(codexHome, "cob.config.toml"),
    catalog: join(codexHome, "cob-catalog.json"),
    catalogMeta: join(codexHome, "cob-catalog.meta.json"),
    cobConfig: join(codexHome, "cob.toml"),
    pid: join(codexHome, "cob-gateway.pid"),
    log: join(codexHome, "cob-gateway.log"),
    runtime: join(codexHome, "cob-runtime.json"),
    lock: join(codexHome, "cob.lock"),
    startLease: join(codexHome, "cob.start-lease.json"),
    stateDir: join(codexHome, "cob-state"),
  };
}

#!/usr/bin/env node
import { isSurfaceSupportedOn, packReleaseTarball, parseCliArgs } from "./cli-session.js";
import { runClaudeCli } from "./claude/cli.js";
import { detectInstall, formatInstallLine } from "./core/install-detection.js";
import { runCodexCli } from "./codex/cli.js";
import { CobConfigError } from "./codex/config/schema.js";

async function main(argv: string[]): Promise<void> {
  const flags = parseCliArgs(argv);
  if (!isSurfaceSupportedOn(flags.surface, process.platform)) {
    console.error(
      "cob Codex requires macOS or Linux; the Codex surface does not support Windows. `cob claude ...` remains available.",
    );
    process.exit(1);
  }
  if (flags.command === "version") {
    console.log(formatInstallLine(detectInstall()));
    return;
  }
  if (flags.command === "pack") {
    const packed = packReleaseTarball(detectInstall());
    console.log(packed.filename);
    console.log("Install the live Desktop/CLI gateway with:");
    console.log(`  npm install -g ./${packed.filename}`);
    console.log("  cob start");
    return;
  }
  if (flags.surface === "claude") {
    await runClaudeCli(flags);
    return;
  }
  await runCodexCli(flags);
}

main(process.argv).catch((error: unknown) => {
  if (error instanceof CobConfigError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

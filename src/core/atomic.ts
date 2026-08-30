import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function uniqueTempPath(target: string, pid = process.pid): string {
  const id = `${pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  return `${target}.${id}.tmp`;
}

/**
 * Atomic write via a unique temp file that is always unlinked, even when the
 * write or rename fails. Without an explicit mode, an existing regular target
 * keeps its permissions; a fresh target gets the process umask default.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = uniqueTempPath(path);
  try {
    const effectiveMode = mode ?? preservedFileMode(path);
    if (typeof data === "string") {
      writeFileSync(tmp, data, {
        encoding: "utf8",
        ...(effectiveMode === undefined ? {} : { mode: effectiveMode }),
      });
    } else {
      writeFileSync(tmp, data, effectiveMode === undefined ? undefined : { mode: effectiveMode });
    }
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // the tmp was consumed by rename or never created
    }
  }
}

function preservedFileMode(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

export function readFileBufferOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

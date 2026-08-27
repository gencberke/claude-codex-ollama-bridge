import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function uniqueTempPath(target: string, pid = process.pid): string {
  const id = `${pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  return `${target}.${id}.tmp`;
}

export function writeFileAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = uniqueTempPath(path);
  if (typeof data === "string") {
    writeFileSync(tmp, data, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
  } else {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  }
  renameSync(tmp, path);
}

export function readFileBufferOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

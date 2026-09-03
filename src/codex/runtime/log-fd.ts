import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** Human detached logs are intentionally bounded: current + one archive. */
export const HUMAN_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Open the detached-serve log with private-by-default semantics: append-only,
 * never following a symlink, and re-verified through the open fd before the
 * launcher spawns any child. A symlinked, non-regular, or foreign-owned
 * target fails closed instead of leaking serve output through it.
 */
export function openPrivateLogFd(logPath: string): number {
  const nofollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    logPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | nofollow,
    0o600,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`cob log target is not a regular file: ${logPath}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(`cob log target is not owned by the current user: ${logPath}`);
    }
    // An existing broader mode does not shrink via open(2); fchmod must succeed
    // or the detached child would keep writing to a group/world-readable log.
    if ((st.mode & 0o777) !== 0o600) {
      try {
        fchmodSync(fd, 0o600);
      } catch {
        throw new Error(`cob log mode cannot be restricted to 0600: ${logPath}`);
      }
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export function closePrivateLogFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed or otherwise unusable; never mask the original error path
  }
}

/**
 * Remove the current and archive only after both targets have passed the same
 * private-file checks as a normal log open. This is called by a newly spawned
 * detached child, never by an already-running `cob start` path.
 */
export function resetPrivateLogFiles(logPath: string): void {
  validateOptionalPrivateLog(logPath);
  validateOptionalPrivateLog(`${logPath}.1`);
  unlinkIfPresent(logPath);
  unlinkIfPresent(`${logPath}.1`);
}

export type PrivateLogWriter = {
  write(chunk: string | Uint8Array): void;
  close(): void;
};

/** Synchronous, best-effort rotating writer for the detached serve process. */
export function createPrivateRotatingLogWriter(logPath: string, reset = false): PrivateLogWriter {
  if (reset) resetPrivateLogFiles(logPath);
  let fd: number | undefined = openPrivateLogFd(logPath);
  let failed = false;
  const close = (): void => {
    if (fd === undefined) return;
    closePrivateLogFd(fd);
    fd = undefined;
  };
  const disable = (): void => {
    failed = true;
    close();
  };
  const rotate = (): void => {
    close();
    try {
      validateOptionalPrivateLog(`${logPath}.1`);
      unlinkIfPresent(`${logPath}.1`);
      // The current file was checked when opened. Rename is atomic within the
      // Codex home and the next open rechecks ownership and mode.
      renameSync(logPath, `${logPath}.1`);
      const archiveFd = openPrivateLogFd(`${logPath}.1`);
      try {
        if (fstatSync(archiveFd).size > HUMAN_LOG_MAX_BYTES) {
          ftruncateSync(archiveFd, HUMAN_LOG_MAX_BYTES);
        }
      } finally {
        closePrivateLogFd(archiveFd);
      }
      fd = openPrivateLogFd(logPath);
    } catch {
      disable();
    }
  };
  return {
    write(chunk: string | Uint8Array): void {
      if (failed || fd === undefined) return;
      let bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      try {
        while (bytes.length > 0 && fd !== undefined) {
          const available = HUMAN_LOG_MAX_BYTES - fstatSync(fd).size;
          if (available <= 0) {
            rotate();
            continue;
          }
          const part = bytes.subarray(0, Math.min(available, bytes.length));
          // `writeSync` can theoretically write fewer bytes than requested;
          // consume only the exact number reported by the kernel.
          const written = writeChunk(fd, part);
          if (written <= 0) break;
          bytes = bytes.subarray(written);
          if (bytes.length > 0) rotate();
        }
      } catch {
        disable();
      }
    },
    close,
  };
}

function writeChunk(fd: number, bytes: Buffer): number {
  return writeSync(fd, bytes);
}

function validateOptionalPrivateLog(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`cob log target is not a regular file: ${path}`);
    const fd = openPrivateLogFd(path);
    closePrivateLogFd(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

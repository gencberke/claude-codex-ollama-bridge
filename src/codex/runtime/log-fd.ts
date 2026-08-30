import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from "node:fs";

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
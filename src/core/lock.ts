import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { uniqueTempPath } from "./atomic.js";
import { cobProcessIdentity, isPidAlive, ownStartKey, processStartKey } from "./process-info.js";

const RETRY_MS = 50;
const RETRY_MAX_MS = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Empty/corrupt lock files are not unlinked until they have aged. */
export const STALE_CORRUPT_MS = 1_000;
const heldTokens = new Map<string, string>();
const heldFds = new Map<string, number>();

type RecoveryClaim = {
  path: string;
  ino: number;
  dev: number;
  token: string;
};

type RecoveryClaimRecord = {
  pid: number;
  token: string;
  startKey?: string;
  lockIno: number;
  lockDev: number;
};

type RecoveryClaimSnapshot = {
  ino: number;
  dev: number;
  record: RecoveryClaimRecord | null;
};

const claimByFd = new Map<number, RecoveryClaim>();

type LockRecord = {
  pid: number;
  token?: string;
  startKey?: string;
  argv?: string;
  createdAt?: string;
};

type LockSnapshot = {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  record: LockRecord | null;
};

export class LockTimeoutError extends Error {
  readonly code = "lock_timeout";
  constructor(path: string) {
    super(`timed out waiting for cob lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

export class LockHandoffError extends Error {
  readonly code = "lock_handoff_failed";
  constructor(message: string) {
    super(message);
    this.name = "LockHandoffError";
  }
}

export async function withExclusiveLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  await acquireLock(lockPath, timeoutMs);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}

export async function acquireLock(lockPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let delay = RETRY_MS;
  while (Date.now() < deadline) {
    const token = tryCreateLock(lockPath);
    if (token) return token;
    recoverStaleLock(lockPath);
    await sleep(delay);
    delay = Math.min(RETRY_MAX_MS, delay + 25);
  }
  throw new LockTimeoutError(lockPath);
}

export function heldLockToken(lockPath: string): string | undefined {
  return heldTokens.get(lockPath);
}

export function peekLockRecord(lockPath: string): LockRecord | null {
  return readLockSnapshot(lockPath)?.record ?? null;
}

export function releaseLock(lockPath: string): void {
  const token = heldTokens.get(lockPath);
  heldTokens.delete(lockPath);
  const fd = heldFds.get(lockPath);
  heldFds.delete(lockPath);
  try {
    if (!token) return;
    const snapshot = fd !== undefined ? snapshotFromFd(fd, lockPath) : readLockSnapshot(lockPath);
    if (!snapshot?.record || snapshot.record.token !== token) return;
    if (fd !== undefined) unlinkHeldIfUnchanged(lockPath, fd, snapshot);
    else unlinkIfUnchanged(lockPath, snapshot);
  } finally {
    if (fd !== undefined) closeFd(fd);
  }
}

/**
 * Take over a lock we were handed via `COB_LOCK_TOKEN`. Rewrites pid to this
 * process and rotates the token so the parent cannot unlink during child boot.
 * Writes in place against the existing inode; on failure restores prior bytes.
 */
export function adoptLock(lockPath: string, expectedToken: string): string {
  if (!expectedToken) {
    throw new LockHandoffError("lock handoff failed: missing token");
  }
  const nextToken = randomBytes(16).toString("hex");
  const record: LockRecord = {
    pid: process.pid,
    token: nextToken,
    startKey: ownStartKey(),
    argv: process.argv.slice(1).join(" "),
    createdAt: new Date().toISOString(),
  };
  const fd = openSync(lockPath, "r+");
  let previous: Buffer | undefined;
  try {
    const st = fstatSync(fd);
    previous = readFileSync(fd);
    const current = parseLockRecord(previous.toString("utf8"));
    if (!current || current.token !== expectedToken) {
      throw new LockHandoffError("lock handoff failed: token mismatch");
    }
    const payload = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(payload);
    writeSync(fd, payload, 0);
    ftruncateSync(fd, bytes);
    const pathSt = lstatSync(lockPath);
    if (BigInt(pathSt.ino) !== BigInt(st.ino) || BigInt(pathSt.dev) !== BigInt(st.dev)) {
      restoreLockBytes(fd, previous);
      throw new LockHandoffError("lock handoff failed: lock file replaced");
    }
  } catch (error) {
    if (previous !== undefined) {
      try {
        restoreLockBytes(fd, previous);
      } catch {
        // keep the original error
      }
    }
    closeSync(fd);
    throw error;
  }
  closeHeldFd(lockPath);
  heldFds.set(lockPath, fd);
  heldTokens.set(lockPath, nextToken);
  return nextToken;
}

function tryCreateLock(lockPath: string): string | undefined {
  // Reap definitely-stale claim artifacts, but never let leftovers block
  // publishing a free lock path. Claim files serialize recoverers, not creators.
  recoverOrphanedRecoveryClaims(lockPath);
  const token = randomBytes(16).toString("hex");
  const payload = `${JSON.stringify({
    pid: process.pid,
    token,
    startKey: ownStartKey(),
    argv: process.argv.slice(1).join(" "),
    createdAt: new Date().toISOString(),
  })}\n`;
  const tmp = uniqueTempPath(lockPath);
  try {
    writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    linkSync(tmp, lockPath);
  } catch (error) {
    unlinkQuiet(tmp);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  unlinkQuiet(tmp);
  let fd: number;
  try {
    fd = openExclusive(lockPath, false);
  } catch {
    // The path may have been replaced while the open was failing. Only clean
    // up if a fresh path/inode read still proves that our token is published.
    try {
      const snapshot = readLockSnapshot(lockPath);
      if (snapshot?.record?.pid === process.pid && snapshot.record.token === token) {
        unlinkIfUnchanged(lockPath, snapshot);
      }
    } catch {
      // Leave the path in place when ownership cannot be proved.
    }
    return undefined;
  }
  closeHeldFd(lockPath);
  heldFds.set(lockPath, fd);
  heldTokens.set(lockPath, token);
  return token;
}

function recoverStaleLock(lockPath: string): void {
  const snapshot = readLockSnapshot(lockPath);
  if (!snapshot) return;
  if (!snapshot.record) {
    if (Date.now() - snapshot.mtimeMs < STALE_CORRUPT_MS) return;
    unlinkIfUnchanged(lockPath, snapshot);
    return;
  }
  if (snapshot.record.pid === process.pid) return;
  if (!isPidAlive(snapshot.record.pid)) {
    unlinkIfUnchanged(lockPath, snapshot);
    return;
  }
  if (snapshot.record.startKey) {
    const live = processStartKey(snapshot.record.pid);
    if (live === undefined) return;
    if (live !== snapshot.record.startKey) {
      unlinkIfUnchanged(lockPath, snapshot);
    }
    return;
  }
  // Legacy locks without startKey: steal only when the live PID is definitely not cob.
  if (cobProcessIdentity(snapshot.record.pid) === "foreign") {
    unlinkIfUnchanged(lockPath, snapshot);
  }
}

function snapshotFromFd(fd: number, lockPath: string): LockSnapshot | null {
  try {
    const st = fstatSync(fd);
    const pathSt = lstatSync(lockPath);
    if (BigInt(pathSt.ino) !== BigInt(st.ino) || BigInt(pathSt.dev) !== BigInt(st.dev)) return null;
    return {
      ino: Number(st.ino),
      dev: Number(st.dev),
      size: st.size,
      mtimeMs: st.mtimeMs,
      record: parseLockRecord(readFdUtf8(fd)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const st = lstatSync(lockPath);
    let record: LockRecord | null = null;
    try {
      record = parseLockRecord(readFileSync(lockPath, "utf8"));
    } catch {
      record = null;
    }
    return {
      ino: Number(st.ino),
      dev: Number(st.dev),
      size: st.size,
      mtimeMs: st.mtimeMs,
      record,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("pid" in parsed)) return null;
    const pid = Number((parsed as { pid: unknown }).pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const token = (parsed as { token?: unknown }).token;
    const startKey = (parsed as { startKey?: unknown }).startKey;
    const argv = (parsed as { argv?: unknown }).argv;
    const createdAt = (parsed as { createdAt?: unknown }).createdAt;
    return {
      pid,
      token: typeof token === "string" && token.length > 0 ? token : undefined,
      startKey: typeof startKey === "string" && startKey.length > 0 ? startKey : undefined,
      argv: typeof argv === "string" ? argv : undefined,
      createdAt: typeof createdAt === "string" ? createdAt : undefined,
    };
  } catch {
    return null;
  }
}

function recordStillMatches(fd: number, expected: LockSnapshot): boolean {
  const st = fstatSync(fd);
  if (BigInt(st.ino) !== BigInt(expected.ino) || BigInt(st.dev) !== BigInt(expected.dev)) return false;
  if (st.size !== expected.size || st.mtimeMs !== expected.mtimeMs) return false;
  if (expected.record) {
    const now = parseLockRecord(readFdUtf8(fd));
    if (!now || now.pid !== expected.record.pid) return false;
    if (expected.record.token) {
      if (now.token !== expected.record.token) return false;
    } else if (now.token) {
      return false;
    }
  } else if (parseLockRecord(readFdUtf8(fd))) {
    return false;
  }
  return true;
}

function pathStillThisInode(path: string, fd: number): boolean {
  try {
    const st = fstatSync(fd);
    const pathSt = lstatSync(path);
    return BigInt(pathSt.ino) === BigInt(st.ino) && BigInt(pathSt.dev) === BigInt(st.dev);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Recoverers must hold an exclusive kernel lock on this inode (or an inode
 * claim where that is unavailable) before unlinking by name. A later stat/token
 * check plus unlink is a TOCTOU race: another recoverer can unlink, a new owner
 * can create a new inode at the path, and the second recoverer would delete it.
 */
function unlinkIfUnchanged(path: string, expected: LockSnapshot): void {
  const fd = tryLockInodeForRecovery(path, expected);
  if (fd === undefined) return;
  try {
    if (!recoveryClaimStillOwned(fd)) return;
    if (!pathStillThisInode(path, fd)) return;
    if (!recordStillMatches(fd, expected)) return;
    if (!recoveryClaimStillOwned(fd)) return;
    if (!pathStillThisInode(path, fd)) return;
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    closeFd(fd);
  }
}

function unlinkHeldIfUnchanged(path: string, fd: number, expected: LockSnapshot): void {
  try {
    if (!pathStillThisInode(path, fd)) return;
    if (!recordStillMatches(fd, expected)) return;
    if (!pathStillThisInode(path, fd)) return;
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function tryLockInodeForRecovery(path: string, expected: LockSnapshot): number | undefined {
  if (exlockSupported()) {
    try {
      return openExclusive(path, true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES" || code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
  return tryClaimInode(path, expected);
}

function tryClaimInode(path: string, expected: LockSnapshot): number | undefined {
  const claim = `${path}.recover.${expected.dev}.${expected.ino}.claim`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = createRecoveryClaim(claim, expected);
    if (!owner) {
      if (attempt === 0 && reclaimStaleClaim(claim, expected)) continue;
      return undefined;
    }
    try {
      const fd = openSync(path, "r");
      const st = fstatSync(fd);
      if (
        BigInt(st.ino) !== BigInt(expected.ino) ||
        BigInt(st.dev) !== BigInt(expected.dev) ||
        !recordStillMatches(fd, expected) ||
        !claimStillOwned(owner)
      ) {
        closeSync(fd);
        if (claimStillOwned(owner)) releaseRecoveryClaim(owner);
        return undefined;
      }
      claimByFd.set(fd, owner);
      return fd;
    } catch (error) {
      if (claimStillOwned(owner)) releaseRecoveryClaim(owner);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return undefined;
}

function createRecoveryClaim(path: string, expected: LockSnapshot): RecoveryClaim | undefined {
  if (recoveryClaimPaths(path).length > 0) return undefined;
  const token = randomBytes(16).toString("hex");
  const payload = `${JSON.stringify({
    pid: process.pid,
    token,
    startKey: ownStartKey(),
    lockIno: expected.ino,
    lockDev: expected.dev,
  })}\n`;
  const tmp = uniqueTempPath(path);
  try {
    writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    linkSync(tmp, path);
  } catch (error) {
    unlinkQuiet(tmp);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  unlinkQuiet(tmp);
  const snapshot = readRecoveryClaimSnapshot(path);
  if (!snapshot?.record || snapshot.record.token !== token) return undefined;
  return { path, ino: snapshot.ino, dev: snapshot.dev, token };
}

function reclaimStaleClaim(path: string, expected: LockSnapshot): boolean {
  for (const candidate of recoveryClaimPaths(path)) {
    const observed = readRecoveryClaimSnapshot(candidate);
    if (
      !observed?.record ||
      observed.record.lockIno !== expected.ino ||
      observed.record.lockDev !== expected.dev ||
      !claimOwnerDefinitelyStale(observed.record)
    ) {
      continue;
    }

    // Rename moves whichever claim is current into a private name atomically.
    // Every private claim name is still a gate, so a live owner cannot be
    // bypassed while the moved inode is being inspected and restored.
    const moved = uniqueTempPath(path);
    try {
      renameSync(candidate, moved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const current = readRecoveryClaimSnapshot(moved);
    if (
      current?.record &&
      current.ino === observed.ino &&
      current.dev === observed.dev &&
      current.record.token === observed.record.token &&
      current.record.lockIno === expected.ino &&
      current.record.lockDev === expected.dev &&
      claimOwnerDefinitelyStale(current.record)
    ) {
      unlinkQuiet(moved);
      return true;
    }
    restoreRecoveryClaim(moved, candidate);
    return false;
  }
  return false;
}

function recoveryClaimPaths(claim: string): string[] {
  const parent = dirname(claim);
  const prefix = basename(claim);
  try {
    return readdirSync(parent)
      .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
      .map((name) => join(parent, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function recoverOrphanedRecoveryClaims(lockPath: string): void {
  const parent = dirname(lockPath);
  const prefix = `${basename(lockPath)}.recover.`;
  let names: string[];
  try {
    names = readdirSync(parent).filter((name) => name.startsWith(prefix));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const candidate = join(parent, name);
    const snapshot = readRecoveryClaimSnapshot(candidate);
    const record = snapshot?.record;
    if (!record || !claimOwnerDefinitelyStale(record)) continue;
    reclaimStaleClaim(candidate, {
      ino: record.lockIno,
      dev: record.lockDev,
      size: 0,
      mtimeMs: 0,
      record: null,
    });
  }
}

function claimOwnerDefinitelyStale(record: RecoveryClaimRecord): boolean {
  // Without a birth identity, a dead PID can be reused before the claim is
  // removed. Refuse to reclaim that claim rather than guessing.
  if (!record.startKey) return false;
  if (!isPidAlive(record.pid)) return true;
  const live = processStartKey(record.pid);
  return live !== undefined && live !== record.startKey;
}

function readRecoveryClaimSnapshot(path: string): RecoveryClaimSnapshot | null {
  try {
    const st = lstatSync(path);
    let record: RecoveryClaimRecord | null = null;
    try {
      record = parseRecoveryClaim(readFileSync(path, "utf8"));
    } catch {
      record = null;
    }
    return { ino: Number(st.ino), dev: Number(st.dev), record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseRecoveryClaim(raw: string): RecoveryClaimRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    const pid = Number(value.pid);
    const token = value.token;
    const lockIno = Number(value.lockIno);
    const lockDev = Number(value.lockDev);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof token !== "string" ||
      token.length === 0 ||
      !Number.isInteger(lockIno) ||
      lockIno < 0 ||
      !Number.isInteger(lockDev) ||
      lockDev < 0
    ) {
      return null;
    }
    const startKey = value.startKey;
    return {
      pid,
      token,
      startKey: typeof startKey === "string" && startKey.length > 0 ? startKey : undefined,
      lockIno,
      lockDev,
    };
  } catch {
    return null;
  }
}

function claimStillOwned(claim: RecoveryClaim): boolean {
  const snapshot = readRecoveryClaimSnapshot(claim.path);
  return Boolean(
    snapshot &&
      snapshot.ino === claim.ino &&
      snapshot.dev === claim.dev &&
      snapshot.record?.pid === process.pid &&
      snapshot.record.token === claim.token,
  );
}

function recoveryClaimStillOwned(fd: number): boolean {
  const claim = claimByFd.get(fd);
  return claim === undefined || claimStillOwned(claim);
}

function releaseRecoveryClaim(claim: RecoveryClaim): void {
  const moved = uniqueTempPath(`${claim.path}.release`);
  try {
    renameSync(claim.path, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  const current = readRecoveryClaimSnapshot(moved);
  if (
    current?.ino === claim.ino &&
    current.dev === claim.dev &&
    current.record?.pid === process.pid &&
    current.record.token === claim.token
  ) {
    unlinkQuiet(moved);
    return;
  }
  restoreRecoveryClaim(moved, claim.path);
}

function restoreRecoveryClaim(source: string, destination: string): void {
  try {
    linkSync(source, destination);
  } catch (error) {
    // EEXIST means another owner has already published a claim. Keep the
    // private source in place rather than deleting either owner's inode.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    return;
  }
  unlinkQuiet(source);
}

function readFdUtf8(fd: number): string {
  const st = fstatSync(fd);
  if (st.size === 0) return "";
  const buf = Buffer.alloc(st.size);
  readSync(fd, buf, 0, st.size, 0);
  return buf.toString("utf8");
}

function restoreLockBytes(fd: number, previous: Buffer): void {
  writeSync(fd, previous, 0, previous.length, 0);
  ftruncateSync(fd, previous.length);
}

function closeHeldFd(lockPath: string): void {
  const fd = heldFds.get(lockPath);
  if (fd === undefined) return;
  heldFds.delete(lockPath);
  closeFd(fd);
}

function closeFd(fd: number): void {
  const claim = claimByFd.get(fd);
  claimByFd.delete(fd);
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
  if (claim) releaseRecoveryClaim(claim);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function exlockSupported(): boolean {
  return exclusiveFlags(false) !== undefined;
}

function exclusiveFlags(nonblock: boolean): number | undefined {
  const c = constants as typeof constants & { O_EXLOCK?: number; O_NONBLOCK?: number };
  const exlock = typeof c.O_EXLOCK === "number" ? c.O_EXLOCK : bsdOExlock();
  if (exlock === undefined) return undefined;
  const nonblockFlag = typeof c.O_NONBLOCK === "number" ? c.O_NONBLOCK : 0;
  return constants.O_RDONLY | exlock | (nonblock ? nonblockFlag : 0);
}

function bsdOExlock(): number | undefined {
  // Node does not always export O_EXLOCK; Darwin/BSD open(2) uses 0x0020.
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return 0x0020;
  }
  return undefined;
}

function openExclusive(path: string, nonblock: boolean): number {
  const flags = exclusiveFlags(nonblock);
  if (flags === undefined) return openSync(path, "r");
  return openSync(path, flags);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detached-start handoff gate: the launcher waits until the spawned child has
 * adopted the lock (record rewritten to the child pid with a rotated token)
 * before releasing its own hold. Removes the release/acquire gap in which a
 * concurrent stop or second start could observe an unlocked, mid-start home.
 */
export async function waitForLockAdopted(
  lockPath: string,
  parentToken: string,
  childPid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = peekLockRecord(lockPath);
    if (!rec) {
      // A vanished record is an externally corrupted handoff, never an
      // adoption. Fail closed: keep waiting only until the child dies or the
      // deadline expires; a live child alone is not success.
      if (!isPidAlive(childPid)) {
        throw new Error("lock handoff failed: lock disappeared and child is dead");
      }
      await sleep(20);
      continue;
    }
    if (rec.pid === childPid && rec.token && rec.token !== parentToken) return;
    if (!isPidAlive(childPid)) {
      throw new Error("lock handoff failed: child exited before adopting the lock");
    }
    await sleep(20);
  }
  throw new Error("lock handoff was not adopted by the child process");
}

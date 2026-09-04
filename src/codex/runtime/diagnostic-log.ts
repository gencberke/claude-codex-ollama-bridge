import { fstatSync, ftruncateSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { GatewayDiagnosticEventV1, GatewayDiagnosticSink } from "../diagnostic-event.js";
import { closePrivateLogFd, openPrivateLogFd } from "./log-fd.js";

/** The diagnostic sidecar is deliberately small and bounded. */
export const DIAGNOSTIC_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const DIAGNOSTIC_LOG_MAX_LINE_BYTES = 16 * 1024;

export type DiagnosticLogFailureCode = "open_failed" | "rotation_failed" | "write_failed";

export type DiagnosticLogSnapshot = {
  state: "active" | "degraded" | "failed";
  fd_open: boolean;
  dropped_event_count: number;
  oversize_drop_count: number;
  write_failure_count: number;
  rotation_count: number;
  discarded_backup_count: number;
  last_failure_code?: DiagnosticLogFailureCode;
};

/**
 * Best-effort synchronous JSONL sink. It is only constructed for explicit
 * diagnostic mode; failures are dropped and never affect request handling.
 */
export class DiagnosticLog implements GatewayDiagnosticSink {
  private fd: number | undefined;
  private failed = false;
  private droppedEventCount = 0;
  private oversizeDropCount = 0;
  private writeFailureCount = 0;
  private rotationCount = 0;
  private discardedBackupCount = 0;
  private lastFailureCode: DiagnosticLogFailureCode | undefined;

  constructor(private readonly path: string) {
    this.open();
  }

  write(event: GatewayDiagnosticEventV1): void {
    if (this.failed) {
      this.droppedEventCount += 1;
      return;
    }
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (line.length > DIAGNOSTIC_LOG_MAX_LINE_BYTES) {
      this.droppedEventCount += 1;
      this.oversizeDropCount += 1;
      return;
    }
    try {
      if (this.fd === undefined) this.open();
      if (this.fd === undefined) {
        this.droppedEventCount += 1;
        return;
      }
      if (fstatSync(this.fd).size + line.length > DIAGNOSTIC_LOG_MAX_BYTES) {
        this.rotate();
      }
      if (this.fd === undefined) {
        this.droppedEventCount += 1;
        return;
      }
      let remaining = line;
      while (remaining.length > 0) {
        const written = writeSync(this.fd, remaining);
        if (written <= 0) throw new Error("diagnostic write made no progress");
        remaining = remaining.subarray(written);
      }
    } catch {
      this.droppedEventCount += 1;
      this.fail("write_failed");
    }
  }

  snapshot(): DiagnosticLogSnapshot {
    const degraded = this.droppedEventCount > 0 || this.discardedBackupCount > 0;
    return {
      state: this.failed ? "failed" : degraded ? "degraded" : "active",
      fd_open: this.fd !== undefined,
      dropped_event_count: this.droppedEventCount,
      oversize_drop_count: this.oversizeDropCount,
      write_failure_count: this.writeFailureCount,
      rotation_count: this.rotationCount,
      discarded_backup_count: this.discardedBackupCount,
      ...(this.lastFailureCode === undefined ? {} : { last_failure_code: this.lastFailureCode }),
    };
  }

  close(): void {
    if (this.fd === undefined) return;
    closePrivateLogFd(this.fd);
    this.fd = undefined;
  }

  private open(): void {
    if (this.failed || this.fd !== undefined) return;
    try {
      this.fd = openPrivateLogFd(this.path);
      if (fstatSync(this.fd).size > DIAGNOSTIC_LOG_MAX_BYTES) {
        this.rotate();
      }
    } catch {
      this.fail("open_failed");
    }
  }

  private rotate(): void {
    this.close();
    try {
      unlinkSync(`${this.path}.1`);
      this.discardedBackupCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.fail("rotation_failed");
        return;
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
      const backupFd = openPrivateLogFd(`${this.path}.1`);
      try {
        if (fstatSync(backupFd).size > DIAGNOSTIC_LOG_MAX_BYTES) {
          ftruncateSync(backupFd, DIAGNOSTIC_LOG_MAX_BYTES);
        }
      } finally {
        closePrivateLogFd(backupFd);
      }
      this.fd = openPrivateLogFd(this.path);
      this.rotationCount += 1;
    } catch {
      this.fail("rotation_failed");
    }
  }

  private fail(code: DiagnosticLogFailureCode): void {
    this.failed = true;
    this.writeFailureCount += 1;
    this.lastFailureCode = code;
    this.close();
  }
}

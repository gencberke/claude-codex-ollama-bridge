import { fstatSync, ftruncateSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { GatewayDiagnosticEventV1, GatewayDiagnosticSink } from "../diagnostic-event.js";
import { closePrivateLogFd, openPrivateLogFd } from "./log-fd.js";

/** The diagnostic sidecar is deliberately small and bounded. */
export const DIAGNOSTIC_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const DIAGNOSTIC_LOG_MAX_LINE_BYTES = 16 * 1024;

/**
 * Best-effort synchronous JSONL sink. It is only constructed for explicit
 * diagnostic mode; failures are dropped and never affect request handling.
 */
export class DiagnosticLog implements GatewayDiagnosticSink {
  private fd: number | undefined;
  private failed = false;

  constructor(private readonly path: string) {
    this.open();
  }

  write(event: GatewayDiagnosticEventV1): void {
    if (this.failed) return;
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (line.length > DIAGNOSTIC_LOG_MAX_LINE_BYTES) return;
    try {
      if (this.fd === undefined) this.open();
      if (this.fd === undefined) return;
      if (fstatSync(this.fd).size + line.length > DIAGNOSTIC_LOG_MAX_BYTES) {
        this.rotate();
      }
      if (this.fd !== undefined) writeSync(this.fd, line);
    } catch {
      this.failed = true;
      this.close();
    }
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
      this.failed = true;
      this.close();
    }
  }

  private rotate(): void {
    this.close();
    try {
      unlinkSync(`${this.path}.1`);
    } catch {
      // The backup is optional and may not exist yet.
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
    } catch {
      this.failed = true;
      this.close();
    }
  }
}

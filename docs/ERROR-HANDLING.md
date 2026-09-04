# Error handling and diagnostics contract

This document is the authority for cob Codex error output and diagnostic
observability. It applies at the gateway boundary: HTTP/SSE responses, the
human gateway log, and the opt-in diagnostic sidecar. It does not require
every internal invariant or startup failure to use one universal `Error`
subclass.

## Boundary rules

1. Classify errors where they leave cob, not by mechanically replacing every
   internal `throw`.
2. A cob-owned client error has a stable lowercase identifier made only of
   ASCII letters, digits, and underscores. Diagnostic codes are bounded to
   128 characters.
3. Client messages are fixed cob-owned text or pass through an explicit,
   bounded sanitizer. Never relay an exception message, raw provider body,
   filesystem path, credential, prompt, output, tool name, tool arguments, or
   identifier as a cob-owned message.
4. JSON errors use `{ "error": { "type", "code", "message" } }`.
   `type` is `invalid_request_error` below 500 and `server_error` at 500 or
   above. Optional details must be bounded and explicitly allowlisted.
5. Once SSE headers are sent, a cob-owned failure uses a Responses
   `response.failed` terminal with the same stable code the equivalent JSON
   path would use. It must not append a success terminal.
6. Native ChatGPT responses remain provider passthrough. Their bodies are not
   copied into cob logs or diagnostics; a native non-success is recorded only
   as the structural `native_upstream_error` classification.

The shared JSON writer, SSE terminal writer, and request outcome marker are
the enforcement points. New public error paths must use those boundaries
instead of assembling a response ad hoc.

## Request outcome vocabulary

`request_end.terminal` is a closed vocabulary exported by
`diagnostic-event.ts` and shared with the sidecar reader:

| Terminal | Meaning |
| --- | --- |
| `completed` | cob observed the route's complete success authority |
| `client_abort` | the client disconnected or cancelled |
| `checkpoint_error` | checkpoint resolution failed before dispatch |
| `checkpoint_failed` | a completed response could not be published |
| `empty` | upstream ended without a body |
| `eof` | upstream ended without the required terminal |
| `error` | the stream transport failed before a more specific classification |
| `guard_rejection` | a response violated a declared tool/dialect guard |
| `http_error` | a non-success HTTP response was returned |
| `idle` | the bounded idle timeout fired |
| `invalid_json` | a JSON response could not be parsed |
| `invalid_response` | parsed data did not satisfy the response contract |
| `non_success` | Ollama supplied one valid non-success terminal |
| `overflow` | a configured body, frame, or traversal limit was exceeded |
| `stream_error` | cob emitted or recorded a failed stream terminal |

Every completed request must record a terminal. Failed requests must also
record `error_code` when cob owns or can safely classify the failure. An
Ollama `non_success` additionally records exactly one
`non_success_kind`: `failed`, `incomplete`, or `error`.

## Three output surfaces

The client receives the stable code and safe recovery-oriented message. With
diagnostic/dev mode enabled, the human log receives a content-free failed
`request_end` record with the code, and the sidecar receives the request
terminal, code, timings, and bounded structural fields. No enabled diagnostic
surface is allowed to become the only place that preserves the failure's
identity.

The default human log remains unchanged for successful requests. In explicit
diagnostic/dev mode, failed `request_end` events are emitted as JSON as well
as persisted so an operator can correlate a client failure without reading a
provider body.

## Dev-mode continuity

`COB_DEV_MODE=1` implies the mode-0600 JSONL sidecar and adds thread and
process observations. Each process generates one random, content-free
`run_sha8`; request pairs use `run_sha8 + pid + request_seq + request_fp8`, so
sequence reuse after a restart cannot merge two runs. Compaction events carry
the parent request's `run_sha8` and `request_seq`.

The sink is best effort and never fails a request, starts a worker, retries a
provider call, or owns a queue. Its health snapshot makes loss observable:

- `dropped_event_count` and `oversize_drop_count` expose dropped writes;
- `write_failure_count` and `last_failure_code` expose sink shutdown;
- `rotation_count` and `discarded_backup_count` expose bounded-history loss.

The storage bound remains one 4 MiB active file plus one 4 MiB backup, with a
16 KiB event limit. Rotation is a bound, not durable audit retention.

Use `cob status [--json]` for the running sink's in-memory health. Use
`cob diagnostics [--json]` for a read-only structural summary of the backup
and active files. The reader refuses symlinks, non-private files, non-regular
files, and files above the writer's bound; it never prints event bodies.

## Change checklist

For every new client-visible failure:

1. choose one stable code and safe fixed message;
2. preserve the code across JSON and SSE transports;
3. set the request terminal and diagnostic code;
4. add the smallest regression test proving no raw detail is exposed;
5. update this contract only when the vocabulary or boundary rule changes.

Logging remains diagnostic-only. Exact usage is recorded only from upstream
evidence, and controller retry/no-progress counters remain controller-owned.

# Upstream U1 — portable Multi-Agent V2 driver

Workspace proposal for [openai/codex](https://github.com/openai/codex). Not packed.
Not a cob product change. Do not implement this inside cob.

Checked 2026-08-25 against PATH Codex **0.149.0**
`codex app-server generate-json-schema --experimental` and current
`codex-rs/app-server-protocol` `ClientRequest` on `main`. Neither exposes
`agentControl/*`. Nearby methods exist and are the wrong layer.

## Why cob cannot close Gate 6

Gate 6 gold is one child and this exact order, with the parent model **not**
choosing when to wait:

```
spawn → send_message × 2 (same child, in flight) → wait
→ followup_task → wait → followup_task → wait
```

Isolated `npm run gate6h` on cob 0.1.13 / Codex 0.149 prompted `gpt-5.6-sol`
to issue those collaboration tools. Sol waited after the first
`send_message`. The second send was never produced. The harness records
`controller_sequencing_observed` + `transport_unmeasured`. That does not
measure cob transport and does not authorize a cob-owned queue.

Ollama children stay catalog `multi_agent_version = v1`. Fernet / `ocx1` /
ChatGPT envelopes must not go to Ollama. cob already has an isolated,
default-off plaintext alias for a fingerprinted native `collaboration.*`
schema. That alias is not a scheduler.

## Existing surfaces that are not this driver

| Surface | Why it is the wrong layer |
| --- | --- |
| Parent-model `collaboration.spawn_agent` / `send_message` / `followup_task` | Model-scheduled. Gate 6-H showed Sol will `wait_agent` or `list_agents` before send2. |
| `turn/start` / `turn/steer` on a V2 child | Rejected by design ([openai/codex#27173](https://github.com/openai/codex/issues/27173)). `canAcceptDirectInput` is false for parent-owned V2 thread-spawn children. |
| `thread/queue/*` | FIFO **user** turns on one thread. Not `send_message` (queue without a turn) vs `followup_task` (assign and start a turn). |
| `thread/inject_items` | History injection. Does not live-dispatch a child. |
| `collabToolCall` items | Observe model-initiated collab tools. Clients must not execute them. |
| `collaborationMode/list` | Preset list. Not AgentControl. |
| `codex exec-server` | Remote environment, not a collaboration runtime. |
| Internal `AgentControl::send_input` | Exists in `codex-rs/core` and is **not** an app-server `ClientRequest`. |

A later TUI request to allow user corrections on a selected child
([openai/codex#33885](https://github.com/openai/codex/issues/33885)) is still
parent-thread user input, not the two-send-then-wait mailbox protocol.

## Proposed app-server methods

Expose the **same** Multi-Agent V2 handlers the parent already uses, as
experimental JSON-RPC, without a model turn in between. Names are illustrative;
keep the native tool argument shapes.

| Method | Existing handler | Params (minimum) | Effect |
| --- | --- | --- | --- |
| `agentControl/spawn` | `spawn_agent` | `parentThreadId`, `message`, optional `model` / `taskName` | Create one child; return `{ threadId, agentPath }` |
| `agentControl/sendMessage` | `send_message` | `parentThreadId`, `target`, `message` | Queue mailbox input; **must not** start a child turn |
| `agentControl/followupTask` | `followup_task` | `parentThreadId`, `target`, `message` | Assign work and start or resume the child turn |
| `agentControl/wait` | `wait_agent` | `parentThreadId`, optional `target` | Block the caller until the child mailbox/final state the tool already defines |
| `agentControl/list` | `list_agents` | `parentThreadId` | Return the current tree; read-only |

Optional later: `agentControl/interrupt` wrapping the existing
`interrupt_agent` leaf. Restart/replay/worktree stay out of this RFC.

### Invariants

1. **One scheduler.** These methods must call `AgentControl` in-process. Do
   not add a second queue in app-server, Desktop, or a loopback proxy.
2. **Native identities.** Spawn/send/follow-up outputs keep the same
   `thread_id` / agent path / `source_call_id` join key the tools already
   stamp ([openai/codex#28561](https://github.com/openai/codex/pull/28561)).
3. **`send_message` vs `followup_task`.** Two in-flight sends then one wait
   must be legal. `send_message` must not implicitly `wait` or start a turn.
4. **No child `turn/start`.** Clients still must not steer V2 children as
   ordinary user threads. The parent thread remains the owner.
5. **Fail closed.** Unknown `target`, missing parent, or a changed V2
   argument schema returns an invalid-request error. Do not invent plaintext
   aliases at this layer.
6. **Experimental capability.** Gate behind `experimentalApi` (or a dedicated
   flag). Default clients unchanged.

### Gate 6 script (Codex-side, not cob)

```
thread/start (parent, native GPT)
agentControl/spawn (ollama child model allowed by the parent catalog)
agentControl/sendMessage (send1)
agentControl/sendMessage (send2)   // must succeed before any wait
agentControl/wait
agentControl/followupTask (follow1)
agentControl/wait
agentControl/followupTask (follow2)
agentControl/wait
```

Child traces must show spawn → send1 → send2 → follow1 → follow2 with
fixture nonces intact. If send2 is rejected, the transport is measured and
the error is Codex's, not a missing client method.

## Out of scope for cob

- cob-owned message queue or transport scheduler
- Advertising `multi_agent_version` other than `v1` on Ollama catalog rows
- `nativeAlias`, OpenCodex `ocx1`, or Fernet to Ollama
- Writing `~/.codex/config.toml`
- Packing or enabling isolated plaintext spawn on live `:18790`
- Nested child `collaboration.spawn_agent` (Gate 10) until Codex gives the
  child that tool
- Distinct worktree spawn (Gate 7)

After this lands in a Codex build cob can consume, re-run isolated Gate 6-H
on `:18791` against the driver instead of prompting Sol. Until then Gate 6
stays `transport_unmeasured`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GATE6H_CHILD_ID,
  GATE6H_FIXTURE,
  extractParentEvent,
  initialGate6hState,
  reduceGate6hJsonl,
  type Gate6hState,
} from "./gate6h.js";

const TURN = "turn-gate6h";
const f = GATE6H_FIXTURE;

function parentLine(payload: unknown): string {
  return JSON.stringify({
    timestamp: "2026-08-24T19:00:00.000Z",
    type: "response_item",
    payload,
  });
}

function spawnSeq(state: Gate6hState = initialGate6hState()): Gate6hState {
  let next = reduceGate6hJsonl(
    state,
    parentLine({
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    }),
    "parent",
  );
  return reduceGate6hJsonl(
    next,
    parentLine({
      type: "function_call_output",
      output: JSON.stringify({ task_name: GATE6H_CHILD_ID }),
    }),
    "parent",
  );
}

function send(state: Gate6hState, n: 1 | 2, turnId = TURN): Gate6hState {
  const message =
    n === 1
      ? `SEND1_NONCE: ${f.send1Nonce}\nSEND1_UNICODE: ${f.send1Unicode}`
      : `SEND2_NONCE: ${f.send2Nonce}\nSEND2_UNICODE: ${f.send2Unicode}`;
  return reduceGate6hJsonl(
    state,
    parentLine({
      type: "function_call",
      name: "send_message",
      namespace: "collaboration",
      arguments: JSON.stringify({ target: GATE6H_CHILD_ID, message }),
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    "parent",
  );
}

function follow(state: Gate6hState, n: 1 | 2): Gate6hState {
  const message =
    n === 1
      ? `FOLLOW1_NONCE: ${f.follow1Nonce}\nFOLLOW1_UNICODE: ${f.follow1Unicode}`
      : `FOLLOW2_NONCE: ${f.follow2Nonce}\nFOLLOW2_UNICODE: ${f.follow2Unicode}`;
  return reduceGate6hJsonl(
    state,
    parentLine({
      type: "function_call",
      name: "followup_task",
      namespace: "collaboration",
      arguments: JSON.stringify({ target: GATE6H_CHILD_ID, message }),
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    }),
    "parent",
  );
}

function wait(state: Gate6hState): Gate6hState {
  return reduceGate6hJsonl(
    state,
    parentLine({ type: "function_call", name: "wait_agent", namespace: "collaboration", arguments: "{}" }),
    "parent",
  );
}

function childLine(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "agent_message",
      content: [{ type: "input_text", text }],
    },
  });
}

describe("Gate 6-H controller sequencing", () => {
  it("fails immediately when wait_agent appears before the second send", () => {
    let state = spawnSeq();
    state = send(state, 1);
    state = reduceGate6hJsonl(
      state,
      parentLine({ type: "function_call", name: "wait_agent", namespace: "collaboration", arguments: "{}" }),
      "parent",
    );
    assert.equal(state.verdict, "controller_sequencing_fail");
    assert.match(state.reason, /wait_agent before the second send_message/);
    assert.equal(state.sendCount, 1);
  });

  it("fails list_agents, parent final, and followup before send2", () => {
    const listed = reduceGate6hJsonl(
      send(spawnSeq(), 1),
      parentLine({ type: "function_call", name: "list_agents", namespace: "collaboration", arguments: "{}" }),
      "parent",
    );
    assert.equal(listed.verdict, "controller_sequencing_fail");
    const finalized = reduceGate6hJsonl(
      send(spawnSeq(), 1),
      parentLine({
        type: "message",
        role: "assistant",
        phase: "final",
        content: [{ type: "output_text", text: "done" }],
      }),
      "parent",
    );
    assert.equal(finalized.verdict, "controller_sequencing_fail");
    const followed = follow(send(spawnSeq(), 1), 1);
    assert.equal(followed.verdict, "controller_sequencing_fail");
  });

  it("allows wait_agent only after both same-turn sends", () => {
    let state = send(send(spawnSeq(), 1), 2);
    assert.equal(state.verdict, "running");
    assert.equal(state.sendCount, 2);
    state = wait(state);
    assert.equal(state.verdict, "running");
    assert.equal(state.waitCount, 1);
  });

  it("rejects a second send in a different assistant turn", () => {
    const state = send(send(spawnSeq(), 1), 2, "other-turn");
    assert.equal(state.verdict, "controller_sequencing_fail");
    assert.match(state.reason, /same assistant turn/);
  });

  it("rejects a second spawn", () => {
    const state = reduceGate6hJsonl(
      spawnSeq(),
      parentLine({ type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{}" }),
      "parent",
    );
    assert.equal(state.verdict, "second_spawn");
  });

  it("rejects send_message after the child already completed", () => {
    let state = send(spawnSeq(), 1);
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: FINAL_ANSWER\n${f.send1Nonce}`),
      "child",
    );
    assert.equal(state.verdict, "controller_sequencing_fail");
  });
});

describe("Gate 6-H transport gold", () => {
  it("passes when one child receives two MESSAGE sends then two follow-up NEW_TASKs", () => {
    let state = wait(send(send(spawnSeq(), 1), 2));
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: NEW_TASK\nFIRST_NONCE: ${f.spawnNonce}\nFIRST_UNICODE: ${f.spawnUnicode}`),
      "child",
    );
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: MESSAGE\nSEND1_NONCE: ${f.send1Nonce}\nSEND1_UNICODE: ${f.send1Unicode}`),
      "child",
    );
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: MESSAGE\nSEND2_NONCE: ${f.send2Nonce}\nSEND2_UNICODE: ${f.send2Unicode}`),
      "child",
    );
    state = reduceGate6hJsonl(
      state,
      childLine("Message Type: FINAL_ANSWER\nboth sends"),
      "child",
    );
    state = follow(state, 1);
    state = wait(state);
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: NEW_TASK\nFOLLOW1_NONCE: ${f.follow1Nonce}\nFOLLOW1_UNICODE: ${f.follow1Unicode}`),
      "child",
    );
    state = reduceGate6hJsonl(
      state,
      childLine("Message Type: FINAL_ANSWER\nfollow1"),
      "child",
    );
    state = follow(state, 2);
    state = wait(state);
    state = reduceGate6hJsonl(
      state,
      childLine(`Message Type: NEW_TASK\nFOLLOW2_NONCE: ${f.follow2Nonce}\nFOLLOW2_UNICODE: ${f.follow2Unicode}`),
      "child",
    );
    state = reduceGate6hJsonl(
      state,
      childLine("Message Type: FINAL_ANSWER\nfollow2"),
      "child",
    );
    assert.equal(state.verdict, "pass");
    assert.equal(state.childId, GATE6H_CHILD_ID);
    assert.deepEqual(state.seenNonces, [
      f.spawnNonce,
      f.send1Nonce,
      f.send2Nonce,
      f.follow1Nonce,
      f.follow2Nonce,
    ]);
  });

  it("does not count parent payload nonces as child evidence", () => {
    const state = send(send(spawnSeq(), 1), 2);
    assert.equal(state.verdict, "running");
    assert.deepEqual(state.seenNonces, []);
  });

  it("rejects a task-name target once the canonical child id is known", () => {
    const state = send(spawnSeq(), 1);
    const drifted = reduceGate6hJsonl(
      state,
      parentLine({
        type: "function_call",
        name: "send_message",
        namespace: "collaboration",
        arguments: JSON.stringify({
          target: "gate6h_queue",
          message: `SEND2_NONCE: ${f.send2Nonce}\nSEND2_UNICODE: ${f.send2Unicode}`,
        }),
        internal_chat_message_metadata_passthrough: { turn_id: TURN },
      }),
      "parent",
    );
    assert.equal(drifted.verdict, "wrong_child");
  });

  it("parses real collaboration send_message jsonl into a send event", () => {
    const event = extractParentEvent(
      parentLine({
        type: "function_call",
        name: "send_message",
        namespace: "collaboration",
        arguments: `{"message":"SEND1_NONCE: ${f.send1Nonce}\\nSEND1_UNICODE: ${f.send1Unicode}","target":"${GATE6H_CHILD_ID}"}`,
        internal_chat_message_metadata_passthrough: { turn_id: TURN },
      }),
    );
    assert.equal(event?.kind, "send_message");
    if (event?.kind === "send_message") {
      assert.equal(event.target, GATE6H_CHILD_ID);
      assert.match(event.message, new RegExp(f.send1Nonce));
    }
  });

  it("does not treat commentary as a parent final", () => {
    const event = extractParentEvent(
      parentLine({
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "starting" }],
      }),
    );
    assert.equal(event, undefined);
  });
});

describe("Gate 6-H replay of the Gate 6 Sol wait", () => {
  it("classifies spawn + send1 + wait as controller_sequencing_fail", () => {
    const lines = [
      parentLine({
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: "{}",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      }),
      parentLine({
        type: "function_call_output",
        output: '{"task_name":"/root/gate6h_queue"}',
      }),
      parentLine({
        type: "function_call",
        name: "send_message",
        namespace: "collaboration",
        arguments: JSON.stringify({
          target: "/root/gate6h_queue",
          message: `SEND1_NONCE: ${f.send1Nonce}\nSEND1_UNICODE: ${f.send1Unicode}`,
        }),
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      }),
      parentLine({
        type: "function_call",
        name: "wait_agent",
        namespace: "collaboration",
        arguments: '{"timeout_ms":10000}',
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      }),
    ];
    let state = initialGate6hState();
    for (const line of lines) state = reduceGate6hJsonl(state, line, "parent");
    assert.equal(state.verdict, "controller_sequencing_fail");
  });
});

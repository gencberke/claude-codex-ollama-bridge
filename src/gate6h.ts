/**
 * Gate 6-H: isolate Sol controller sequencing from cob transport.
 * Workspace canary only. Not packed. Does not add a cob message queue.
 */

export const GATE6H_TASK_NAME = "gate6h_queue";
export const GATE6H_CHILD_ID = `/root/${GATE6H_TASK_NAME}`;
export const GATE6H_PARENT_MODEL = "gpt-5.6-sol";
export const GATE6H_CHILD_MODEL = "ollama/deepseek-v4-flash:0731-cloud";
export const GATE6H_SLEEP_SECONDS = 30;
export const GATE6H_MAX_ATTEMPTS = 3;
export const GATE6H_TRANSPORT_UNMEASURED = "transport_unmeasured" as const;
export const GATE6H_CONTROLLER_SEQUENCING_OBSERVED = "controller_sequencing_observed" as const;

export const GATE6H_FIXTURE = {
  spawnNonce: "COB_GATE6H_SPAWN_20260824_Q1W2",
  spawnUnicode: "kuyruk — çığ İğüş 😀",
  send1Nonce: "COB_GATE6H_SEND1_20260824_E3R4",
  send1Unicode: "birinci kuyruk — ğüşi 😀",
  send2Nonce: "COB_GATE6H_SEND2_20260824_T5Y6",
  send2Unicode: "ikinci kuyruk — Çığ 😀",
  follow1Nonce: "COB_GATE6H_FOLLOW1_20260824_U7I8",
  follow1Unicode: "birinci uyandır — İğüş 😀",
  follow2Nonce: "COB_GATE6H_FOLLOW2_20260824_O9P0",
  follow2Unicode: "ikinci uyandır — çığ 😀",
} as const;

export type Gate6hVerdict =
  | "running"
  | "pass"
  | "controller_sequencing_fail"
  | "second_spawn"
  | "wrong_child"
  | "send_after_completion"
  | "duplicate_delivery"
  | "lost_message"
  | "nonce_mismatch"
  | "timeout"
  | "attempt_timeout"
  | "process_exit_before_trace";

export type Gate6hEvent =
  | { kind: "spawn_agent"; turnId?: string }
  | { kind: "spawn_output"; childId: string }
  | { kind: "send_message"; turnId?: string; target: string; message: string }
  | { kind: "followup_task"; turnId?: string; target: string; message: string }
  | { kind: "wait_agent"; turnId?: string }
  | { kind: "list_agents"; turnId?: string }
  | { kind: "interrupt_agent"; turnId?: string }
  | { kind: "parent_final"; turnId?: string }
  | { kind: "parent_exec" }
  | {
      kind: "child_agent_message";
      messageType: "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER" | "OTHER";
      text: string;
    };

export type Gate6hState = {
  verdict: Gate6hVerdict;
  reason: string;
  childId: string | undefined;
  spawnCount: number;
  sendCount: number;
  followupCount: number;
  sendTurnId: string | undefined;
  waitCount: number;
  completedCount: number;
  childCompleted: boolean;
  childMessageTypes: string[];
  seenNonces: string[];
};

const TERMINAL: ReadonlySet<Gate6hVerdict> = new Set([
  "pass",
  "controller_sequencing_fail",
  "second_spawn",
  "wrong_child",
  "send_after_completion",
  "duplicate_delivery",
  "lost_message",
  "nonce_mismatch",
  "timeout",
  "attempt_timeout",
  "process_exit_before_trace",
]);

export function initialGate6hState(): Gate6hState {
  return {
    verdict: "running",
    reason: "",
    childId: undefined,
    spawnCount: 0,
    sendCount: 0,
    followupCount: 0,
    sendTurnId: undefined,
    waitCount: 0,
    completedCount: 0,
    childCompleted: false,
    childMessageTypes: [],
    seenNonces: [],
  };
}

export function isTerminalGate6h(state: Gate6hState): boolean {
  return TERMINAL.has(state.verdict);
}

function fail(state: Gate6hState, verdict: Gate6hVerdict, reason: string): Gate6hState {
  if (state.verdict !== "running") return state;
  return { ...state, verdict, reason };
}

function recordNonce(state: Gate6hState, text: string): string[] {
  const found: string[] = [];
  for (const nonce of [
    GATE6H_FIXTURE.spawnNonce,
    GATE6H_FIXTURE.send1Nonce,
    GATE6H_FIXTURE.send2Nonce,
    GATE6H_FIXTURE.follow1Nonce,
    GATE6H_FIXTURE.follow2Nonce,
  ]) {
    if (text.includes(nonce) && !state.seenNonces.includes(nonce) && !found.includes(nonce)) {
      found.push(nonce);
    }
  }
  return [...state.seenNonces, ...found];
}

function sameChild(state: Gate6hState, target: string): boolean {
  return Boolean(state.childId) && target === state.childId;
}

export function reduceGate6h(state: Gate6hState, event: Gate6hEvent): Gate6hState {
  if (state.verdict !== "running") return state;

  switch (event.kind) {
    case "spawn_agent": {
      if (state.spawnCount >= 1) return fail(state, "second_spawn", "second spawn_agent before Gate 6-H completed");
      return { ...state, spawnCount: state.spawnCount + 1 };
    }
    case "spawn_output": {
      if (state.spawnCount !== 1) return fail(state, "controller_sequencing_fail", "spawn output without a single spawn_agent");
      if (state.childId && state.childId !== event.childId) {
        return fail(state, "wrong_child", "spawn output child id changed");
      }
      return { ...state, childId: event.childId };
    }
    case "send_message": {
      if (state.spawnCount !== 1 || !state.childId) {
        return fail(state, "controller_sequencing_fail", "send_message before spawn returned");
      }
      if (!sameChild(state, event.target)) {
        return fail(state, "wrong_child", `send_message target ${event.target} is not ${state.childId}`);
      }
      if (state.childCompleted) {
        return fail(state, "send_after_completion", "send_message after the child already completed");
      }
      if (state.sendCount >= 2) {
        return fail(state, "duplicate_delivery", "more than two send_message calls");
      }
      if (state.sendCount === 1 && state.sendTurnId && event.turnId && event.turnId !== state.sendTurnId) {
        return fail(state, "controller_sequencing_fail", "second send_message was not in the same assistant turn");
      }
      const expectedNonce = state.sendCount === 0 ? GATE6H_FIXTURE.send1Nonce : GATE6H_FIXTURE.send2Nonce;
      const expectedUnicode = state.sendCount === 0 ? GATE6H_FIXTURE.send1Unicode : GATE6H_FIXTURE.send2Unicode;
      if (!event.message.includes(expectedNonce) || !event.message.includes(expectedUnicode)) {
        return fail(state, "nonce_mismatch", `send ${state.sendCount + 1} payload missed fixture nonce or unicode`);
      }
      return {
        ...state,
        sendCount: state.sendCount + 1,
        sendTurnId: state.sendTurnId ?? event.turnId,
      };
    }
    case "wait_agent":
    case "list_agents":
    case "interrupt_agent":
    case "parent_final":
    case "parent_exec": {
      if (state.sendCount < 2) {
        return fail(
          state,
          "controller_sequencing_fail",
          `${event.kind} before the second send_message`,
        );
      }
      if (event.kind === "wait_agent") {
        return { ...state, waitCount: state.waitCount + 1 };
      }
      return state;
    }
    case "followup_task": {
      if (state.sendCount < 2) {
        return fail(state, "controller_sequencing_fail", "followup_task before both send_message calls");
      }
      if (state.waitCount < 1 || state.completedCount < 1) {
        return fail(state, "controller_sequencing_fail", "followup_task before wait and initial child completion");
      }
      if (state.followupCount === 1 && (state.waitCount < 2 || state.completedCount < 2)) {
        return fail(state, "controller_sequencing_fail", "second followup_task before wait and follow-up completion");
      }
      if (!sameChild(state, event.target)) {
        return fail(state, "wrong_child", `followup_task target ${event.target} is not ${state.childId}`);
      }
      if (state.followupCount >= 2) {
        return fail(state, "duplicate_delivery", "more than two followup_task calls");
      }
      const expectedNonce = state.followupCount === 0 ? GATE6H_FIXTURE.follow1Nonce : GATE6H_FIXTURE.follow2Nonce;
      const expectedUnicode = state.followupCount === 0 ? GATE6H_FIXTURE.follow1Unicode : GATE6H_FIXTURE.follow2Unicode;
      if (!event.message.includes(expectedNonce) || !event.message.includes(expectedUnicode)) {
        return fail(state, "nonce_mismatch", `followup ${state.followupCount + 1} payload missed fixture nonce or unicode`);
      }
      return {
        ...state,
        followupCount: state.followupCount + 1,
      };
    }
    case "child_agent_message": {
      const nextTypes = [...state.childMessageTypes, event.messageType];
      const seenNonces = recordNonce(state, event.text);
      let next = { ...state, childMessageTypes: nextTypes, seenNonces };
      if (event.messageType === "FINAL_ANSWER") {
        next = { ...next, childCompleted: true, completedCount: state.completedCount + 1 };
        if (state.sendCount < 2) {
          return fail(next, "controller_sequencing_fail", "child FINAL_ANSWER before the second send_message");
        }
      }
      if (event.messageType === "MESSAGE") {
        const messages = nextTypes.filter((type) => type === "MESSAGE").length;
        if (messages === 1 && (!event.text.includes(GATE6H_FIXTURE.send1Nonce) || !event.text.includes(GATE6H_FIXTURE.send1Unicode))) {
          return fail(next, "nonce_mismatch", "first child MESSAGE missed SEND1 nonce or unicode");
        }
        if (messages === 2 && (!event.text.includes(GATE6H_FIXTURE.send2Nonce) || !event.text.includes(GATE6H_FIXTURE.send2Unicode))) {
          return fail(next, "nonce_mismatch", "second child MESSAGE missed SEND2 nonce or unicode");
        }
        if (messages > 2) return fail(next, "duplicate_delivery", "more than two child MESSAGE rows");
      }
      if (event.messageType === "NEW_TASK") {
        const tasks = nextTypes.filter((type) => type === "NEW_TASK").length;
        if (tasks === 1 && (!event.text.includes(GATE6H_FIXTURE.spawnNonce) || !event.text.includes(GATE6H_FIXTURE.spawnUnicode))) {
          return fail(next, "nonce_mismatch", "spawn NEW_TASK missed fixture nonce or unicode");
        }
        if (tasks === 2 && (!event.text.includes(GATE6H_FIXTURE.follow1Nonce) || !event.text.includes(GATE6H_FIXTURE.follow1Unicode))) {
          return fail(next, "nonce_mismatch", "first follow-up NEW_TASK missed fixture nonce or unicode");
        }
        if (tasks === 3 && (!event.text.includes(GATE6H_FIXTURE.follow2Nonce) || !event.text.includes(GATE6H_FIXTURE.follow2Unicode))) {
          return fail(next, "nonce_mismatch", "second follow-up NEW_TASK missed fixture nonce or unicode");
        }
        if (tasks > 3) return fail(next, "duplicate_delivery", "unexpected extra child NEW_TASK");
      }
      return maybePass(next);
    }
    default:
      return state;
  }
}

function maybePass(state: Gate6hState): Gate6hState {
  if (state.verdict !== "running") return state;
  if (state.spawnCount !== 1 || !state.childId) return state;
  if (state.sendCount !== 2 || state.followupCount !== 2) return state;
  if (state.waitCount < 3 || state.completedCount < 3) return state;
  const messages = state.childMessageTypes.filter((type) => type === "MESSAGE");
  const tasks = state.childMessageTypes.filter((type) => type === "NEW_TASK");
  if (messages.length !== 2 || tasks.length !== 3) return state;
  const expected = [
    GATE6H_FIXTURE.spawnNonce,
    GATE6H_FIXTURE.send1Nonce,
    GATE6H_FIXTURE.send2Nonce,
    GATE6H_FIXTURE.follow1Nonce,
    GATE6H_FIXTURE.follow2Nonce,
  ];
  if (!expected.every((nonce) => state.seenNonces.includes(nonce))) {
    return fail(state, "lost_message", "child traces are missing a fixture nonce");
  }
  const messageOrder = state.childMessageTypes.filter(
    (type) => type === "NEW_TASK" || type === "MESSAGE" || type === "FINAL_ANSWER",
  );
  const firstFour = messageOrder.slice(0, 4);
  if (
    firstFour[0] !== "NEW_TASK" ||
    firstFour[1] !== "MESSAGE" ||
    firstFour[2] !== "MESSAGE" ||
    firstFour[3] !== "FINAL_ANSWER"
  ) {
    return fail(state, "lost_message", "child plaintext order was not spawn, two MESSAGE sends, then completion");
  }
  return { ...state, verdict: "pass", reason: "same child received two active sends and two idle follow-ups" };
}

export function reduceGate6hJsonl(state: Gate6hState, line: string, source: "parent" | "child"): Gate6hState {
  const event = source === "parent" ? extractParentEvent(line) : extractChildEvent(line);
  return event ? reduceGate6h(state, event) : state;
}

export function extractParentEvent(line: string): Gate6hEvent | undefined {
  const row = parseRow(line);
  if (!row) return undefined;
  const payload = isRecord(row.payload) ? row.payload : undefined;
  if (row.type === "response_item" && payload) {
    const turnId = turnIdOf(payload);
    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const args = typeof payload.arguments === "string" ? payload.arguments : "";
      if (name === "spawn_agent") return { kind: "spawn_agent", turnId };
      if (name === "send_message") {
        const parsed = parseArgObject(args);
        return {
          kind: "send_message",
          turnId,
          target: targetOf(parsed),
          message: messageOf(parsed),
        };
      }
      if (name === "followup_task") {
        const parsed = parseArgObject(args);
        return {
          kind: "followup_task",
          turnId,
          target: targetOf(parsed),
          message: messageOf(parsed),
        };
      }
      if (name === "wait_agent") return { kind: "wait_agent", turnId };
      if (name === "list_agents") return { kind: "list_agents", turnId };
      if (name === "interrupt_agent") return { kind: "interrupt_agent", turnId };
      if (name === "exec_command") return { kind: "parent_exec" };
    }
    if (payload.type === "function_call_output") {
      const output = payload.output;
      if (typeof output === "string") {
        const parsed = parseArgObject(output);
        const childId = typeof parsed.task_name === "string" ? parsed.task_name : "";
        if (childId.startsWith("/root/") || childId === GATE6H_TASK_NAME) {
          return { kind: "spawn_output", childId: childId.startsWith("/") ? childId : `/root/${childId}` };
        }
      }
    }
    if (payload.type === "message" && payload.role === "assistant" && payload.phase === "final") {
      return { kind: "parent_final", turnId };
    }
  }
  if (row.type === "event_msg" && payload?.type === "item_completed" && isRecord(payload.item)) {
    const item = payload.item;
    if (item.type === "AgentMessage" && item.phase === "final") {
      return { kind: "parent_final" };
    }
  }
  return undefined;
}

export function extractChildEvent(line: string): Gate6hEvent | undefined {
  const row = parseRow(line);
  if (!row) return undefined;
  const payload = isRecord(row.payload) ? row.payload : undefined;
  if (row.type !== "response_item" || payload?.type !== "agent_message") return undefined;
  const text = textOf(payload);
  return { kind: "child_agent_message", messageType: messageTypeOf(text), text };
}

export function buildGate6hPrompt(cwd: string): string {
  const f = GATE6H_FIXTURE;
  return `You are the Sol V2 root in isolated Gate 6-H. This is a deterministic sequencing canary. Do not edit files. Do not do the child work yourself.

HARD RULE: after spawn_agent returns, emit BOTH collaboration.send_message calls in the same assistant turn. Prefer parallel/tool-batch send_message calls in one response. If the API serializes them, the immediate next tool after the first send_message output MUST be the second send_message. Do not call wait_agent, list_agents, interrupt_agent, followup_task, exec, or write a final answer until BOTH send_message calls have been issued.

1. Call collaboration.spawn_agent exactly once. model=${GATE6H_CHILD_MODEL}, reasoning_effort=high, fork_turns=none, task_name=${GATE6H_TASK_NAME}. Child task message must be exactly:

FIRST_NONCE: ${f.spawnNonce}
FIRST_UNICODE: ${f.spawnUnicode}
Run /bin/sleep ${GATE6H_SLEEP_SECONDS} exactly once. If that command yields or returns and you have received fewer than two Message Type: MESSAGE payloads, run /bin/sleep 8 again until you have two MESSAGE payloads. After the second MESSAGE, run /bin/pwd once with workdir ${cwd}, then FINAL_ANSWER with FIRST_NONCE, both SEND nonces, both SEND Unicode lines, and the exact pwd path. Do not spawn. Do not apply_patch. Do not FINAL_ANSWER after only one MESSAGE.

2. In the same assistant turn, call collaboration.send_message twice on the returned child id with these exact payloads:

SEND1_NONCE: ${f.send1Nonce}
SEND1_UNICODE: ${f.send1Unicode}

SEND2_NONCE: ${f.send2Nonce}
SEND2_UNICODE: ${f.send2Unicode}

3. Only after both send_message calls have been issued, call collaboration.wait_agent until that same child is completed.

4. After it is completed, call collaboration.followup_task exactly once on the same child id with:
FOLLOW1_NONCE: ${f.follow1Nonce}
FOLLOW1_UNICODE: ${f.follow1Unicode}
Run /bin/pwd exactly once with workdir ${cwd}. Report FOLLOW1_NONCE, FOLLOW1_UNICODE, and the exact pwd path, then complete.

5. Call collaboration.wait_agent until that follow-up completes.

6. After it is completed again, call collaboration.followup_task exactly once more on the same child id with:
FOLLOW2_NONCE: ${f.follow2Nonce}
FOLLOW2_UNICODE: ${f.follow2Unicode}
Run /bin/pwd exactly once with workdir ${cwd}. Report FOLLOW2_NONCE, FOLLOW2_UNICODE, and the exact pwd path, then complete.

7. Call collaboration.wait_agent until the second follow-up completes.

Never a second spawn. Never a third send or third follow-up.
`;
}

type JsonObject = Record<string, unknown>;

function parseRow(line: string): { type?: string; payload?: unknown } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseArgObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function turnIdOf(payload: JsonObject): string | undefined {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (isRecord(meta) && typeof meta.turn_id === "string") return meta.turn_id;
  return undefined;
}

function targetOf(args: JsonObject): string {
  for (const key of ["target", "agent_id", "task_name", "recipient"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function messageOf(args: JsonObject): string {
  const value = args.message ?? args.payload ?? args.task;
  return typeof value === "string" ? value : "";
}

function textOf(payload: JsonObject): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("");
}

function messageTypeOf(text: string): "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER" | "OTHER" {
  if (/Message Type:\s*NEW_TASK/.test(text)) return "NEW_TASK";
  if (/Message Type:\s*MESSAGE/.test(text)) return "MESSAGE";
  if (/Message Type:\s*FINAL_ANSWER/.test(text)) return "FINAL_ANSWER";
  return "OTHER";
}

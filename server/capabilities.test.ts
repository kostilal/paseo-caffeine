import { test } from "node:test";
import assert from "node:assert/strict";
import { getStatus, setMode, setOptions, sleepNow } from "../shared/caffeine.shared.ts";
import { capabilities, describeCaffeine, describeRpc, OPERATIONS } from "./capabilities.server.ts";

// What a caller would send for each operation; the ones left out take no arguments.
const EXAMPLES: Record<string, Record<string, unknown>> = {
  keep_awake_for: { minutes: 120 },
  keep_display: { keepDisplay: true },
  lid_closed: { lidClosed: true },
};

test("the description matches its own contract and travels as plain JSON", () => {
  const described = describeCaffeine();
  assert.deepEqual(capabilities.parse(described), described);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  assert.equal(describeRpc.name, "meta.describe");
});

test("every operation points at an RPC this plugin registers", () => {
  const registered = new Set([getStatus, setMode, setOptions, sleepNow].map((c) => c.name));
  for (const op of describeCaffeine().operations) assert.ok(registered.has(op.method), `${op.id} → ${op.method}`);
});

test("what an operation advertises, merged under its fixed arguments, is what the handler accepts", () => {
  for (const op of OPERATIONS) {
    const args = EXAMPLES[op.id] ?? {};
    assert.doesNotThrow(() => op.input.parse(args), `${op.id} accepts its example`);
    assert.doesNotThrow(() => op.contract.input.parse({ ...args, ...op.fixed }), `${op.id} reaches ${op.contract.name}`);
  }
});

test("fixed arguments are not offered to the caller", () => {
  for (const op of describeCaffeine().operations) {
    const offered = Object.keys((op.input.properties as Record<string, unknown> | undefined) ?? {});
    for (const key of Object.keys(op.fixed ?? {})) assert.ok(!offered.includes(key), `${op.id} hides ${key}`);
  }
});

test("the timer advertises exactly the lengths the contract takes", () => {
  const timer = describeCaffeine().operations.find((op) => op.id === "keep_awake_for");
  const minutes = (timer?.input.properties as Record<string, { anyOf: Array<{ const: number }> }>).minutes;
  assert.deepEqual(minutes.anyOf.map((option) => option.const), [30, 60, 120, 180, 480, 720]);
  assert.deepEqual((timer?.input as { required: string[] }).required, ["minutes"]);
  assert.throws(() => setMode.input.parse({ ...timer?.fixed, minutes: 90 }));
});

test("ids are unique, one read is the default, and only low-risk actions skip confirmation", () => {
  const ops = describeCaffeine().operations;
  assert.equal(new Set(ops.map((op) => op.id)).size, ops.length);
  assert.deepEqual(ops.filter((op) => op.default).map((op) => op.id), ["status"]);
  for (const op of ops) {
    if (op.kind === "read") {
      assert.equal(op.risk, undefined, `${op.id} is a read`);
      continue;
    }
    assert.ok(op.risk, `${op.id} has a risk`);
    assert.equal(op.confirm, op.risk === "low" ? "none" : "always", op.id);
    if (op.confirm === "always") assert.ok(op.confirmText, `${op.id} says what will happen`);
  }
});

test("letting the Mac sleep and sleeping now are confirmed first", () => {
  const byId = Object.fromEntries(describeCaffeine().operations.map((op) => [op.id, op]));
  assert.equal(byId.allow_sleep.confirm, "always");
  assert.equal(byId.sleep_now.confirm, "always");
  assert.equal(byId.keep_awake.confirm, "none");
});

test("every answer is trimmed to the status a person asks about, without the wake link or the clock", () => {
  for (const op of describeCaffeine().operations) {
    assert.ok(op.output?.fields.includes("mode"), `${op.id} keeps the mode`);
    assert.ok(!op.output?.fields.includes("wakeUrl"), `${op.id} leaves out the wake link`);
    assert.ok(!op.output?.fields.includes("tickAt"), `${op.id} leaves out the clock`);
  }
});

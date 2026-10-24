import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginRpcContract } from "@getpaseo/plugin";
import * as shared from "../shared/caffeine.shared.ts";
import { runWarmup, setMode, status } from "../shared/caffeine.shared.ts";
import { EVERYTHING, HIDDEN_FIELDS, NOT_FOR_ASSISTANTS, OPERATIONS, capabilities, describeCaffeine, describeRpc } from "./capabilities.server.ts";

/**
 * What ChatGPT can see and do through God Mode is this description, so these tests hold it to
 * the plugin itself: every RPC a client can call and every status field is either described or
 * kept back with a reason, and what is described matches the contracts, the answers and the
 * limits God Mode cuts at. A new RPC or field fails here until somebody decides which it is
 * (README, "Definition of Done").
 */

// What a caller would send for each operation; the ones left out take no arguments.
const EXAMPLES: Record<string, Record<string, unknown>> = {
  keep_awake_for: { minutes: 120 },
  keep_display: { keepDisplay: true },
  warmup_on: { time: "07:30" },
  warmup_hour: { time: "05:30" },
};

/** The verdict on one change: plain sentences, and `refused` is read by God Mode itself. */
const VERDICT = ["refused", "problem"];

/** The fields of an object schema, through the default, nullable and prefault around it. */
function shapeOf(schema: unknown): Record<string, unknown> | null {
  let current = schema as { shape?: Record<string, unknown>; _zod?: { def?: { innerType?: unknown } } } | undefined;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.shape) return current.shape;
    current = current._zod?.def?.innerType as typeof current;
  }
  return null;
}

const isContract = (value: unknown): value is PluginRpcContract =>
  typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string" && "input" in value && "output" in value;

const isSettings = (value: unknown): value is { id: string } =>
  typeof value === "object" && value !== null && "schema" in value && "scope" in value && typeof (value as { id?: unknown }).id === "string";

/** Every RPC a paired client can call, read from what index.server.ts registers. */
function publicRpcs(): string[] {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.server.ts"), "utf8");
  const known: Record<string, unknown> = { ...shared, describeRpc };
  const names: string[] = [];
  for (const [, id] of source.matchAll(/server\.handle\((\w+)/g)) {
    const contract = known[id ?? ""];
    assert.ok(isContract(contract), `index.server.ts handles ${id}, which is not a contract of shared/ or the description`);
    names.push(contract.name);
  }
  for (const [, id] of source.matchAll(/server\.registerSettings\((\w+)/g)) {
    const settings = known[id ?? ""];
    assert.ok(isSettings(settings), `index.server.ts registers settings ${id}, which shared/ does not define`);
    // The host answers these for the plugin (Paseo's plugin-process `registerSettings`).
    for (const verb of ["read", "write", "reset"]) names.push(`settings.${settings.id}.${verb}`);
  }
  return names;
}

test("the description matches its own contract and travels as plain JSON", () => {
  const described = describeCaffeine();
  // The daemon parses the answer with this schema, so a key it does not name would be dropped.
  assert.deepEqual(capabilities.parse(described), described);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  assert.equal(describeRpc.name, "meta.describe");
});

test("every RPC a client can call is described for ChatGPT or kept back with a reason, never both", () => {
  const rpcs = publicRpcs();
  const described = new Set(describeCaffeine().operations.map((op) => op.method));
  for (const name of rpcs) {
    assert.ok(described.has(name) !== (name in NOT_FOR_ASSISTANTS), `${name}: describe it in OPERATIONS or say why not in NOT_FOR_ASSISTANTS`);
  }
  for (const name of [...described, ...Object.keys(NOT_FOR_ASSISTANTS)]) assert.ok(rpcs.includes(name), `${name} is an RPC index.server.ts registers`);
  for (const [name, reason] of Object.entries(NOT_FOR_ASSISTANTS)) assert.ok(reason.length >= 20, `${name} says why it is kept back`);
});

test("the admin setup and the heat guard's settings are never offered", () => {
  for (const op of describeCaffeine().operations) {
    assert.notEqual(op.method, "caffeine.lid-setup", op.id);
    assert.ok(!op.method.startsWith("settings."), `${op.id} must not reach the host's settings`);
  }
});

test("every RPC contract in shared/ is registered", () => {
  const rpcs = publicRpcs();
  for (const value of Object.values(shared)) if (isContract(value)) assert.ok(rpcs.includes(value.name), `${value.name} is handled in index.server.ts`);
});

test("every status field reaches ChatGPT, or is hidden with a reason", () => {
  const fields = Object.keys(status.shape);
  assert.deepEqual([...EVERYTHING].sort(), fields.filter((field) => !(field in HIDDEN_FIELDS)).sort(), "EVERYTHING lists every field that is not hidden");
  for (const [field, reason] of Object.entries(HIDDEN_FIELDS)) {
    assert.ok(fields.includes(field), `${field} is a status field`);
    assert.ok(reason.length >= 20, `${field} says why it is hidden`);
  }
  const everything = OPERATIONS.find((op) => op.id === "everything");
  assert.deepEqual(everything?.fields, EVERYTHING);
});

test("every field an operation reads out is in its answer", () => {
  for (const op of OPERATIONS) {
    const shape = shapeOf(op.contract.output);
    assert.ok(shape, `${op.id} answers with an object`);
    assert.ok(op.fields.length > 0, `${op.id} names the fields worth reading out`);
    for (const field of op.fields) assert.ok(field in shape, `${op.id}: ${op.contract.name} answers with no ${field}`);
  }
});

test("every action answers with its verdict, and a refusal reads as not done", () => {
  for (const op of describeCaffeine().operations) {
    if (op.kind === "read") {
      assert.equal(op.outcome, undefined, `${op.id} is a read`);
      continue;
    }
    assert.deepEqual(op.outcome, { error: "refused" }, op.id);
    for (const field of VERDICT) assert.ok(op.output?.fields.includes(field), `${op.id} reads out ${field}`);
  }
});

test("what each field means is said by an operation that returns it", () => {
  for (const field of new Set(OPERATIONS.flatMap((op) => op.fields))) {
    if (VERDICT.includes(field)) continue;
    const returning = OPERATIONS.filter((op) => op.fields.includes(field));
    // A block (lid, battery, heat, warm-up) is explained key by key, a plain field by name.
    const block = shapeOf(status.shape[field as keyof typeof status.shape]);
    for (const word of block ? Object.keys(block) : [field]) {
      const said = returning.some((op) => new RegExp(`\\b${word}\\b`).test(op.description));
      assert.ok(said, `${block ? `${field}.` : ""}${word}: say what it means in ${returning.map((op) => op.id).join(" or ")}`);
    }
  }
});

test("the description fits what God Mode keeps", () => {
  const described = describeCaffeine();
  assert.ok(described.summary.length <= 300, "summary");
  assert.ok(described.aliases.length <= 20 && described.aliases.every((alias) => alias.length <= 60), "aliases");
  assert.ok(described.operations.length <= 40, "operations");
  for (const op of described.operations) {
    assert.match(op.id, /^[a-z][a-z0-9_]*$/);
    assert.ok(op.id.length <= 64, op.id);
    assert.match(op.method, /^[a-z][a-z0-9._-]*$/);
    assert.ok(!op.method.startsWith("meta."), op.id);
    assert.ok(op.title.length <= 80, `${op.id}: title ${op.title.length}`);
    assert.ok(op.description.length <= 600, `${op.id}: description ${op.description.length}`);
    assert.ok((op.confirmText ?? "").length <= 600, `${op.id}: confirmText`);
  }
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

test("the warm-up hour is offered in the form the handler checks", () => {
  const on = describeCaffeine().operations.find((op) => op.id === "warmup_on");
  const time = (on?.input.properties as Record<string, { pattern?: string; description?: string }>).time;
  assert.ok(time.pattern && time.description, "the hour carries its pattern and says what it is");
  assert.equal((on?.input as { required?: string[] }).required, undefined, "the hour may be left out");
  assert.throws(() => shared.setWarmup.input.parse({ ...on?.fixed, time: "7:30" }));
});

test("warming up now answers at once for ChatGPT, and the page still waits for the results", () => {
  const now = describeCaffeine().operations.find((op) => op.id === "warmup_now");
  assert.deepEqual(now?.fixed, { wait: false });
  assert.deepEqual(runWarmup.input.parse({}), { wait: true });
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

test("every change that can let the Mac sleep, or that reaches out, is confirmed first", () => {
  const ids = (risk: string) =>
    describeCaffeine()
      .operations.filter((op) => op.risk === risk)
      .map((op) => op.id)
      .sort();
  // A new action lands in none of these lists and fails here until its risk is decided.
  assert.deepEqual(ids("disruptive"), ["allow_sleep", "auto", "lid_off_now", "sleep_now", "stop_lid_closed"]);
  assert.deepEqual(ids("outward"), ["warmup_hour", "warmup_now", "warmup_on"]);
  assert.deepEqual(ids("low"), ["allow_lid_closed", "dismiss_heat_alert", "keep_awake", "keep_awake_for", "keep_display", "lid_back_on", "warmup_off"]);
  assert.deepEqual(ids("destructive"), []);
});

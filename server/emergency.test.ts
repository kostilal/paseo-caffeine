import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTEMPTS, type EmergencyDeps, SLEPT_GAP_MS, emergencySleep, parseSystemSleepHolders, toEvent } from "./emergency.server.ts";
import type { LatchRecord } from "./thermal.ts";

const T0 = Date.parse("2026-10-24T02:14:00Z");
const TRIP = { reason: "pressure" as const, detail: "Heavy 60 s" };

/** A Mac in miniature for the sequence: every call is recorded, nothing is real. */
function fakeMac(options: { dryRun?: boolean; locked?: boolean; allows?: boolean[]; gaps?: number[]; holders?: string[] } = {}) {
  const calls: string[] = [];
  const latches: LatchRecord[] = [];
  const allows = [...(options.allows ?? [true])];
  const gaps = [...(options.gaps ?? [30 * 60_000])];
  let holding = true;
  const deps: EmergencyDeps = {
    dryRun: () => options.dryRun ?? false,
    lock: async () => (calls.push("lock"), !(options.locked ?? false)),
    unlock: async () => void calls.push("unlock"),
    writeLatch: async (record) => void (calls.push(`latch slept=${record.slept}`), latches.push({ ...record })),
    allowSleep: async () => (calls.push("disablesleep 0"), allows.length > 1 ? (allows.shift() as boolean) : (allows[0] ?? true)),
    releaseHold: () => void (calls.push("release own caffeinate"), (holding = false)),
    holders: async () => (calls.push("assertions"), options.holders ?? []),
    sleepNow: async () => void calls.push(holding ? "sleepnow (still holding!)" : "sleepnow"),
    waitGap: async () => (calls.push("wait"), gaps.length > 1 ? (gaps.shift() as number) : (gaps[0] ?? 0)),
    now: () => T0,
    log: () => undefined,
  };
  return { deps, calls, latches };
}

test("the order: latch first, sleep allowed back, own caffeinate gone, then sleepnow, then a look", async () => {
  const mac = fakeMac();
  const record = await emergencySleep(TRIP, mac.deps);
  assert.deepEqual(mac.calls, ["lock", "latch slept=null", "disablesleep 0", "release own caffeinate", "assertions", "sleepnow", "wait", "latch slept=true", "unlock"]);
  assert.equal(record?.slept, true);
  assert.equal(record?.at, T0 / 1000);
  assert.ok(!mac.calls.includes("sleepnow (still holding!)"), "never sleepnow under our own hold");
});

test("a dry run writes what it would have done and touches nothing else", async () => {
  const mac = fakeMac({ dryRun: true });
  const record = await emergencySleep(TRIP, mac.deps);
  assert.deepEqual(mac.calls, ["latch slept=null"]);
  assert.equal(record?.dryRun, true);
  assert.equal(mac.latches[0]?.dryRun, true);
});

test("when the LaunchAgent guard already holds the lock, the plugin stands back", async () => {
  const mac = fakeMac({ locked: true });
  assert.equal(await emergencySleep(TRIP, mac.deps), null);
  assert.deepEqual(mac.calls, ["lock"]);
});

test("a sleep that does not take is tried three times, then recorded with whoever held it", async () => {
  const mac = fakeMac({ gaps: [0], holders: ["Amphetamine"] });
  const record = await emergencySleep(TRIP, mac.deps);
  assert.equal(mac.calls.filter((call) => call === "sleepnow").length, ATTEMPTS);
  assert.equal(mac.calls.filter((call) => call === "disablesleep 0").length, ATTEMPTS, "sleep allowed again before every try");
  assert.equal(record?.slept, false);
  assert.deepEqual(record?.holders, ["Amphetamine"]);
  assert.equal(mac.calls.at(-1), "unlock", "the lock is always given back");
});

test("a second try that takes is a sleep", async () => {
  const mac = fakeMac({ gaps: [2_000, SLEPT_GAP_MS] });
  const record = await emergencySleep(TRIP, mac.deps);
  assert.equal(record?.slept, true);
  assert.equal(mac.calls.filter((call) => call === "sleepnow").length, 2);
  assert.deepEqual(record?.holders, []);
});

test("sleep that cannot be switched back on is still followed by the rest, and retried", async () => {
  const mac = fakeMac({ allows: [false, false, true], gaps: [0, 0, 60_000] });
  const record = await emergencySleep(TRIP, mac.deps);
  assert.equal(record?.slept, true);
  assert.equal(mac.calls.filter((call) => call === "disablesleep 0").length, 3);
});

test("a failure in the middle still gives the lock back, and the latch is already written", async () => {
  const mac = fakeMac();
  mac.deps.sleepNow = async () => {
    throw new Error("pmset went away");
  };
  await assert.rejects(emergencySleep(TRIP, mac.deps));
  assert.equal(mac.calls[1], "latch slept=null");
  assert.equal(mac.calls.at(-1), "unlock");
});

test("holders come from pmset -g assertions, PreventSystemSleep only, without our own caffeinate", () => {
  const output = [
    "Listed by owning process:",
    '   pid 96919(caffeinate): [0x0015a1fc00018595] 01:40:56 PreventUserIdleSystemSleep named: "caffeinate command-line tool"',
    '   pid 96919(caffeinate): [0x0015a1fc00078596] 01:40:56 PreventSystemSleep named: "caffeinate command-line tool"',
    '   pid 73988(coreaudiod): [0x00155704000199a3] 07:00:48 PreventUserIdleSystemSleep named: "com.apple.audio.context"',
    '   pid 512(Amphetamine): [0x0015a1fc00078597] 00:10:00 PreventSystemSleep named: "Amphetamine session"',
  ].join("\n");
  assert.deepEqual(parseSystemSleepHolders(output, [96919]), ["Amphetamine"]);
  assert.deepEqual(parseSystemSleepHolders(output), ["caffeinate", "Amphetamine"]);
});

test("the latch becomes the event the page shows", () => {
  const event = toEvent({ at: T0 / 1000, reason: "battery", detail: "45.3 °C", dryRun: false, slept: true, holders: [], by: "guard", dismissed: false });
  assert.equal(event.at, "2026-10-24T02:14:00.000Z");
  assert.equal(event.reason, "battery");
  assert.equal(event.by, "guard");
});
